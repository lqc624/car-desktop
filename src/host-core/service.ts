/**
 * 宿主服务装配（宿主核心门面；零 Electron import——S1 规划 D-S1-1，S2 扩展）
 *
 * S2 编排面：常驻句柄注册表（本进程新建会话可续写）+ 推送出口（service 层 emit
 * 永不 throw——推送失败不破坏落链）+ 授权等待注册表（requestId 全局唯一，内嵌
 * sessionId）+ 会话索引面（标题/删除态权威源）。
 * dispatch 通道校验 = 契约白名单 + 载荷形状逐通道 fail-visible。
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { loadSessionLog } from '@lqc123qwe/car-runtime'
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
  assertSafeId,
  listSessions,
  parseSessionEvents,
  readSessionIndex,
  sessionInfo,
  sessionsDirFor,
  writeSessionIndex,
} from './sessions.ts'
import { sessionAuditReport, exportSessionForensics } from './auditReport.ts'
import { nullPriceProvider, workspaceMeteringSummary, type PriceProvider } from './metering.ts'
import { pluginRegistryStore, loadPlugins, createMcpFace, mergeToolSources, type McpFace, type PluginState } from './toolSources.ts'
import { warmCarConfig, loadCarConfig, mergeLlmConfig, type LlmAdapter, type RoutingDecision } from '@lqc123qwe/car-runtime'
import { MODEL_META, resolveModelMeta } from './modelMeta.ts'
import { runDoctor } from './doctor.ts'
import { createChatModelFn, loadHostRuntime, type HostRuntime } from './model.ts'
import { builtinTools } from './tools.ts'
import { createFileSecurityEngine, type FileSecurityEngine } from './fileSecurity.ts'
import { createFileSecurityStore } from './fileSecurityStore.ts'
import { createSecuritySettingsStore, type SessionPolicy } from './securitySettingsStore.ts'
import { createBackupStore } from './backupStore.ts'
import type { HostModelFn, HostToolDef } from './types.ts'

export interface HostServiceOptions {
  /** 桌面 = app.getPath('userData')；测试 = 注入临时目录（D-S1-4） */
  userDataDir: string
  /** 默认 120_000（内核 AuthzService 同值）；测试注入短超时 */
  authzTimeoutMs?: number
  /**
   * 价目 Provider（S3-S5 / R-D5）：缺省 null Provider——金额「价目未同步」（禁 0 禁估算）；
   * 平台 t_model_price 同步可用后注入实现
   */
  priceProvider?: PriceProvider
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
  /** MCP stdio 子进程等生命周期收口（测试 finally / 宿主退出前调用） */
  dispose(): void
}

