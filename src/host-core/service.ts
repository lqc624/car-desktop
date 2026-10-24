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
import { loadSessionLog, MemoryStore, pendingSteerTurns } from '@lqc123qwe/car-runtime'
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
import { SubagentManager, childSessionIds, recoverChildSessions, type ChildModelFnOpts } from './subagent.ts'
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
import { listCapabilities, writeCapability, editCapability, deleteCapability, type CapabilityEntry } from './capabilities.ts'
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
  /**
   * K2（1.16 子 Agent）：测试注入——覆盖子 Agent 模型回调工厂（生产 = createChatModelFn
   * 同装配的受限形态；子链 runTurn 仍真跑——行为证明）。缺席且 runtime 不可用 = 编排工具不挂。
   */
  childModelFnOverride?: (o: ChildModelFnOpts) => HostModelFn
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

  // —— S6（D-S6-1）：工作区记忆存储（per-workspace 懒创建；dir = <workspaceRoot>/.car/memory/） ——
  const memoryStores = new Map<string, MemoryStore>()
  function getMemoryStore(workspaceRoot: string): MemoryStore {
    let store = memoryStores.get(workspaceRoot)
    if (!store) {
      store = new MemoryStore(join(workspaceRoot, '.car', 'memory'))
      memoryStores.set(workspaceRoot, store)
    }
    return store
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
      // S6（D-S6-1）：工作区记忆存储注入（per-workspace 懒创建——<workspaceRoot>/.car/memory/）
      memoryStore: getMemoryStore(workspaceRoot),
      // T-24（PRD C-1）：能力库读取面（<workspaceRoot>/.car/capabilities/ 白盒目录）
      loadCapabilities: () => listCapabilities(workspaceRoot).entries,
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

  /**
   * K2（1.16 子 Agent）：编排管理器装配（session:create 与 resume 共用——禁两份漂移）。
   * 子 Agent 模型锚点 = 继承父会话现值（Q-A2 基线）；K3（D-K2-2 / 内核 1.16.0）：
   * `car.config llm.subagent.model` 覆盖继承——**池（modelPool）或端点覆盖（R-D6）激活时被压过**
   * （与 llm.model 同口径，service 层置 undefined）；护栏上限同键位可配（缺省 = Q-A3 常量）。
   * 模型回调不可装配（runtime null 且无测试覆盖）= 编排工具不挂——spawn 面零暴露。
   * config 载体：调用点上游 loadExtraTools 已 warmCarConfig（同 root）——此处同步装载安全。
   */
  function attachSubagentsFor(workspaceId: string, root: string, handle: SessionHandle, runtime: HostRuntime | null): void {
    const makeChildModelFn =
      opts.childModelFnOverride ??
      (runtime
        ? (o: ChildModelFnOpts) =>
            createChatModelFn({
              runtime,
              log: o.log,
              signal: o.signal,
              currentTurnId: o.currentTurnId,
              currentModel: o.currentModel,
              toolDefs: o.toolDefs,
            })
        : null)
    if (!makeChildModelFn) return
    const cfgLoaded = loadCarConfig({ cwd: root })
    const subCfg = cfgLoaded.error ? undefined : cfgLoaded.config.llm?.subagent
    const overrideable = !cfgLoaded.error && !cfgLoaded.config.modelPool && !endpoint
    handle.attachSubagents(
      new SubagentManager({
        parentSessionId: handle.sessionId,
        workspaceId,
        workspaceRoot: root,
        sessionsDir: sessionsDirFor(root),
        authzTimeoutMs,
        parentLog: handle.log,
        parentPolicy: () => handle.policy,
        parentCurrentTurnId: () => handle.currentTurnId(),
        parentModel: () => handle.sessionModel,
        subagent: subCfg ? { ...subCfg, model: overrideable ? subCfg.model : undefined } : undefined,
        fileSecurity,
        emitEvent: (sessionId, event) => emit(IpcPushTopic.SessionEvent, { workspaceId, sessionId, event }),
        emitAuthzPending: (p) => emit(IpcPushTopic.AuthzPending, p),
        emitAuthzResolved: (p) => emit(IpcPushTopic.AuthzResolved, p),
        waitAuthzDecision: (_sessionId: string, requestId: string) =>
          new Promise<AuthzResponse>((resolve) => {
            authzWaiters.set(requestId, resolve)
          }),
        makeChildModelFn,
        registerChildSession: (sessionId, title) => {
          const idx = readSessionIndex(root)
          idx.sessions[sessionId] = idx.sessions[sessionId] ?? { title }
          writeSessionIndex(root, idx)
        },
      }),
    )
  }

  /**
   * 跨运行句柄重建公共路径（T-22 / T-20 结论）：验链（调用方先决）→ 五件套同构
   * （loadRuntimeFor + loadExtraTools + SessionHandle.resume + wireRoutingSink +
   * attachRuntimeModel）。session:open（打开即恢复）与 turn:send（惰性兜底）共用——
   * 禁两份漂移；断链 fail-visible 拒绝续写（先修审计面）。
   */
  async function buildResumedHandle(workspaceId: string, sessionId: string, title: string): Promise<SessionHandle> {
    const root = registry.pathOf(workspaceId)
    const file = join(sessionsDirFor(root), sessionId + '.jsonl')
    if (!existsSync(file)) throw new Error(`CAR-E-DESKTOP: 会话不存在（${sessionId}）`)
    const loaded = loadSessionLog(file)
    if (loaded.brokenAt !== null) {
      throw new Error(`CAR-E-DESKTOP: 会话哈希链断裂（brokenAt seq=${loaded.brokenAt}）——拒绝续写（先修审计面）`)
    }
    const { runtime, modelError, contextWindow, routingSink } = await loadRuntimeFor(root)
    const { extraTools, mcpToolUrl } = await loadExtraTools(workspaceId, root)
    const handle = SessionHandle.resume(
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
    handle.title = title
    wireRoutingSink(routingSink, handle)
    attachRuntimeModel(handle, runtime, root, extraTools)
    attachSubagentsFor(workspaceId, root, handle, runtime)
    handles.set(key(workspaceId, sessionId), handle)
    return handle
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
      // —— S5（D-S5-4）：池成员随元数据返回（模型菜单分组数据面——car.config modelPool） ——
      case 'models:meta': {
        const wid = p['workspaceId'] ? requireString(p.workspaceId, 'workspaceId') : null
        let pool: Array<{ id: string; baseUrl: string; model: string; adapterId: 'openai-compat' | 'anthropic' }> = []
        if (wid) {
          try {
            const root = registry.pathOf(wid)
            await warmCarConfig({ cwd: root })
            const loaded = loadCarConfig({ cwd: root })
            if (!loaded.error) {
              pool = (loaded.config.modelPool?.endpoints ?? []).map((ep, i) => ({
                id: ep.id ?? `ep-${i + 1}`,
                baseUrl: ep.baseUrl,
                model: ep.model,
                adapterId: ep.adapterId ?? 'openai-compat',
              }))
            }
          } catch { /* 工作区配置不可读 = 空池（元数据面不因池失败而红） */ }
        }
        return { meta: MODEL_META, endpoint: endpoint ? { baseUrl: endpoint.baseUrl, model: endpoint.model, contextWindow: endpoint.contextWindow } : null, pool }
      }
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
        attachSubagentsFor(workspaceId, root, handle, runtime)
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
            recovery: null,
          } satisfies SessionOpenResult
        }
        // T-22（D-S6-7）打开即恢复：链完整且未删除 → open 即建可续写句柄——恢复补记
        //（recoverInterrupted + pendingSteerTurns 扫描）先于回放返回，首屏即补记后状态；
        // 恢复动作落 session/recover 叙事 + recovery 报告随返回（禁静默补记）。
        // 只读回放保留面：断链（VD3 断链查看需求）/ 已删除（索引面权威）/ 文件缺失。
        assertSafeId('会话', sessionId)
        const idx = readSessionIndex(root)
        const file = join(sessionsDirFor(root), sessionId + '.jsonl')
        const deleted = idx.sessions[sessionId]?.deleted === true
        const fileExists = existsSync(file)
        let loaded: ReturnType<typeof loadSessionLog> | null = null
        if (fileExists && !deleted) {
          const l = loadSessionLog(file)
          if (l.brokenAt === null) loaded = l
          else console.error(`[host] session:open 断链（brokenAt seq=${l.brokenAt}）——保持只读回放`)
        }
        if (loaded) {
          const handle = await buildResumedHandle(workspaceId, sessionId, idx.sessions[sessionId]?.title ?? '未命名会话')
          const pendingSteers = pendingSteerTurns(handle.log).length
          const rec = handle.recoveryReport
          // T-K2-4：父 open 恢复 = 父链补记（既有路径）+ 子链按载荷枚举逐一 recover（K1 POC 转正式）；
          // 断链子链只读跳过（broken 计数明示），不影响父链恢复
          const childRec = recoverChildSessions(sessionsDirFor(root), sessionId)
          if (rec || childRec.recovered > 0 || childRec.broken > 0) {
            handle.appendNarrative('session/recover', {
              interruptedTurns: rec?.turnsClosed ?? 0,
              syntheticToolResults: rec?.pairedCalls ?? 0,
              pendingSteers,
              ...(childRec.recovered > 0 || childRec.broken > 0 ? { childSessions: { recovered: childRec.recovered, broken: childRec.broken } } : {}),
            })
          }
          return {
            sessionId,
            workspaceId,
            exists: true,
            eventCount: handle.log.events.length,
            title: handle.title,
            model: handle.sessionModel,
            modelError: handle.modelError,
            contextWindow: handle.sessionWindow ?? handle.contextWindow,
            events: [...handle.knownEvents()],
            recovery: {
              interruptedTurns: rec?.turnsClosed ?? 0,
              syntheticToolResults: rec?.pairedCalls ?? 0,
              pendingSteers,
              ...(childRec.recovered > 0 || childRec.broken > 0 ? { childSessions: { recovered: childRec.recovered, broken: childRec.broken } } : {}),
            },
          } satisfies SessionOpenResult
        }
        // 只读回放（D-S2-6 保留面）：文件必须存在，无句柄无追加
        const events = parseSessionEvents(root, sessionId)
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
          recovery: null,
        } satisfies SessionOpenResult
      }
      case IpcChannel.TurnSend: {
        const workspaceId = requireString(p.workspaceId, 'workspaceId')
        const sessionId = requireString(p.sessionId, 'sessionId')
        const text = requireString(p.text, 'text')
        let handle = handles.get(key(workspaceId, sessionId))
        if (!handle) {
          // 跨运行续写兜底（T-22 起 session:open 已即建句柄——本分支覆盖未打开直发形态）：
          // 已删除 fail-visible（索引面权威）；验链/重建走公共路径（与 open 同构，禁漂移）。
          assertSafeId('会话', sessionId)
          const idx = readSessionIndex(registry.pathOf(workspaceId))
          if (idx.sessions[sessionId]?.deleted) {
            throw new Error(`CAR-E-DESKTOP: 会话已删除（${sessionId}）——拒绝续写`)
          }
          handle = await buildResumedHandle(workspaceId, sessionId, idx.sessions[sessionId]?.title ?? '未命名会话')
        }
        return handle.sendTurn(text, { memoryInject: p.memoryInject === true })
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
        // T-K2-4：删除级联——子链留痕保留（文件不动）+ 索引随父标记 deleted（Q-K2-3 子链计入配额同面）
        const idx = readSessionIndex(root)
        idx.sessions[sessionId] = { ...idx.sessions[sessionId], deleted: true }
        for (const cid of childSessionIds(sessionsDirFor(root), sessionId)) {
          idx.sessions[cid] = { ...idx.sessions[cid], deleted: true, deletedWithParent: sessionId }
        }
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
      // —— S6：白盒记忆面（K-MEM-1 消费面；写操作落链承载 = 活跃会话 log——D-46 ②/D-S6-1） ——
      case IpcChannel.MemoryList:
        return getMemoryStore(registry.pathOf(requireString(p.workspaceId, 'workspaceId'))).list()
      case IpcChannel.MemoryWrite: {
        const handle = requireAliveHandle(requireString(p.workspaceId, 'workspaceId'), requireString(p.sessionId, 'sessionId'))
        const text = requireString(p.text, 'text')
        const id = typeof p.id === 'string' && p.id.length ? p.id : undefined
        const tags = Array.isArray(p.tags) ? (p.tags as string[]) : undefined
        return getMemoryStore(handle.workspaceRoot).write(handle.log, {
          ...(id ? { id } : {}),
          text,
          ...(tags ? { tags } : {}),
          sourceSession: handle.sessionId,
        })
      }
      case IpcChannel.MemoryEdit: {
        const handle = requireAliveHandle(requireString(p.workspaceId, 'workspaceId'), requireString(p.sessionId, 'sessionId'))
        return getMemoryStore(handle.workspaceRoot).edit(handle.log, requireString(p.id, 'id'), requireString(p.text, 'text'), Array.isArray(p.tags) ? (p.tags as string[]) : undefined)
      }
      case IpcChannel.MemoryRemove: {
        const handle = requireAliveHandle(requireString(p.workspaceId, 'workspaceId'), requireString(p.sessionId, 'sessionId'))
        getMemoryStore(handle.workspaceRoot).remove(handle.log, requireString(p.id, 'id'))
        return { ok: true }
      }
      case IpcChannel.MemoryRollback: {
        const handle = requireAliveHandle(requireString(p.workspaceId, 'workspaceId'), requireString(p.sessionId, 'sessionId'))
        return getMemoryStore(handle.workspaceRoot).rollback(handle.log, requireString(p.id, 'id'))
      }
      // ── T-24（D2-S1 / PRD §2）：能力库条目面（CRUD 落链承载 = 活跃会话——memory CRUD 同款链同源） ──
      case IpcChannel.CapabilityList:
        return listCapabilities(registry.pathOf(requireString(p.workspaceId, 'workspaceId')))
      case IpcChannel.CapabilityWrite: {
        const handle = requireAliveHandle(requireString(p.workspaceId, 'workspaceId'), requireString(p.sessionId, 'sessionId'))
        const entry = writeCapability(handle.workspaceRoot, p['entry'])
        handle.appendNarrative('capability/write', { id: entry.id, kind: entry.kind, name: entry.name })
        return entry satisfies CapabilityEntry
      }
      case IpcChannel.CapabilityEdit: {
        const handle = requireAliveHandle(requireString(p.workspaceId, 'workspaceId'), requireString(p.sessionId, 'sessionId'))
        const id = requireString(p.id, 'id')
        const entry = editCapability(handle.workspaceRoot, id, p['patch'])
        handle.appendNarrative('capability/edit', { id, name: entry.name, status: entry.status })
        return entry satisfies CapabilityEntry
      }
      case IpcChannel.CapabilityDelete: {
        const handle = requireAliveHandle(requireString(p.workspaceId, 'workspaceId'), requireString(p.sessionId, 'sessionId'))
        const id = requireString(p.id, 'id')
        deleteCapability(handle.workspaceRoot, id)
        handle.appendNarrative('capability/delete', { id })
        return { ok: true }
      }
      case IpcChannel.CapabilityRefAdd: {
        const handle = requireAliveHandle(requireString(p.workspaceId, 'workspaceId'), requireString(p.sessionId, 'sessionId'))
        handle.capabilityRefAdd(requireString(p.refId, 'refId'))
        return { ok: true }
      }
      case IpcChannel.CapabilityRefRemove: {
        const handle = requireAliveHandle(requireString(p.workspaceId, 'workspaceId'), requireString(p.sessionId, 'sessionId'))
        handle.capabilityRefRemove(requireString(p.refId, 'refId'))
        return { ok: true }
      }
      // ── T-25（D2-S2 / PRD §4）：附件面（file/attach 恒落链；选择器属 main 侧能力） ──
      case IpcChannel.AttachmentPick:
        throw new Error('CAR-E-DESKTOP: attachment:pick 由 main 侧处理（契约通道误入宿主 dispatch）')
      case IpcChannel.AttachmentAdd: {
        const handle = requireAliveHandle(requireString(p.workspaceId, 'workspaceId'), requireString(p.sessionId, 'sessionId'))
        if (!Array.isArray(p.paths) || p.paths.length === 0) {
          throw new Error('CAR-E-DESKTOP: attachment:add 缺少 paths（string[]）')
        }
        return handle.attachmentAdd(p.paths as string[])
      }
      case IpcChannel.AttachmentRemove: {
        const handle = requireAliveHandle(requireString(p.workspaceId, 'workspaceId'), requireString(p.sessionId, 'sessionId'))
        handle.attachmentRemove(requireString(p.path, 'path'))
        return { ok: true }
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
