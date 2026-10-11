/**
 * 宿主服务装配（宿主核心门面；零 Electron import——S1 规划 D-S1-1，S2 扩展）
 *
 * S2 编排面：常驻句柄注册表（本进程新建会话可续写）+ 推送出口（service 层 emit
 * 永不 throw——推送失败不破坏落链）+ 授权等待注册表（requestId 全局唯一，内嵌
 * sessionId）+ 会话索引面（标题/删除态权威源）。
 * dispatch 通道校验 = 契约白名单 + 载荷形状逐通道 fail-visible。
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import {
  IpcChannel,
  IpcPushTopic,
  type AuthzDecisionInput,
  type HostProbeResult,
  type SessionInfo,
  type SessionOpenResult,
  type SessionUsageResult,
  type WorkspaceInfo,
} from '../shared/ipc-contract.ts'
import { probeSeam } from './probe.ts'
import { WorkspaceRegistry } from './workspaces.ts'
import { SessionHandle, usageOver, type AuthzResponse } from './session-handle.ts'
import {
  listSessions,
  parseSessionEvents,
  readSessionIndex,
  sessionInfo,
  sessionsDirFor,
  writeSessionIndex,
} from './sessions.ts'
import { createChatModelFn, loadHostRuntime, type HostRuntime } from './model.ts'
import { builtinTools } from './tools.ts'
import { createFileSecurityEngine, type FileSecurityEngine } from './fileSecurity.ts'
import { createFileSecurityStore } from './fileSecurityStore.ts'
import type { HostModelFn } from './types.ts'

export interface HostServiceOptions {
  /** 桌面 = app.getPath('userData')；测试 = 注入临时目录（D-S1-4） */
  userDataDir: string
  /** 默认 120_000（内核 AuthzService 同值）；测试注入短超时 */
  authzTimeoutMs?: number
  /**
   * 测试注入：覆盖 chatStep 生产路径的模型回调工厂（内核 runTurn 仍真跑——行为证明）。
   * 工厂接收句柄：假模型须复刻 chatStep 的落链行为（assistant 文本非空即 append——
   * chatStep.ts:129 口径），否则事件流与生产路径不等价。
   */
  modelFnOverride?: (h: SessionHandle) => HostModelFn
}

export type PushMessage = { topic: string; payload: unknown }

export interface HostService {
  dispatch(channel: string, payload: unknown): Promise<unknown>
  /** 推送出口注册（host-entry 转 utilityProcess parentPort → main 转渲染层） */
  onPush(handler: (m: PushMessage) => void): void
}