export function createHostService(opts: HostServiceOptions): HostService {
  const registry = new WorkspaceRegistry(opts.userDataDir)
  const authzTimeoutMs = opts.authzTimeoutMs ?? 120_000
  // 文件安全（S3-S2）：应用级单例——store（userData/file-security.json 持久化）+ 引擎（规则面判定）
  const fileSecurityStore = createFileSecurityStore(opts.userDataDir)
  const fileSecurity: FileSecurityEngine = createFileSecurityEngine(fileSecurityStore)
  // 安全中心设置 + 自动备份（S3-S3）：默认策略 / 备份开关与配额（backup 配置闭包即时读设置）
  const securitySettings = createSecuritySettingsStore(opts.userDataDir)
  const backup = createBackupStore(opts.userDataDir, () => securitySettings.get().autoBackup)
  // 价目 Provider（S3-S5 / R-D5 两模式）：本地模式 = null Provider（金额「价目未同步」禁 0）；
  // 平台价目同步可用后由装配方注入实现（接口面预留）
  const priceProvider: PriceProvider = opts.priceProvider ?? nullPriceProvider()
  // —— S4-S1：插件/MCP 工具源装载面 ——
  const pluginRegistry = pluginRegistryStore(opts.userDataDir)
  let lastPluginLoad: PluginState[] | null = null
  const mcpFaces = new Map<string, { fp: string; face: McpFace }>()
  /** 工作区 MCP 面懒建（config 指纹缓存——mcp.servers 变更才重建；register 逐 server 隔离） */
  async function ensureMcpFace(workspaceId: string, root: string): Promise<McpFace> {
    await warmCarConfig({ cwd: root })
    const loaded = loadCarConfig({ cwd: root })
    if (loaded.error) throw new Error(loaded.error)
    const servers = loaded.config.mcp?.servers ?? {}
    const fp = JSON.stringify(servers)
    const cached = mcpFaces.get(workspaceId)
    if (cached && cached.fp === fp) return cached.face
    cached?.face.close()
    const face = createMcpFace(servers)
    await face.registerAll()
    mcpFaces.set(workspaceId, { fp, face })
    return face
  }
  /** 工具源装载（S3-S2 builtin + S4 插件/MCP）——session:create / resume 共用 */
  async function loadExtraTools(workspaceId: string, root: string): Promise<{ extraTools: HostToolDef[]; mcpToolUrl: Map<string, string>; pluginStates: PluginState[] }> {
    const face = await ensureMcpFace(workspaceId, root)
    const pluginLoad = await loadPlugins(pluginRegistry.get())
    lastPluginLoad = pluginLoad.states
    const extraTools = [...pluginLoad.tools, ...face.tools()]
    const mcpToolUrl = new Map<string, string>()
    for (const t of extraTools) {
      const u = face.urlOf(t.name)
      if (u) mcpToolUrl.set(t.name, u)
    }
    return { extraTools, mcpToolUrl, pluginStates: pluginLoad.states }
  }
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

  function depsFor(workspaceId: string, workspaceRoot: string, contextWindow: number | null): Parameters<typeof SessionHandle.createFresh>[0]['deps'] {
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
      securitySettings: () => securitySettings.get(),
      backup,
      contextWindow,
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

  /** 模型回调装配（session:create 与跨运行续写共用——modelFnOverride 优先，生产走 createChatModelFn） */
  function attachRuntimeModel(handle: SessionHandle, runtime: HostRuntime | null, root: string, extraTools: HostToolDef[]): void {
    if (opts.modelFnOverride) {
      handle.attachModelFn(opts.modelFnOverride(handle))
      return
    }
    if (runtime) {
      handle.attachModelFn(
        createChatModelFn({
          runtime,
          log: handle.log,
          signal: handle.abort,
          currentTurnId: () => handle.currentTurnId(),
          currentModel: () => handle.sessionModel ?? '',
          toolDefs: mergeToolSources(builtinTools(root, fileSecurity), extraTools),
          // S5（D-S5-3）：会话级思考档位实时读（model/set 即时生效）
          currentReasoning: () => handle.sessionReasoning,
        }),
      )
    }
  }

  /** 装载模型（configModel 锚点）；装配失败不阻塞会话面，原因必须回到渲染层（S2 修补：禁吞 console） */
  // —— S4-S2：自定义端点（main safeStorage 解密后经 credentials:key-push 内存推送——不落盘不打印） ——
  let endpoint: { baseUrl: string; model: string; key: string; contextWindow: number | null } | null = null

  /** 装载模型（doctor/会话共用）：端点覆盖 > car.config（R-D6）；contextWindow = 元数据表/端点声明（D-C5 无值 null）。
   *  S5（D-S5-1）：routingSink holder 随装配返回——RuntimeCore 先建、句柄 log 后建回填（routing/decide 落链）。 */
  async function loadRuntimeFor(root: string): Promise<{
    runtime: Awaited<ReturnType<typeof loadHostRuntime>> | null
    modelError: string | null
    contextWindow: number | null
    routingSink: { current: ((d: RoutingDecision) => void) | null }
  }> {
    let runtime: Awaited<ReturnType<typeof loadHostRuntime>> | null = null
    let modelError: string | null = null
    const routingSink: { current: ((d: RoutingDecision) => void) | null } = { current: null }
    try {
      runtime = await loadHostRuntime(root, endpoint, {
        // onDecide → holder（句柄 log 回填后落链；未回填期决策丢弃——会话创建早于任何请求）
        routingSink: (d) => routingSink.current?.(d),
      })
    } catch (err) {
      modelError = err instanceof Error ? err.message : String(err)
      console.error('[host] 模型未装配（turn 发送将被拒绝）：', modelError)
    }
    const activeModel = endpoint?.model ?? runtime?.llm.model ?? null
    const meta = resolveModelMeta(activeModel)
    const contextWindow = meta?.contextWindow ?? endpoint?.contextWindow ?? null
    return { runtime, modelError, contextWindow, routingSink }
  }

  /** routing/decide 落链（S5 / D-S5-1）：句柄 log 回填——事件链只追加红线 */
  function wireRoutingSink(routingSink: { current: ((d: RoutingDecision) => void) | null }, handle: SessionHandle): void {
    routingSink.current = (d) => {
      handle.log.append('runtime', 'routing', d.turnId ?? 'T0', {
        type: 'decide',
        selected: d.selected,
        reason: d.reason,
        retries: d.retries,
        attempts: d.attempts,
      })
    }
  }

  async function dispatch(channel: string, payload: unknown): Promise<unknown> {
    const p = (payload ?? {}) as Record<string, unknown>
    switch (channel) {
      // —— S4-S2：端点 Key 内存推送（main safeStorage 解密后独占调用——渲染层/宿主均不持明文盘面） ——
      case 'credentials:key-push': {
        if (p['clear'] === true) {
          endpoint = null
          return { ok: true, active: false }
        }
        const baseUrl = requireString(p.baseUrl, 'baseUrl')
        const model = requireString(p.model, 'model')
        const key = requireString(p.key, 'key')
        endpoint = {
          baseUrl,
          model,
          key,
          contextWindow: typeof p.contextWindow === 'number' && p.contextWindow > 0 ? p.contextWindow : null,
        }
        return { ok: true, active: true }
      }
      // —— S4-S2：doctor 全项（值不打印——输出面只有布尔/键名/耗时/错误类别） ——
      case 'doctor:run': {
        const workspaceId = p['workspaceId'] ? requireString(p.workspaceId, 'workspaceId') : null
        let llm: { adapterId?: string; allowEnvFallback?: boolean; baseUrl?: string } = { allowEnvFallback: false, baseUrl: undefined }
        let configError: string | null = null
        let poolMembers: Array<{ id: string; baseUrl: string; model: string; adapterId: 'openai-compat' | 'anthropic' }> = []
        if (workspaceId) {
          try {
            const root = registry.pathOf(workspaceId)
            await warmCarConfig({ cwd: root })
            const loaded = loadCarConfig({ cwd: root })
            if (loaded.error) configError = loaded.error
            else {
              llm = mergeLlmConfig(process.env, loaded.config, {})
              // S5（D-S5-5）：池端点 → doctor 池健康行（probe 只需 baseUrl/adapterId——id 为展示定位）
              poolMembers = (loaded.config.modelPool?.endpoints ?? []).map((ep, i) => ({
                id: ep.id ?? `ep-${i + 1}`,
                baseUrl: ep.baseUrl,
                model: ep.model,
                adapterId: ep.adapterId ?? 'openai-compat',
              }))
            }
          } catch (err) {
            configError = err instanceof Error ? err.message : String(err)
          }
        }
        const rows = [
          ...(configError
            ? [{ label: '工作区配置', ok: false, detail: configError }]
            : []),
          ...(await runDoctor({
            llm,
            endpointKeyPresent: endpoint !== null,
            effectiveBaseUrl: endpoint?.baseUrl ?? llm.baseUrl ?? '',
            probeKey: endpoint?.key ?? process.env[llm.adapterId === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'] ?? null,
            poolMembers,
          }).then((r) => r.rows)),
        ]
        return { rows }
      }
      // —— S4-S2：模型元数据（内置静态表 + 端点声明——ctx 百分比真值来源；Key 永不出面） ——
      case 'models:meta':
        return { meta: MODEL_META, endpoint: endpoint ? { baseUrl: endpoint.baseUrl, model: endpoint.model, contextWindow: endpoint.contextWindow } : null }
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
        const { runtime, modelError, contextWindow, routingSink } = await loadRuntimeFor(root)
        // S4-S1：工具源装载（builtin + 插件 + MCP）——跨源同名显式报错（mergeToolSources）
        const { extraTools, mcpToolUrl } = await loadExtraTools(workspaceId, root)
        const handle = SessionHandle.createFresh({
          sessionId,
          workspaceId,
          workspaceRoot: root,
          configModel: runtime?.llm.model ?? null,
          modelError,
          deps: { ...depsFor(workspaceId, root, contextWindow), extraTools, mcpToolUrl, compactionCfg: runtime?.compaction },
        })
        // S5（D-S5-1）：routing/decide 落链出口回填（先于任何请求——未回填期无决策丢失面）
        wireRoutingSink(routingSink, handle)
        attachRuntimeModel(handle, runtime, root, extraTools)
        handles.set(key(workspaceId, sessionId), handle)
        const idx = readSessionIndex(root)
        idx.sessions[sessionId] = idx.sessions[sessionId] ?? {}
        writeSessionIndex(root, idx)
        const info = sessionInfo(root, workspaceId, sessionId)
        return { ...info, modelError, contextWindow } satisfies SessionInfo
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
            contextWindow: alive.sessionWindow ?? alive.contextWindow,
            events: [...alive.knownEvents()],
          } satisfies SessionOpenResult
        }
        // 只读回放（先前运行的会话——D-S2-6）：文件必须存在，无句柄无追加
        const events = parseSessionEvents(root, sessionId)
        const idx = readSessionIndex(root)
        let model: string | null = null
        let sessionWindow: number | null = null
        for (const e of events) {
          if (e.kind === 'system' && (e.payload as Record<string, unknown> | null)?.['type'] === 'model/set') {
            const m = (e.payload as Record<string, unknown>)['model']
            if (typeof m === 'string') model = m
            const cw = (e.payload as Record<string, unknown>)['contextWindow']
            if (typeof cw === 'number') sessionWindow = cw
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
        const workspaceId = requireString(p.workspaceId, 'workspaceId')
        const sessionId = requireString(p.sessionId, 'sessionId')
        const text = requireString(p.text, 'text')
        let handle = handles.get(key(workspaceId, sessionId))
        if (!handle) {
          // 跨运行续写（S3-S4，D-S2-6 退役）：载入面验链完整 → 重建可续写句柄（惰性，首次续写时）。
          // 断链 fail-visible 拒绝续写（先修审计面）；已删除会话拒绝（索引面权威）。
          const root = registry.pathOf(workspaceId)
          assertSafeId('会话', sessionId)
          const idx = readSessionIndex(root)
          if (idx.sessions[sessionId]?.deleted) {
            throw new Error(`CAR-E-DESKTOP: 会话已删除（${sessionId}）——拒绝续写`)
          }
          const file = join(sessionsDirFor(root), sessionId + '.jsonl')
          if (!existsSync(file)) throw new Error(`CAR-E-DESKTOP: 会话不存在（${sessionId}）`)
          const loaded = loadSessionLog(file)
          if (loaded.brokenAt !== null) {
            throw new Error(`CAR-E-DESKTOP: 会话哈希链断裂（brokenAt seq=${loaded.brokenAt}）——拒绝续写（先修审计面）`)
          }
          const { runtime, modelError, contextWindow, routingSink } = await loadRuntimeFor(root)
          const { extraTools, mcpToolUrl } = await loadExtraTools(workspaceId, root)
          handle = SessionHandle.resume(
            {
              sessionId,
              workspaceId,
              workspaceRoot: root,
              configModel: runtime?.llm.model ?? null,
              modelError,
              deps: { ...depsFor(workspaceId, root, contextWindow), extraTools, mcpToolUrl, compactionCfg: runtime?.compaction },
            },
            loaded.log,
          )
          wireRoutingSink(routingSink, handle)
          attachRuntimeModel(handle, runtime, root, extraTools)
          handle.title = idx.sessions[sessionId]?.title ?? '未命名会话'
          handles.set(key(workspaceId, sessionId), handle)
        }
        return handle.sendTurn(text)
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
        const cw = typeof p.contextWindow === 'number' && p.contextWindow > 0 ? p.contextWindow : null
        const re = typeof p.reasoningEffort === 'string' && ['off', 'low', 'medium', 'high'].includes(p.reasoningEffort)
          ? (p.reasoningEffort as 'off' | 'low' | 'medium' | 'high')
          : null
        handle.sessionModel = model
        handle.sessionWindow = cw
        if (re) handle.sessionReasoning = re
        // D-S2-3：既有 system kind + payload.type（payload 加法：窗口声明/思考档随 model/set 落链），EventKind 冻结面不新增
        handle.appendNarrative('model/set', {
          model,
          ...(cw ? { contextWindow: cw } : {}),
          ...(re ? { reasoning: re } : {}),
        })
        return { ok: true, model }
      }
      // —— S5（D-S5-2）：立即压缩（内核 applyCompaction——append-only compact 事件） ——
      case IpcChannel.SessionCompact: {
        const handle = requireAliveHandle(requireString(p.workspaceId, 'workspaceId'), requireString(p.sessionId, 'sessionId'))
        return handle.compactNow()
      }
      case IpcChannel.FileSecurityGet:
        return fileSecurityStore.get()
      case IpcChannel.FileSecuritySet:
        // 全量透传（v2 双轴：rules + networkRules；数组/对象两形态由 store 兼容）
        return fileSecurityStore.set(p)
      case IpcChannel.FileSecurityReset:
        return fileSecurityStore.reset()
      // —— S3-S3：安全中心设置 + 会话策略 ——
      case IpcChannel.SecuritySettingsGet:
        return securitySettings.get()
      case IpcChannel.SecuritySettingsSet:
        return securitySettings.set(p['patch'])
      case IpcChannel.SessionSetPolicy: {
        const handle = requireAliveHandle(requireString(p.workspaceId, 'workspaceId'), requireString(p.sessionId, 'sessionId'))
        const policy = requireString(p.policy, 'policy')
        if (policy !== 'default' && policy !== 'session' && policy !== 'readonly') {
          throw new Error(`CAR-E-DESKTOP: 非法会话策略（${policy}）——仅 default/session/readonly`)
        }
        return { ok: true, policy: handle.setPolicy(policy as SessionPolicy) }
      }
      case IpcChannel.BackupOpenDir:
        // 打开备份目录属 main 侧 shell 能力（host-core 零 Electron）——本通道在 main 内消化
        throw new Error('CAR-E-DESKTOP: backup:open-dir 由 main 侧处理（契约通道误入宿主 dispatch）')
      // —— S3-S4：审计报告 + 取证包导出（链校验单一权威在内核载入面） ——
      case IpcChannel.AuditReport:
        return sessionAuditReport(
          registry.pathOf(requireString(p.workspaceId, 'workspaceId')),
          requireString(p.sessionId, 'sessionId'),
        )
      case IpcChannel.AuditExport:
        return exportSessionForensics(
          registry.pathOf(requireString(p.workspaceId, 'workspaceId')),
          requireString(p.sessionId, 'sessionId'),
          opts.userDataDir,
        )
      // —— S3-S5：计量聚合（usage 事实遍历全部会话 JSONL——含已删除，删除仅索引态） ——
      case IpcChannel.MeteringSummary:
        return workspaceMeteringSummary(registry.pathOf(requireString(p.workspaceId, 'workspaceId')), priceProvider)
      // —— S4-S1：插件/MCP 只读装载面（F-D4；装载在会话创建时发生，此处呈现登记与最近状态） ——
      case IpcChannel.PluginsList:
        return { registrations: pluginRegistry.get(), states: lastPluginLoad ?? [] }
      case IpcChannel.PluginsAdd: {
        const file = requireString(p.file, 'file')
        if (typeof p.manifest !== 'object' || p.manifest === null) {
          throw new Error('CAR-E-DESKTOP: plugins.add 缺少 manifest（{ name, version }）')
        }
        pluginRegistry.add({ file, manifest: p.manifest })
        return { registrations: pluginRegistry.get(), states: lastPluginLoad ?? [] }
      }
      case IpcChannel.PluginsRemove:
        return { registrations: pluginRegistry.remove(requireString(p.id, 'id')), states: lastPluginLoad ?? [] }
      case IpcChannel.McpList: {
        const wid = requireString(p.workspaceId, 'workspaceId')
        const face = await ensureMcpFace(wid, registry.pathOf(wid))
        return { states: face.states(), tools: face.tools().map((t) => ({ name: t.name, declaredSideEffect: t.declaredSideEffect })) }
      }
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
    dispose(): void {
      // 测试/收口面：MCP stdio 子进程收口（不收口 = 存活流钉住事件环）
      for (const [, entry] of mcpFaces) entry.face.close()
      mcpFaces.clear()
    },
  }
}