export function createHostService(opts: HostServiceOptions): HostService {
  const registry = new WorkspaceRegistry(opts.userDataDir)
  const authzTimeoutMs = opts.authzTimeoutMs ?? 120_000
  // 文件安全（S3-S2）：应用级单例——store（userData/file-security.json 持久化）+ 引擎（规则面判定）
  const fileSecurityStore = createFileSecurityStore(opts.userDataDir)
  const fileSecurity: FileSecurityEngine = createFileSecurityEngine(fileSecurityStore)
  const handles = new Map<string, SessionHandle>()
  const authzWaiters = new Map<string, (d: AuthzResponse) => void>()
  const pushHandlers = new Set<(m: PushMessage) => void>()

  const key = (workspaceId: string, sessionId: string): string => workspaceId + '::' + sessionId

  function emit(topic: string, payload: unknown): void {
    for (const h of pushHandlers) {
      try {
        h({ topic, payload })
      } catch (err) {
        // 推送失败禁破坏落链（sink 内 emit——console 留痕后继续）
        console.error(`[host] push 失败（${topic}）：`, err instanceof Error ? err.message : err)
      }
    }
  }

  function requireString(v: unknown, label: string): string {
    if (typeof v !== 'string' || v.length === 0) {
      throw new Error(`CAR-E-DESKTOP: 载荷缺少 ${label}（string）`)
    }
    return v
  }

  function requireAliveHandle(workspaceId: string, sessionId: string): SessionHandle {
    const h = handles.get(key(workspaceId, sessionId))
    if (!h) {
      throw new Error(
        `CAR-E-DESKTOP: 会话不可续写（${sessionId}）——仅本进程新建的会话可运行 turn（先前运行的会话为只读回放，D-S2-6）`,
      )
    }
    return h
  }

  function depsFor(workspaceId: string, workspaceRoot: string): Parameters<typeof SessionHandle.createFresh>[0]['deps'] {
    return {
      workspaceId,
      authzTimeoutMs,
      sessionsDir: sessionsDirFor(workspaceRoot),
      emitEvent: (sessionId, event) => emit(IpcPushTopic.SessionEvent, { workspaceId, sessionId, event }),
      emitAuthzPending: (p) => emit(IpcPushTopic.AuthzPending, p),
      emitAuthzResolved: (p) => emit(IpcPushTopic.AuthzResolved, p),
      waitAuthzDecision: (_sessionId: string, requestId: string) =>
        new Promise<AuthzResponse>((resolve) => {
          authzWaiters.set(requestId, resolve)
        }),
      fileSecurity,
    }
  }

  function cancelSessionAuthz(sessionId: string): void {
    for (const [requestId, resolve] of [...authzWaiters]) {
      if (!requestId.startsWith(sessionId + ':')) continue
      authzWaiters.delete(requestId)
      const h = [...handles.values()].find((x) => x.sessionId === sessionId)
      const workspaceId = h?.workspaceId
      resolve('cancelled')
      emit(IpcPushTopic.AuthzResolved, {
        kind: 'resolved', sessionId, requestId, outcome: 'cancelled', decidedBy: 'host',
        ...(workspaceId ? { workspaceId } : {}),
      })
    }
  }

  async function dispatch(channel: string, payload: unknown): Promise<unknown> {
    const p = (payload ?? {}) as Record<string, unknown>
    switch (channel) {
      case IpcChannel.HostProbe: {
        const probe = probeSeam()
        return probe satisfies HostProbeResult
      }
      case IpcChannel.WorkspaceRegister: {
        const info = await registry.register(requireString(p.path, 'path'))
        return info satisfies WorkspaceInfo
      }
      case IpcChannel.WorkspaceList:
        return registry.list()
      case IpcChannel.SessionCreate: {
        const workspaceId = requireString(p.workspaceId, 'workspaceId')
        const root = registry.pathOf(workspaceId)
        const sessionId = 'S-' + Date.now().toString(36) + '-' + randomBytes(2).toString('hex')
        mkdirSync(sessionsDirFor(root), { recursive: true })
        // 模型装配先于句柄（configModel 锚点）；装配失败不阻塞建会话，
        // 但原因必须回到渲染层（modelError——S2 修补：禁吞 console）
        let runtime: HostRuntime | null = null
        let modelError: string | null = null
        try {
          runtime = await loadHostRuntime(root)
        } catch (err) {
          modelError = err instanceof Error ? err.message : String(err)
          console.error('[host] 模型未装配（会话已创建，turn 发送将被拒绝）：', modelError)
        }
        const handle = SessionHandle.createFresh({
          sessionId,
          workspaceId,
          workspaceRoot: root,
          configModel: runtime?.llm.model ?? null,
          modelError,
          deps: depsFor(workspaceId, root),
        })
        if (opts.modelFnOverride) handle.attachModelFn(opts.modelFnOverride(handle))
        else if (runtime) {
          handle.attachModelFn(
            createChatModelFn({
              runtime,
              log: handle.log,
              signal: handle.abort,
              currentTurnId: () => handle.currentTurnId(),
              currentModel: () => handle.sessionModel ?? '',
              toolDefs: builtinTools(root, fileSecurity),
            }),
          )
        }
        handles.set(key(workspaceId, sessionId), handle)
        const idx = readSessionIndex(root)
        idx.sessions[sessionId] = idx.sessions[sessionId] ?? {}
        writeSessionIndex(root, idx)
        const info = sessionInfo(root, workspaceId, sessionId)
        return { ...info, modelError } satisfies SessionInfo
      }
      case IpcChannel.SessionList: {
        const workspaceId = requireString(p.workspaceId, 'workspaceId')
        return listSessions(registry.pathOf(workspaceId), workspaceId)
      }
      case IpcChannel.SessionOpen: {
        const workspaceId = requireString(p.workspaceId, 'workspaceId')
        const sessionId = requireString(p.sessionId, 'sessionId')
        const root = registry.pathOf(workspaceId)
        const alive = handles.get(key(workspaceId, sessionId))
        if (alive) {
          return {
            sessionId,
            workspaceId,
            exists: true,
            eventCount: alive.log.events.length,
            title: alive.title,
            model: alive.sessionModel,
            modelError: alive.modelError,
            events: [...alive.knownEvents()],
          } satisfies SessionOpenResult
        }
        // 只读回放（先前运行的会话——D-S2-6）：文件必须存在，无句柄无追加
        const events = parseSessionEvents(root, sessionId)
        const idx = readSessionIndex(root)
        let model: string | null = null
        for (const e of events) {
          if (e.kind === 'system' && (e.payload as Record<string, unknown> | null)?.['type'] === 'model/set') {
            const m = (e.payload as Record<string, unknown>)['model']
            if (typeof m === 'string') model = m
          }
        }
        return {
          sessionId,
          workspaceId,
          exists: true,
          eventCount: events.length,
          title: idx.sessions[sessionId]?.title ?? '未命名会话',
          model,
          events,
        } satisfies SessionOpenResult
      }
      case IpcChannel.TurnSend: {
        const handle = requireAliveHandle(requireString(p.workspaceId, 'workspaceId'), requireString(p.sessionId, 'sessionId'))
        return handle.sendTurn(requireString(p.text, 'text'))
      }
      case IpcChannel.TurnAbort: {
        const handle = requireAliveHandle(requireString(p.workspaceId, 'workspaceId'), requireString(p.sessionId, 'sessionId'))
        handle.abortTurn()
        return { ok: true }
      }
      case IpcChannel.AuthzRespond: {
        const requestId = requireString(p.requestId, 'requestId')
        const decision = requireString(p.decision, 'decision')
        if (decision !== 'once' && decision !== 'session' && decision !== 'deny') {
          throw new Error(`CAR-E-DESKTOP: 非法授权决策（${decision}）——仅 once/session/deny`)
        }
        const w = authzWaiters.get(requestId)
        if (!w) throw new Error(`CAR-E-DESKTOP: 授权请求不存在或已决（${requestId}）`)
        authzWaiters.delete(requestId)
        w(decision as AuthzDecisionInput)
        return { outcome: decision }
      }
      case IpcChannel.SessionUsage: {
        const workspaceId = requireString(p.workspaceId, 'workspaceId')
        const sessionId = requireString(p.sessionId, 'sessionId')
        const alive = handles.get(key(workspaceId, sessionId))
        const usage: SessionUsageResult = alive
          ? alive.usage()
          : usageOver(parseSessionEvents(registry.pathOf(workspaceId), sessionId))
        return usage
      }
      case IpcChannel.SessionRename: {
        const workspaceId = requireString(p.workspaceId, 'workspaceId')
        const sessionId = requireString(p.sessionId, 'sessionId')
        const title = requireString(p.title, 'title')
        const root = registry.pathOf(workspaceId)
        const alive = handles.get(key(workspaceId, sessionId))
        if (alive) {
          alive.title = title
          alive.appendNarrative('session/rename', { title }) // 链上留痕（resumable）；索引面为权威
        }
        const idx = readSessionIndex(root)
        idx.sessions[sessionId] = { ...idx.sessions[sessionId], title }
        writeSessionIndex(root, idx)
        return sessionInfo(root, workspaceId, sessionId)
      }
      case IpcChannel.SessionDelete: {
        const workspaceId = requireString(p.workspaceId, 'workspaceId')
        const sessionId = requireString(p.sessionId, 'sessionId')
        const root = registry.pathOf(workspaceId)
        const alive = handles.get(key(workspaceId, sessionId))
        if (alive) {
          if (alive.busy) throw new Error('CAR-E-DESKTOP: turn 进行中——先停止再删除会话')
          alive.appendNarrative('session/delete') // 链上留痕（resumable）
          cancelSessionAuthz(sessionId)
          alive.close()
          handles.delete(key(workspaceId, sessionId))
        }
        // 索引面标 deleted（列表过滤）；JSONL 文件保留不销毁（审计红线：日志不可变）
        const idx = readSessionIndex(root)
        idx.sessions[sessionId] = { ...idx.sessions[sessionId], deleted: true }
        writeSessionIndex(root, idx)
        return { ok: true }
      }
      case IpcChannel.SessionSetModel: {
        const handle = requireAliveHandle(requireString(p.workspaceId, 'workspaceId'), requireString(p.sessionId, 'sessionId'))
        const model = requireString(p.model, 'model')
        handle.sessionModel = model
        handle.appendNarrative('model/set', { model }) // D-S2-3：既有 system kind + payload.type，内核 EventKind 冻结面不新增
        return { ok: true, model }
      }
      case IpcChannel.FileSecurityGet:
        return fileSecurityStore.get()
      case IpcChannel.FileSecuritySet: {
        const rules = (p as { rules?: unknown }).rules
        if (!Array.isArray(rules)) throw new Error('CAR-E-DESKTOP: fileSecurity.set 缺少 rules（数组）')
        return fileSecurityStore.set(rules)
      }
      case IpcChannel.FileSecurityReset:
        return fileSecurityStore.reset()
      case IpcChannel.WorkspacePick:
        // 系统目录选择器属 main 侧能力（host-core 零 Electron）——本通道在 main 内消化，不入宿主
        throw new Error('CAR-E-DESKTOP: workspace:pick 由 main 侧处理（契约通道误入宿主 dispatch）')
      default:
        throw new Error(`CAR-E-DESKTOP: 未知 IPC 通道（${channel}）——契约面见 src/shared/ipc-contract.ts`)
    }
  }

  return {
    dispatch,
    onPush(handler: (m: PushMessage) => void): void {
      pushHandlers.add(handler)
    },
  }
}
