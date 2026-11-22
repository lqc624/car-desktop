/**
 * 宿主服务装配（宿主核心门面；零 Electron import——S1 规划 D-S1-1，S2 扩展）
 *
 * S2 编排面：常驻句柄注册表（本进程新建会话可续写）+ 推送出口（service 层 emit
 * 永不 throw——推送失败不破坏落链）+ 授权等待注册表（requestId 全局唯一，内嵌
 * sessionId）+ 会话索引面（标题/删除态权威源）。
 * dispatch 通道校验 = 契约白名单 + 载荷形状逐通道 fail-visible。
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { forkInSession, loadSessionLog, MemoryStore, pendingSteerTurns, SessionLog } from '@lqc123qwe/car-runtime'
import {
  IpcChannel,
  IpcPushTopic,
  type AuthzDecisionInput,
  type FileOpenResultDTO,
  type FilePreviewResultDTO,
  type HostProbeResult,
  type MemoryEvolveResultDTO,
  type RepoWikiManifestDTO,
  type SessionInfo,
  type SessionOpenResult,
  type SessionUsageResult,
  type ToolSourceHotStateDTO,
  type WorkspaceInfo,
} from '../shared/ipc-contract.ts'
import { IMAGE_PREVIEW_MAX_BYTES, classifyPreviewFile, imageMimeOf } from '../shared/file-preview.ts'
import { memoryPressureOf, EVOLVE_AUTO_PCT, EVOLVE_REVIEW_TIMEOUT_MS, type EvolutionCandidate } from '../shared/memory-evolution.ts'
import { buildEvolvePrompt, parseEvolveResponse } from './memoryEvolve.ts'
import {
  buildOutlinePrompt,
  buildPagePrompt,
  parseOutlineResponse,
  scanWorkspace,
  stripFences,
  REPO_WIKI_CHAR_BUDGET,
  REPO_WIKI_MAX_FILES,
  type WikiCorpusFile,
  type WikiOutlinePage,
} from './repoWiki.ts'
import { probeSeam } from './probe.ts'
import { WorkspaceRegistry } from './workspaces.ts'
import { SessionHandle, usageOver, type AuthzResponse } from './session-handle.ts'
import { SubagentManager, childSessionIds, recoverChildSessions, type ChildModelFnOpts } from './subagent.ts'
import { BashTaskManager } from './bashTasks.ts'
import { BrowserTasks, BROWSER_CDP_PORT } from './browserTasks.ts'
import { createBrowserStore } from './browserStore.ts'
import { createBrowserGrantsStore } from './browserGrants.ts'
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
import { pluginRegistryStore, loadPlugins, createMcpFace, mergeToolSources, type McpFace, type PluginState, type PluginLoadResult } from './toolSources.ts'
import { createHotReload, fsWatchDef, type HotReloadHandle, type HotWatcherDef } from './hotReload.ts'
import { createHotReloadStore } from './hotReloadStore.ts'
import { listCapabilities, writeCapability, editCapability, deleteCapability, loadCapability, type CapabilityEntry } from './capabilities.ts'
import { skillMdToCapability } from './skill-import.ts'
import { warmCarConfig, loadCarConfig, mergeLlmConfig, type LlmAdapter, type RoutingDecision } from '@lqc123qwe/car-runtime'
import { MODEL_META, resolveModelMeta } from './modelMeta.ts'
import { runDoctor, summarizeRecentFailures, summarizeRecentSettlements, type TurnEndLite, type DoctorRow } from './doctor.ts'
import type { SettlementLite } from '../shared/settlement-rows.ts'
import { createChatModelFn, loadHostRuntime, type HostRuntime } from './model.ts'
import { builtinTools, fsReadTool } from './tools.ts'
import { createFileSecurityEngine, type FileSecurityEngine } from './fileSecurity.ts'
import { createFileSecurityStore } from './fileSecurityStore.ts'
import { createSecuritySettingsStore, type SessionPolicy } from './securitySettingsStore.ts'
import { createPersonalizationStore } from './personalizationStore.ts'
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
  /**
   * T-ME：auto 进化候选复核超时（缺省 120s——timeout-default-deny 同语义；测试注入短值）。
   * 仅 auto 运行挂计时器；手动运行不超时。
   */
  memoryEvolveReviewTimeoutMs?: number
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
  // T-MP：个性化设置（端侧偏好——不进审计链；会话创建时快照注入）
  const personalizationStore = createPersonalizationStore(opts.userDataDir)
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
  /** 工具源装载（S3-S2 builtin + S4 插件/MCP）——session:create / resume 共用；
   *  C1（W-4）：热更新缺省关（D-V10-2）——开启且 last-good 在位时插件源取热快照（MCP 面不变） */
  async function loadExtraTools(workspaceId: string, root: string): Promise<{ extraTools: HostToolDef[]; mcpToolUrl: Map<string, string>; pluginStates: PluginState[] }> {
    const face = await ensureMcpFace(workspaceId, root)
    const hotSnap = hotHandle?.get().value ?? null
    const pluginLoad = hotSnap ?? (await loadPlugins(pluginRegistry.get()))
    lastPluginLoad = pluginLoad.states
    const extraTools = [...pluginLoad.tools, ...face.tools()]
    const mcpToolUrl = new Map<string, string>()
    for (const t of extraTools) {
      const u = face.urlOf(t.name)
      if (u) mcpToolUrl.set(t.name, u)
    }
    return { extraTools, mcpToolUrl, pluginStates: pluginLoad.states }
  }

  // —— C1：工具源热更新（W-4 last-good 快照语义；缺省关 D-V10-2）——
  // 能力库登记：读径即热（每请求闭包重读盘，loadCapabilities 闭包即时 listCapabilities）——
  // 无冻结快照面，W-4 能力库缺口在本架构不存在，热引擎只作用于插件工具源
  const hotStore = createHotReloadStore(opts.userDataDir)
  let hotHandle: HotReloadHandle<PluginLoadResult> | null = null
  /** watcher 定义：登记文件（目录监听滤 plugin-paths.json——原子写 rename-over 后目录监听仍活）+ 各插件文件 */
  const hotWatcherDefs = (): HotWatcherDef[] => [
    fsWatchDef('plugin-paths.json', opts.userDataDir, (fn) => fn === null || fn === 'plugin-paths.json'),
    ...pluginRegistry.get().map((r) => fsWatchDef(`plugin:${r.id}`, r.file)),
  ]
  async function ensureHotHandle(): Promise<HotReloadHandle<PluginLoadResult> | null> {
    if (!hotStore.get().toolSourcesHot) return null
    if (!hotHandle) {
      hotHandle = createHotReload<PluginLoadResult>({ label: 'tool-sources', rebuild: () => loadPlugins(pluginRegistry.get()) })
      hotHandle.arm(hotWatcherDefs())
    }
    await hotHandle.refresh('ensure')
    lastPluginLoad = hotHandle.get().value?.states ?? lastPluginLoad
    return hotHandle
  }
  /** 登记变更后重挂 watcher（新插件文件集）+ 立即重建（states 即时新鲜——修旧账：register 后 states 曾陈旧至下次会话创建） */
  async function hotRefreshAfterRegistryChange(): Promise<void> {
    const h = await ensureHotHandle()
    if (!h) return
    h.arm(hotWatcherDefs())
    await h.refresh('registry-change')
    lastPluginLoad = h.get().value?.states ?? lastPluginLoad
  }
  function toolSourceHotState(): ToolSourceHotStateDTO {
    const snap = hotHandle?.get()
    return {
      enabled: hotStore.get().toolSourcesHot,
      degraded: hotHandle?.degraded() ?? false,
      hasSnapshot: snap?.value != null,
      lastCommitAt: snap?.committedAt ?? null,
      loadErrors: snap?.loadErrors ?? [],
      watching: hotHandle?.watching() ?? [],
    }
  }
  const handles = new Map<string, SessionHandle>()
  const authzWaiters = new Map<string, (d: { response: AuthzResponse; note?: string }) => void>()
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

  // ── T-FV（原型 fv-mask 复刻）：文件查看器（预览 = fs_read 同管线；打开动作落链；回放 = 只读预览不落链） ──

  /** file/preview | file/open 叙事落链（alive 句柄存在才落——回放/未打开 = logged:false，弹层注记） */
  function fileNarrative(
    workspaceId: string,
    sessionId: string,
    type: 'file/preview' | 'file/open',
    extra: Record<string, unknown>,
  ): boolean {
    const handle = handles.get(key(workspaceId, sessionId))
    if (!handle) return false
    handle.appendNarrative(type, extra)
    return true
  }

  /**
   * 受限预览读取：text/csv/html = fs_read 同管线（hardReject 拒 deny/工作区外、二进制拒读、
   * 256KB 截断、redact 脱敏——用户预览与模型读取同一纪律，不另开旁路）；binary 仅 stat 元信息
   * （不读内容——pdf/xlsx 面）；image（B-3）读字节 ≤8MB 回 dataUrl（受管证据目录 carve-out
   * ——用户自阅面非模型面）。规则面命中 tier/ruleId 随叙事（informational——拦截已由
   * fs_read 口径承担）。
   */
  async function filePreview(workspaceId: string, sessionId: string, rawPath: string): Promise<FilePreviewResultDTO> {
    const root = registry.pathOf(workspaceId)
    const kind = classifyPreviewFile(rawPath)
    const decision = fileSecurity.decide('read', rawPath, root)
    const ruleCtx = { tier: decision.tier, ...(decision.rule ? { ruleId: decision.rule.id } : {}) }
    if (kind === 'image') {
      // B-3（D-VB3-3）：图片内嵌预览（≤8MB 栅格类——§4.8 截图证据的用户仲裁可视面）。
      // 受管证据目录 carve-out：userData/browser-shots 在出厂 userData deny 面内，但这是
      // 用户自阅面非模型面（模型 fs 面不触碰证据目录——shot_read 受管交接承担）；
      // 其余路径照常走 hardReject（deny/工作区外拒，与 fs_read 同口径）。
      // abs 一律 resolve 归一（B-3 真模型演练实证：正斜杠绝对路径 C:/... 不归一时
      // startsWith(反斜杠 evidenceRoot) 必 miss → carve-out 失效越界误拒）。
      const abs = resolve(isAbsolute(rawPath) ? rawPath : resolve(root, rawPath))
      const evidenceRoot = resolve(opts.userDataDir, 'browser-shots')
      const inEvidence = abs === evidenceRoot || abs.startsWith(evidenceRoot + sep)
      if (!inEvidence) {
        const msg = fileSecurity.hardReject('read', rawPath, root)
        if (msg) throw new Error(msg)
      }
      const st = statSync(abs) // 不存在 = fail-visible（ENOENT 全文）
      if (st.isDirectory()) throw new Error(`CAR-E-DESKTOP: 预览目标是目录（${rawPath}）`)
      if (st.size > IMAGE_PREVIEW_MAX_BYTES) {
        throw new Error(`CAR-E-DESKTOP: 图片超预览上限（${st.size}B > ${IMAGE_PREVIEW_MAX_BYTES}B——经系统程序打开）`)
      }
      const mime = imageMimeOf(rawPath)
      const logged = fileNarrative(workspaceId, sessionId, 'file/preview', {
        path: rawPath,
        kind,
        bytes: st.size,
        ...(inEvidence ? { evidenceCarveout: true } : {}),
        ...ruleCtx,
      })
      return {
        path: abs,
        kind,
        size: st.size,
        mtime: st.mtimeMs,
        dataUrl: `data:${mime};base64,${readFileSync(abs).toString('base64')}`,
        logged,
        ...ruleCtx,
      }
    }
    if (kind === 'binary') {
      const abs = isAbsolute(rawPath) ? rawPath : resolve(root, rawPath)
      const st = statSync(abs) // 不存在 = fail-visible（ENOENT 全文）
      if (st.isDirectory()) throw new Error(`CAR-E-DESKTOP: 预览目标是目录（${rawPath}）`)
      const logged = fileNarrative(workspaceId, sessionId, 'file/preview', { path: rawPath, kind, bytes: st.size, ...ruleCtx })
      return { path: abs, kind, size: st.size, mtime: st.mtimeMs, logged, ...ruleCtx }
    }
    const read = (await fsReadTool(root, fileSecurity).run({ path: rawPath })) as {
      path: string
      bytes: number
      totalBytes: number
      truncated?: boolean
      redactedCount: number
      content: string
    }
    const abs = isAbsolute(rawPath) ? rawPath : resolve(root, rawPath)
    const st = statSync(abs)
    const logged = fileNarrative(workspaceId, sessionId, 'file/preview', {
      path: rawPath,
      kind,
      bytes: read.bytes,
      redacted: read.redactedCount,
      ...ruleCtx,
    })
    return {
      path: abs,
      kind,
      size: st.size,
      mtime: st.mtimeMs,
      content: read.content,
      ...(read.truncated ? { truncated: true } : {}),
      redactedCount: read.redactedCount,
      logged,
      ...ruleCtx,
    }
  }

  /** 打开动作落链（file/open——shell 成功后由渲染层调用，留痕 = 已发生事实；宿主只管叙事） */
  function fileOpenLog(workspaceId: string, sessionId: string, rawPath: string, how: 'system' | 'browser'): FileOpenResultDTO {
    const logged = fileNarrative(workspaceId, sessionId, 'file/open', { path: rawPath, how })
    return { ok: true, logged }
  }

  // S6（D-S6-1）：工作区记忆存储（per-workspace 懒创建；dir = <workspaceRoot>/.car/memory/）
  const memoryStores = new Map<string, MemoryStore>()
  function getMemoryStore(workspaceRoot: string): MemoryStore {
    let store = memoryStores.get(workspaceRoot)
    if (!store) {
      store = new MemoryStore(join(workspaceRoot, '.car', 'memory'))
      memoryStores.set(workspaceRoot, store)
    }
    return store
  }

  // ── T-ME：记忆进化（手动 + auto）——LLM 直调核（memoryEvolve.ts 纯函数 + 一次性内存 log），
  //    批准落盘走内核 MemoryStore（kind='memory' 事件自动落链）；复核校验 = 链派生（重启安全） ──
  const evolveReviewTimeoutMs = opts.memoryEvolveReviewTimeoutMs ?? EVOLVE_REVIEW_TIMEOUT_MS
  /** 进化模式（workspace 级内存态——端侧 localStorage 权威经 memory:evolve-mode 同步；缺省 manual） */
  const evolveModes = new Map<string, 'manual' | 'auto'>()
  /** 运行中守卫（session 级单飞——LLM 直调不并发） */
  const evolveInFlight = new Set<string>()
  /** auto 运行的复核超时计时器（key = ws::sid::runId；dispose 全清） */
  const evolveTimers = new Map<string, ReturnType<typeof setTimeout>>()

  /** 未决候选存在检查（链派生——上一轮候选未复核完不叠跑 auto） */
  function evolutionPendingExists(handle: SessionHandle): boolean {
    const runs = new Map<string, number>()
    const decided = new Set<string>()
    for (const e of handle.log.events) {
      if (e.kind !== 'system') continue
      const p = e.payload as Record<string, unknown> | null
      if (!p) continue
      const t = String(p['type'] ?? '')
      if (t === 'memory/evolution') {
        const cands = Array.isArray(p['candidates']) ? (p['candidates'] as unknown[]).length : 0
        runs.set(String(p['runId'] ?? '?'), cands)
      } else if (t === 'memory/evolution-apply' || t === 'memory/evolution-reject') {
        decided.add(String(p['runId'] ?? '?') + '::' + String(p['cid'] ?? ''))
      }
    }
    for (const [runId, n] of runs) {
      let undecided = n
      for (const d of decided) if (d.startsWith(runId + '::')) undecided--
      if (undecided > 0) return true
    }
    return false
  }

  /**
   * 进化运行：LLM 直调（一次性内存 SessionLog——chatStep 投影不污染会话链；toolDefs 空 = 无工具面），
   * 候选解析后落链 memory/evolution（usage 从一次性 log 的 usage 事件提取——禁估算，无则省键）。
   * auto = true 时挂复核超时计时器；失败落 memory/evolution-failed 叙事（禁静默）后 rethrow。
   */
  async function memoryEvolve(workspaceId: string, sessionId: string, auto: boolean): Promise<MemoryEvolveResultDTO> {
    const k = key(workspaceId, sessionId)
    if (evolveInFlight.has(k)) throw new Error('CAR-E-DESKTOP: 进化运行进行中——等待完成后再试')
    const handle = requireAliveHandle(workspaceId, sessionId)
    const store = getMemoryStore(handle.workspaceRoot)
    const entries = store.list()
    if (entries.length === 0) throw new Error('CAR-E-DESKTOP: 记忆为空——无可进化的对象（先在面板或对话沉淀记忆）')
    const { runtime, modelError } = await loadRuntimeFor(handle.workspaceRoot)
    if (!runtime) throw new Error(`CAR-E-DESKTOP: 进化运行需要会话模型（${modelError ?? '模型未装配'}）`)
    const runId = 'EV-' + Date.now().toString(36) + '-' + randomBytes(2).toString('hex')
    const evolveLog = new SessionLog('evolve-' + runId)
    const model = createChatModelFn({
      runtime,
      log: evolveLog,
      signal: { aborted: false },
      currentTurnId: () => 'evolve',
      currentModel: () => handle.sessionModel ?? '',
      toolDefs: [],
    })
    evolveInFlight.add(k)
    try {
      // chatStep 消息投影 = log 上本 turnId 的事件——prompt 以 user 事件先行落一次性 log
      evolveLog.append('user', 'user', 'evolve', buildEvolvePrompt(entries.map((e) => ({ id: e.id, text: e.text, updatedAt: e.updatedAt }))))
      const step = await model()
      if (step.stopReason !== 'stop' || !step.text || !step.text.trim()) {
        throw new Error(`CAR-E-DESKTOP: 进化运行未返回有效文本（stopReason=${step.stopReason}）`)
      }
      const parsed = parseEvolveResponse(step.text, new Set(entries.map((e) => e.id)))
      if (parsed.candidates.length === 0) {
        throw new Error(`CAR-E-DESKTOP: 进化候选解析为空（剔除 ${parsed.dropped} 条不合规）——模型输出不合规`)
      }
      const usageEv = evolveLog.events.find((e) => e.kind === 'usage')
      const up = (usageEv?.payload ?? {}) as Record<string, unknown>
      const usage = typeof up['input'] === 'number' && typeof up['output'] === 'number' ? { input: up['input'] as number, output: up['output'] as number } : undefined
      const pressure = memoryPressureOf(entries)
      const modelId = handle.sessionModel ?? ''
      handle.appendNarrative('memory/evolution', {
        runId,
        auto,
        model: modelId,
        pressure,
        ...(usage ? { usage } : {}),
        candidates: parsed.candidates,
        dropped: parsed.dropped,
      })
      if (auto) {
        const tk = k + '::' + runId
        evolveTimers.set(
          tk,
          setTimeout(() => {
            evolveTimers.delete(tk)
            if (!handles.has(k)) return
            for (const c of parsed.candidates) {
              try {
                memoryEvolveDecide(workspaceId, sessionId, runId, c.cid, false, undefined, 'review-timeout')
              } catch {
                /* 已决竞态 = 忽略（复核语义幂等） */
              }
            }
          }, evolveReviewTimeoutMs),
        )
      }
      return {
        runId,
        auto,
        model: modelId,
        pressure,
        candidates: parsed.candidates,
        ...(usage ? { usage } : {}),
        logged: true,
      }
    } catch (err) {
      if (auto) {
        try {
          handle.appendNarrative('memory/evolution-failed', { runId, auto: true, reason: (err instanceof Error ? err.message : String(err)).slice(0, 200) })
        } catch {
          /* 链写失败 = 上层 rethrow 已可见 */
        }
      }
      throw err
    } finally {
      evolveInFlight.delete(k)
    }
  }

  /**
   * 候选复核裁决（链派生校验——run 候选 − apply/reject 已决集，重启安全无内存 stash）。
   * approve = 内核 MemoryStore 落盘（kind='memory' 事件自动落链）+ memory/evolution-apply 叙事；
   * reject = memory/evolution-reject 叙事（feedback 或 reason 留痕）。
   */
  function memoryEvolveDecide(
    workspaceId: string,
    sessionId: string,
    runId: string,
    cid: string,
    approve: boolean,
    feedback?: string,
    rejectReason?: string,
  ): { ok: true; op: EvolutionCandidate['op']; memoryId?: string } {
    const handle = requireAliveHandle(workspaceId, sessionId)
    let found: EvolutionCandidate | undefined
    const decided = new Set<string>()
    for (const e of handle.log.events) {
      if (e.kind !== 'system') continue
      const p = e.payload as Record<string, unknown> | null
      if (!p) continue
      const t = String(p['type'] ?? '')
      if (t === 'memory/evolution' && p['runId'] === runId) {
        for (const c of (p['candidates'] as EvolutionCandidate[]) ?? []) {
          if (c && c.cid === cid) found = c
        }
      } else if ((t === 'memory/evolution-apply' || t === 'memory/evolution-reject') && p['runId'] === runId && p['cid'] === cid) {
        decided.add(cid)
      }
    }
    if (!found) throw new Error(`CAR-E-DESKTOP: 进化候选不存在（${runId}/${cid}）`)
    if (decided.has(cid)) throw new Error(`CAR-E-DESKTOP: 进化候选已决（${runId}/${cid}）——复核幂等禁重复落盘`)
    const store = getMemoryStore(handle.workspaceRoot)
    if (approve) {
      let memoryId: string | undefined
      if (found.op === 'add') {
        memoryId = store.write(handle.log, { text: found.text, ...(found.tags ? { tags: found.tags } : {}), sourceSession: handle.sessionId }).id
      } else if (found.op === 'update') {
        memoryId = store.edit(handle.log, found.targetId!, found.text, found.tags).id
      } else {
        store.remove(handle.log, found.targetId!)
        memoryId = found.targetId
      }
      handle.appendNarrative('memory/evolution-apply', {
        runId,
        cid,
        op: found.op,
        ...(found.targetId ? { targetId: found.targetId } : {}),
        ...(memoryId ? { memoryId } : {}),
      })
      return { ok: true, op: found.op, ...(memoryId ? { memoryId } : {}) }
    }
    handle.appendNarrative('memory/evolution-reject', {
      runId,
      cid,
      op: found.op,
      ...(rejectReason ? { reason: rejectReason } : feedback && feedback.trim() ? { feedback: feedback.trim().slice(0, 500) } : {}),
    })
    return { ok: true, op: found.op }
  }

  /** auto 触发（回合收口空闲点）：模式 auto + 无在途 run + 无未决候选 + 压力达阈值 → fire-and-forget */
  function onTurnClosedFor(workspaceId: string, sessionId: string): void {
    if (evolveModes.get(workspaceId) !== 'auto') return
    const handle = handles.get(key(workspaceId, sessionId))
    if (!handle || evolveInFlight.has(key(workspaceId, sessionId))) return
    if (evolutionPendingExists(handle)) return
    const entries = getMemoryStore(handle.workspaceRoot).list()
    if (entries.length === 0 || memoryPressureOf(entries).pct < EVOLVE_AUTO_PCT) return
    void memoryEvolve(workspaceId, sessionId, true).catch((err) => {
      console.error('[host] 自动进化失败（已落 memory/evolution-failed）：', err instanceof Error ? err.message : err)
    })
  }

  // ── T-RW：RepoWiki（工作区级本地生成——扫描→大纲→逐页→落盘 userData/repo-wiki/<wsId>/，
  //    零上传；落链承载 = 该工作区活跃会话；进度经 push:repo-wiki；dispatch 20s 超时 →
  //    generate 即时返回 runId、编排 fire-and-forget；取消旗标步间检查） ──

  /** 编排中止信号（区别于失败——aborted 落链口径不同） */
  class RepoWikiAbort extends Error {
    constructor() {
      super('RepoWiki generation aborted')
    }
  }

  const repoWikiInFlight = new Set<string>()
  const repoWikiCancel = new Map<string, boolean>()

  function repoWikiDir(workspaceId: string): string {
    return join(opts.userDataDir, 'repo-wiki', workspaceId)
  }

  function repoWikiGet(workspaceId: string): RepoWikiManifestDTO | null {
    const dir = repoWikiDir(workspaceId)
    const file = join(dir, 'manifest.json')
    if (!existsSync(file)) return null
    try {
      const m = JSON.parse(readFileSync(file, 'utf8')) as RepoWikiManifestDTO
      // 页面正文随取（≤6 页全量可承受——渲染层双栏直用，免二次 IPC）
      return {
        ...m,
        pages: m.pages.map((p) => {
          const pf = join(dir, 'pages', p.id + '.md')
          return { ...p, ...(existsSync(pf) ? { md: readFileSync(pf, 'utf8') } : {}) }
        }),
      }
    } catch {
      return null
    }
  }

  function repoWikiStop(workspaceId: string): { ok: true } {
    if (repoWikiInFlight.has(workspaceId)) repoWikiCancel.set(workspaceId, true)
    return { ok: true }
  }

  function repoWikiGenerate(workspaceId: string, sessionId: string): { runId: string } {
    if (repoWikiInFlight.has(workspaceId)) {
      throw new Error('CAR-E-DESKTOP: RepoWiki 生成进行中（该工作区）——等待完成或先停止')
    }
    requireAliveHandle(workspaceId, sessionId) // 落链承载前置校验（D-46②）
    const runId = 'RW-' + Date.now().toString(36) + '-' + randomBytes(2).toString('hex')
    repoWikiInFlight.add(workspaceId)
    repoWikiCancel.set(workspaceId, false)
    void runWikiGeneration(workspaceId, sessionId, runId).catch((err) => {
      console.error('[host] RepoWiki 编排异常（应为已兜底路径）：', err instanceof Error ? err.message : err)
    })
    return { runId }
  }

  async function runWikiGeneration(workspaceId: string, sessionId: string, runId: string): Promise<void> {
    const t0 = Date.now()
    const usageTotal = { input: 0, output: 0 }
    let usageSeen = false
    const progress = (step: string, pct: number, message: string, extra: Record<string, unknown> = {}): void => {
      emit(IpcPushTopic.RepoWiki, { workspaceId, runId, step, pct, message, ...extra })
    }
    const alive = (): SessionHandle | undefined => handles.get(key(workspaceId, sessionId))
    const cancelled = (): boolean => repoWikiCancel.get(workspaceId) === true
    /** 一次 LLM 直调（一次性内存 log——usage 提取禁估算；工具面空） */
    const callModel = async (runtime: NonNullable<Awaited<ReturnType<typeof loadRuntimeFor>>['runtime']>, prompt: string): Promise<{ text: string; usage?: { input: number; output: number } }> => {
      const log = new SessionLog('rw-' + runId + '-' + Math.random().toString(36).slice(2, 6))
      const model = createChatModelFn({
        runtime,
        log,
        signal: { aborted: false },
        currentTurnId: () => 'wiki',
        currentModel: () => alive()?.sessionModel ?? '',
        toolDefs: [],
      })
      log.append('user', 'user', 'wiki', prompt)
      const step = await model()
      if (step.stopReason !== 'stop' || !step.text || !step.text.trim()) {
        throw new Error(`RepoWiki LLM 调用未返回有效文本（stopReason=${step.stopReason}）`)
      }
      const u = log.events.find((e) => e.kind === 'usage')
      const up = (u?.payload ?? {}) as Record<string, unknown>
      const usage = typeof up['input'] === 'number' && typeof up['output'] === 'number' ? { input: up['input'] as number, output: up['output'] as number } : undefined
      if (usage) {
        usageTotal.input += usage.input
        usageTotal.output += usage.output
        usageSeen = true
      }
      return { text: step.text, usage }
    }
    try {
      const handle = alive()
      if (!handle) throw new Error('会话已关闭（落链承载不可用）')
      const root = registry.pathOf(workspaceId)
      const { runtime, modelError } = await loadRuntimeFor(root)
      if (!runtime) throw new Error(`RepoWiki 生成需要会话模型（${modelError ?? '模型未装配'}）`)

      // ① scan：fs_read 同管线逐文件（decide 预筛 + catch 分类）——语料天然脱敏/截断
      progress('scan', 5, '扫描工作区文件…（排除 .git/node_modules/拒绝路径）')
      const scan = scanWorkspace(root)
      const readTool = fsReadTool(root, fileSecurity)
      const corpus: WikiCorpusFile[] = []
      const excluded = { denied: 0, binary: 0, other: 0 }
      let budgetSkipped = 0
      let totalChars = 0
      for (const rel of scan.files) {
        if (cancelled()) throw new RepoWikiAbort()
        if (corpus.length >= REPO_WIKI_MAX_FILES || totalChars >= REPO_WIKI_CHAR_BUDGET) {
          budgetSkipped++
          continue
        }
        const d = fileSecurity.decide('read', rel, root)
        if (d.tier === 'deny' || d.tier === 'fallback-outside') {
          excluded.denied++
          continue
        }
        try {
          const r = (await readTool.run({ path: rel })) as { content: string }
          corpus.push({ path: rel, content: r.content })
          totalChars += r.content.length
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          if (msg.includes('二进制')) excluded.binary++
          else if (msg.includes('被文件规则拒绝') || msg.includes('越界')) excluded.denied++
          else excluded.other++
        }
      }
      handle.appendNarrative('repo-wiki/scan', {
        runId,
        fileCount: corpus.length,
        totalChars,
        excluded,
        budgetSkipped,
        prunedDirs: scan.prunedDirs,
        files: corpus.map((c) => c.path),
      })
      progress('scan', 10, `扫描完成：${corpus.length} 文件 / ${totalChars} 字符（.git/node_modules/拒绝路径已排除）`)

      // ② outline：LLM 直调出页面大纲（≤6 页）
      if (cancelled()) throw new RepoWikiAbort()
      const outline: WikiOutlinePage[] = parseOutlineResponse(
        (await callModel(runtime, buildOutlinePrompt(corpus))).text,
        new Set(corpus.map((c) => c.path)),
      )
      handle.appendNarrative('repo-wiki/outline', { runId, pages: outline.map((p) => ({ id: p.id, title: p.title, files: p.files.length })) })
      progress('outline', 25, `大纲就绪：${outline.length} 页`)

      // ③ pages：逐页 LLM 直调（每步间查取消 + 会话存活）
      const pages: Array<{ id: string; title: string; md: string; chars: number; durationMs: number }> = []
      for (let i = 0; i < outline.length; i++) {
        const p = outline[i]!
        if (cancelled()) throw new RepoWikiAbort()
        if (!alive()) throw new Error('会话已关闭（落链承载不可用——生成中止）')
        const t1 = Date.now()
        const { text, usage } = await callModel(runtime, buildPagePrompt(p, corpus))
        const md = stripFences(text)
        handle.appendNarrative('repo-wiki/page', {
          runId,
          pageId: p.id,
          title: p.title,
          chars: md.length,
          durationMs: Date.now() - t1,
          ...(usage ? { usage } : {}),
        })
        pages.push({ id: p.id, title: p.title, md, chars: md.length, durationMs: Date.now() - t1 })
        progress('page', 25 + Math.round(((i + 1) / outline.length) * 65), `已生成 ${i + 1}/${outline.length} 页：${p.title}`, { pagesDone: i + 1 })
      }

      // ④ write：userData/repo-wiki/<wsId>/（manifest tmp+rename 原子）
      const dir = repoWikiDir(workspaceId)
      mkdirSync(join(dir, 'pages'), { recursive: true })
      for (const p of pages) writeFileSync(join(dir, 'pages', p.id + '.md'), p.md, 'utf8')
      const manifest: RepoWikiManifestDTO = {
        workspaceId,
        generatedAt: Date.now(),
        model: alive()?.sessionModel ?? '',
        durationMs: Date.now() - t0,
        pages: pages.map((p) => ({ id: p.id, title: p.title, chars: p.chars })),
        ...(usageSeen ? { usage: { ...usageTotal } } : {}),
      }
      const tmp = join(dir, 'manifest.json.tmp')
      writeFileSync(tmp, JSON.stringify(manifest, null, 2), 'utf8')
      renameSync(tmp, join(dir, 'manifest.json'))
      const h = alive()
      if (h) {
        h.appendNarrative('repo-wiki/done', {
          runId,
          pages: pages.length,
          totalChars: pages.reduce((n, p) => n + p.chars, 0),
          durationMs: manifest.durationMs,
          ...(usageSeen ? { usage: { ...usageTotal } } : {}),
        })
      }
      progress('done', 100, `RepoWiki 已生成 ${pages.length} 页（本地落盘 · 零上传）`, { pagesDone: pages.length })
    } catch (err) {
      const aborted = err instanceof RepoWikiAbort || cancelled()
      const msg = err instanceof Error ? err.message : String(err)
      const h = alive()
      if (h) {
        if (aborted) h.appendNarrative('repo-wiki/aborted', { runId, atMs: Date.now() - t0 })
        else h.appendNarrative('repo-wiki/failed', { runId, reason: msg.slice(0, 200) })
      }
      progress(
        aborted ? 'aborted' : 'error',
        0,
        aborted ? '已停止（生成随时可停）' : `生成失败：${msg.slice(0, 120)}`,
        aborted ? {} : { error: msg.slice(0, 200) },
      )
    } finally {
      repoWikiInFlight.delete(workspaceId)
      repoWikiCancel.delete(workspaceId)
    }
  }

  function depsFor(workspaceId: string, sessionId: string, workspaceRoot: string, contextWindow: number | null): Parameters<typeof SessionHandle.createFresh>[0]['deps'] {
    return {
      workspaceId,
      authzTimeoutMs,
      sessionsDir: sessionsDirFor(workspaceRoot),
      emitEvent: (sessionId, event) => emit(IpcPushTopic.SessionEvent, { workspaceId, sessionId, event }),
      emitAuthzPending: (p) => emit(IpcPushTopic.AuthzPending, p),
      emitAuthzResolved: (p) => emit(IpcPushTopic.AuthzResolved, p),
      // B-2：浏览器 HITL 接管推送 + 窗口重建触发 + consent grants 持久化（§4.7）
      emitBrowserHitl: (p) => emit(IpcPushTopic.BrowserHitl, p),
      emitBrowserNeedWindow: () => emit(IpcPushTopic.BrowserNeedWindow, { ts: Date.now() }),
      browserGrants,
      waitAuthzDecision: (_sessionId: string, requestId: string) =>
        new Promise<{ response: AuthzResponse; note?: string }>((resolve) => {
          authzWaiters.set(requestId, resolve)
        }),
      fileSecurity,
      securitySettings: () => securitySettings.get(),
      backup,
      contextWindow,
      // Z-7（D-V12-2）：userData 目录（viewer-state.json 交接——fileviewer_get_view 工具注册前提）
      userDataDir: opts.userDataDir,
      // S6（D-S6-1）：工作区记忆存储注入（per-workspace 懒创建——<workspaceRoot>/.car/memory/）
      memoryStore: getMemoryStore(workspaceRoot),
      // T-24（PRD C-1）：能力库读取面（<workspaceRoot>/.car/capabilities/ 白盒目录）
      loadCapabilities: () => listCapabilities(workspaceRoot).entries,
      // T-ME：回合收口 = 宿主空闲点（auto 进化检查）
      onTurnClosed: () => onTurnClosedFor(workspaceId, sessionId),
      // T-MP：个性化设置面（创建时快照——store.state 闭包即时读）
      personalization: () => personalizationStore.state(),
    }
  }

  function cancelSessionAuthz(sessionId: string): void {
    for (const [requestId, resolve] of [...authzWaiters]) {
      if (!requestId.startsWith(sessionId + ':')) continue
      authzWaiters.delete(requestId)
      const h = [...handles.values()].find((x) => x.sessionId === sessionId)
      const workspaceId = h?.workspaceId
      resolve({ response: 'cancelled' })
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
          // 工具可见面 = handle.tools 活引用（K2 编排三工具经 attachSubagents 后置 push 进同一数组——
          // R-DRILL-1 修复：此前此处固化 builtin+extra 快照，真模型看不见 subagent_spawn/join/kill，
          // 执行注册表（runTurnFor 用 this.tools）与模型可见面分叉——演练实链暴露，mock 网关时代不可达）
          toolDefs: handle.tools,
          // S5（D-S5-3）：会话级思考档位实时读（model/set 即时生效）
          currentReasoning: () => handle.sessionReasoning,
          // 1.19.0：流式增量推送面（渲染提示——不落链，事实本体在 JSONL；assistant 事件到达即收口）
          onDelta: (d) =>
            emit(IpcPushTopic.SessionDelta, {
              workspaceId: handle.workspaceId,
              sessionId: handle.sessionId,
              turnId: d.turnId,
              ...(d.textDelta !== undefined ? { textDelta: d.textDelta } : {}),
              ...(d.toolName !== undefined ? { toolName: d.toolName } : {}),
              // v0.9.0（内核 1.22 / D-SD2）：思考掩蔽流透传（可选键——老内核 d 无此键零影响）
              ...(d.thinkingDelta !== undefined ? { thinkingDelta: d.thinkingDelta } : {}),
              ts: Date.now(),
            }),
        }),
      )
    }
  }

  /** 装载模型（configModel 锚点）；装配失败不阻塞会话面，原因必须回到渲染层（S2 修补：禁吞 console） */
  // —— S4-S2：自定义端点（main safeStorage 解密后经 credentials:key-push 内存推送——不落盘不打印） ——
  // K5-F：一 URL 多模型（Claude Code 式）——models 首条 = 装配锚点
  let endpoint: { baseUrl: string; key: string; adapterId?: 'openai-compat' | 'anthropic'; models: Array<{ id: string; contextWindow: number | null }> } | null = null

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
    const activeModel = endpoint?.models[0]?.id ?? runtime?.llm.model ?? null
    const meta = resolveModelMeta(activeModel)
    const contextWindow = meta?.contextWindow ?? endpoint?.models[0]?.contextWindow ?? null
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
              // 1.19.0：子链流式增量（sessionId = 子链 id——推送归组；父视图过滤不消费，审计/后续面可用）
              ...(o.sessionId
                ? {
                    onDelta: (d: { turnId: string; textDelta?: string; toolName?: string }) =>
                      emit(IpcPushTopic.SessionDelta, {
                        workspaceId,
                        sessionId: o.sessionId,
                        turnId: d.turnId,
                        ...(d.textDelta !== undefined ? { textDelta: d.textDelta } : {}),
                        ...(d.toolName !== undefined ? { toolName: d.toolName } : {}),
                        ts: Date.now(),
                      }),
                  }
                : {}),
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
        // B-3（D-VB3-1）：visual 判定档 shot_read 受管证据读面（userData/browser-shots）
        userDataDir: opts.userDataDir,
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
          new Promise<{ response: AuthzResponse; note?: string }>((resolve) => {
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
   * T-FV-2：后台 bash 任务面装配——无运行时依赖（宿主 spawn 自管），无条件挂载；
   * 接线即孤儿收割（重启后链上无收口的 bash/start 补 stopped 收口）。
   */
  function attachBashTasksFor(root: string, handle: SessionHandle): void {
    handle.attachBashTasks(new BashTaskManager({ parentLog: handle.log, workspaceRoot: root }))
  }

  /**
   * C3-B1/B-2：受控浏览器工具面装配——**缺省关**（D-V10-2 / 提案 T-B5：browserEnabled 设置 + 宿主
   * 重启生效的 CDP 端口）；启用态挂 browser_open/browser_read/browser_act（网络轴 authorize ⓪″ +
   * act 运行面 pre/post 双检；高危门 ⓪‴；HITL 接管协议；落链 browser/* 由 manager 承载）。
   * partition 'persist:car-browser'（Q-B4 单分片——账号体系接入后扩展分片键，登记）；
   * 受控窗口 = main 进程创建（宿主启动时、设置启用态、need-window 中继重建）。
   * B-2 §4.7：browser grants 持久化 store（会话×域名分片——authorize 派发前现读盘）。
   */
  const browserStore = createBrowserStore(opts.userDataDir)
  const browserGrants = createBrowserGrantsStore(join(opts.userDataDir, 'browser-grants.json'))
  function attachBrowserFor(handle: SessionHandle): void {
    if (!browserStore.get().browserEnabled) return
    handle.attachBrowserTasks(new BrowserTasks({ parentLog: handle.log, userDataDir: opts.userDataDir, cdpPort: BROWSER_CDP_PORT }))
  }
  /** B-2 §4.7 revoke 语义：设置页「清除浏览器授权记录」动作（清空落盘 = 撤销立即生效） */
  function revokeBrowserGrants(): void {
    browserGrants.revokeAll()
    console.error('[host] browser grants 已清除（revoke——派发前重查即失效）')
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
        deps: { ...depsFor(workspaceId, sessionId, root, contextWindow), extraTools, mcpToolUrl, compactionCfg: runtime?.compaction },
      },
      loaded.log,
    )
    handle.title = title
    wireRoutingSink(routingSink, handle)
    attachRuntimeModel(handle, runtime, root, extraTools)
    attachSubagentsFor(workspaceId, root, handle, runtime)
    attachBashTasksFor(root, handle)
    attachBrowserFor(handle)
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
        const key = requireString(p.key, 'key')
        // K5-F：模型列表归一（字符串/{id,contextWindow} 混装容错；去空去重；≥1 条 fail-visible）
        const rawModels = Array.isArray(p.models) ? p.models : []
        const models: Array<{ id: string; contextWindow: number | null }> = []
        for (const e of rawModels) {
          const id = typeof e === 'string' ? e.trim() : typeof (e as { id?: unknown })?.id === 'string' ? (e as { id: string }).id.trim() : ''
          if (!id || models.some((m) => m.id === id)) continue
          const w = (e as { contextWindow?: unknown })?.contextWindow
          models.push({ id, contextWindow: typeof w === 'number' && w > 0 ? w : null })
        }
        if (!models.length) throw new Error('CAR-E-DESKTOP: credentials:key-push 模型列表为空（端点至少一个模型）')
        endpoint = {
          baseUrl,
          key,
          models,
          // K5-D（V2）：adapterId 随端点（main 已枚举校验；宿主侧缺省 openai-compat）
          adapterId: p.adapterId === 'anthropic' ? 'anthropic' : 'openai-compat',
        }
        return { ok: true, active: true }
      }
      // —— S4-S2：doctor 全项（值不打印——输出面只有布尔/键名/耗时/错误类别） ——
      case 'doctor:run': {
        const workspaceId = p['workspaceId'] ? requireString(p.workspaceId, 'workspaceId') : null
        let llm: { adapterId?: string; allowEnvFallback?: boolean; baseUrl?: string } = { allowEnvFallback: false, baseUrl: undefined }
        let configError: string | null = null
        let poolMembers: Array<{ id: string; baseUrl: string; model: string; adapterId: 'openai-compat' | 'anthropic' }> = []
        let failureRow: DoctorRow | null = null
        let settlementRowResult: DoctorRow | null = null
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
          // C2（W-1c）：近期失败细类扫描——最近 3 个会话 JSONL 尾部 turnEnd（kind/abortedAt 中文标签，
          // doctor.ts summarizeRecentFailures 纯汇总；1.22 旧事件无 kind = reason 原样）
          try {
            const dir = sessionsDirFor(registry.pathOf(workspaceId))
            const files = readdirSync(dir)
              .filter((f) => f.endsWith('.jsonl'))
              .map((f) => ({ f, m: statSync(join(dir, f)).mtimeMs }))
              .sort((a, b) => b.m - a.m)
              .slice(0, 3)
            const turnEnds: TurnEndLite[] = []
            const settlements: SettlementLite[] = []
            for (const { f } of files) {
              const lines = readFileSync(join(dir, f), 'utf8').split('\n')
              for (const line of lines.slice(-200)) {
                try {
                  const e = JSON.parse(line) as { kind?: string; ts?: number; meta?: Record<string, unknown>; payload?: { type?: string } }
                  if (e.kind === 'turnEnd') turnEnds.push({ ts: e.ts ?? 0, meta: e.meta ?? null })
                  // W-2（D-B2-9）：settlement 回执同扫描收集（1.23 及更早链无此事件 = 空表容错）
                  else if (e.kind === 'system' && e.payload?.type === 'settlement') settlements.push(e.payload as unknown as SettlementLite)
                } catch { /* 半行容错 */ }
              }
            }
            failureRow = summarizeRecentFailures(turnEnds)
            settlementRowResult = summarizeRecentSettlements(settlements)
          } catch { /* 会话目录不可读 = 无此行（医生面不因扫描失败而红） */ }
        }
        const rows = [
          ...(configError
            ? [{ label: '工作区配置', ok: false, detail: configError }]
            : []),
          ...(await runDoctor({
            // K5-D（V2）：端点激活时 adapterId 随端点声明（anthropic 探 GET /v1/models + x-api-key；
            // 否则 car.config llm.adapterId 原语义）
            llm: endpoint ? { ...llm, adapterId: endpoint.adapterId ?? 'openai-compat' } : llm,
            endpointKeyPresent: endpoint !== null,
            effectiveBaseUrl: endpoint?.baseUrl ?? llm.baseUrl ?? '',
            probeKey: endpoint?.key ?? process.env[(endpoint?.adapterId ?? llm.adapterId) === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'] ?? null,
            poolMembers,
          }).then((r) => r.rows)),
          // v0.4（T-31 / R-K7-1）：压缩武装真值行——桌面装配口径（无 compaction 键 = 缺省开 K5-D；
          // 键在场 = 内核语义）；窗口真值 = 端点锚点声明（会话内 model/set 可覆盖，doctor 只显端点面）。
          // 滑窗口径网关（商汤 usage ≈ 真实 40%）提示声明网关口径窗口——禁估算红线：内核不做系数修正。
          (() => {
            const compCfg = (llm as { compaction?: { enabled?: boolean; thresholdTokens?: number } }).compaction
            const compEnabled = compCfg === undefined ? true : compCfg.enabled === true
            const anchorWin = endpoint?.models?.[0]?.contextWindow ?? null
            if (compCfg?.thresholdTokens != null) return { label: '压缩武装', ok: true, detail: `thresholdTokens=${compCfg.thresholdTokens}（car.config 显式——单一事实源压过缺省）` }
            if (!compEnabled) return { label: '压缩武装', ok: true, detail: '关闭（llm.compaction.enabled=false）' }
            return anchorWin
              ? { label: '压缩武装', ok: true, detail: `token 阈值 ${Math.floor(anchorWin * 0.78)}（端点声明 ${Math.round(anchorWin / 1000)}k × 0.78；滑窗口径网关建议声明网关口径等效窗口）` }
              : { label: '压缩武装', ok: false, detail: '未武装（锚点模型无窗口声明——禁估算；端点面板补窗口 k 或 car.config 显式 thresholdTokens）' }
          })(),
          ...(failureRow ? [failureRow] : []),
          ...(settlementRowResult ? [settlementRowResult] : []),
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
        return { meta: MODEL_META, endpoint: endpoint ? { baseUrl: endpoint.baseUrl, adapterId: endpoint.adapterId ?? 'openai-compat', models: endpoint.models } : null, pool }
      }
      case IpcChannel.HostProbe: {
        const probe = probeSeam()
        return probe satisfies HostProbeResult
      }
      // B-2 §4.7 revoke：浏览器网络授权记录清除（consent 存储单写者 = 宿主——控制面留痕）
      case IpcChannel.BrowserRevokeGrants: {
        revokeBrowserGrants()
        return { ok: true }
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
          deps: { ...depsFor(workspaceId, sessionId, root, contextWindow), extraTools, mcpToolUrl, compactionCfg: runtime?.compaction },
        })
        // S5（D-S5-1）：routing/decide 落链出口回填（先于任何请求——未回填期无决策丢失面）
        wireRoutingSink(routingSink, handle)
        attachRuntimeModel(handle, runtime, root, extraTools)
        attachSubagentsFor(workspaceId, root, handle, runtime)
    attachBashTasksFor(root, handle)
    attachBrowserFor(handle)
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
        // 0.12.0（D-V12-3）：附注随决策（≤500 字符 trim——空串/非串 = 不带；内核 1.25.1 落链）
        const rawNote = typeof p.note === 'string' ? p.note.trim().slice(0, 500) : ''
        const w = authzWaiters.get(requestId)
        if (!w) throw new Error(`CAR-E-DESKTOP: 授权请求不存在或已决（${requestId}）`)
        authzWaiters.delete(requestId)
        w({ response: decision as AuthzDecisionInput, ...(rawNote ? { note: rawNote } : {}) })
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
      case IpcChannel.SessionFork: {
        // Z-1（0.13.0 / D-Z13-1~4）：会话内分叉——内核 forkInSession（断链/越界 fail-visible）
        // → 子链 JSONL 落盘（SessionFileStore 同形态单文件，桌面不另设事实源）→ 索引谱系登记
        const workspaceId = requireString(p.workspaceId, 'workspaceId')
        const sessionId = requireString(p.sessionId, 'sessionId')
        const handle = requireAliveHandle(workspaceId, sessionId)
        const upToSeq = typeof p.upToSeq === 'number' && Number.isInteger(p.upToSeq) ? p.upToSeq : handle.log.events.length
        const root = registry.pathOf(workspaceId)
        const childId = 'S-' + Date.now().toString(36) + '-' + randomBytes(2).toString('hex')
        const fork = forkInSession(handle.log, childId, { upToSeq })
        mkdirSync(sessionsDirFor(root), { recursive: true })
        writeFileSync(join(sessionsDirFor(root), childId + '.jsonl'), fork.log.exportJSONL(), 'utf8')
        const idx = readSessionIndex(root)
        const parentTitle = idx.sessions[sessionId]?.title ?? '未命名会话'
        idx.sessions[childId] = { title: parentTitle + ' ⎇', forkedFrom: sessionId }
        writeSessionIndex(root, idx)
        return { childSessionId: childId, migrated: fork.migrated }
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
        // 0.12.0（D-V12-8）：type/description/keywords 编辑面（type 走内核 MEMORY_TYPES 校验 fail-visible）
        const memType = typeof p.type === 'string' && p.type.length ? (p.type as never) : undefined
        const description = typeof p.description === 'string' && p.description.length ? p.description : undefined
        const keywords = Array.isArray(p.keywords) ? (p.keywords as string[]) : undefined
        return getMemoryStore(handle.workspaceRoot).write(handle.log, {
          ...(id ? { id } : {}),
          text,
          ...(tags ? { tags } : {}),
          ...(memType ? { type: memType } : {}),
          ...(description ? { description } : {}),
          ...(keywords ? { keywords } : {}),
          sourceSession: handle.sessionId,
        })
      }
      case IpcChannel.MemoryEdit: {
        const handle = requireAliveHandle(requireString(p.workspaceId, 'workspaceId'), requireString(p.sessionId, 'sessionId'))
        // 0.12.0（D-V12-8）：meta 三键语义（undefined=不变/null·''·[]=清空——内核 edit meta 同构）
        const m = (p.meta ?? {}) as { type?: string | null; description?: string; keywords?: string[] }
        const meta = {
          ...(m.type !== undefined ? { type: (m.type === null ? null : String(m.type)) as never } : {}),
          ...(m.description !== undefined ? { description: String(m.description) } : {}),
          ...(m.keywords !== undefined ? { keywords: Array.isArray(m.keywords) ? m.keywords.map(String) : [] } : {}),
        }
        return getMemoryStore(handle.workspaceRoot).edit(handle.log, requireString(p.id, 'id'), requireString(p.text, 'text'), Array.isArray(p.tags) ? (p.tags as string[]) : undefined, Object.keys(meta).length ? meta : undefined)
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
      // ── T-ME：记忆进化（手动 + auto；LLM 直调核——批准落盘走内核 MemoryStore） ──
      case IpcChannel.MemoryEvolve:
        return memoryEvolve(
          requireString(p.workspaceId, 'workspaceId'),
          requireString(p.sessionId, 'sessionId'),
          p['auto'] === true,
        )
      case IpcChannel.MemoryEvolveDecide:
        return memoryEvolveDecide(
          requireString(p.workspaceId, 'workspaceId'),
          requireString(p.sessionId, 'sessionId'),
          requireString(p.runId, 'runId'),
          requireString(p.cid, 'cid'),
          p['approve'] === true,
          typeof p['feedback'] === 'string' ? p['feedback'] : undefined,
        )
      case IpcChannel.MemoryEvolveMode: {
        // 端侧偏好同步（localStorage 权威；workspace 级内存态，不落链）
        const wid = requireString(p.workspaceId, 'workspaceId')
        evolveModes.set(wid, p['mode'] === 'auto' ? 'auto' : 'manual')
        return { ok: true, mode: evolveModes.get(wid) }
      }
      // ── T-MP：个性化设置面（端侧偏好——不落链；应用于新会话快照） ──
      case IpcChannel.PersonalizationGet:
        return personalizationStore.get()
      case IpcChannel.PersonalizationSet:
        return personalizationStore.set(p)
      // ── T-RW：RepoWiki（生成 = fire-and-forget 编排——dispatch 20s 超时面禁同步等待） ──
      case IpcChannel.RepoWikiGet:
        return repoWikiGet(requireString(p.workspaceId, 'workspaceId'))
      case IpcChannel.RepoWikiGenerate:
        return repoWikiGenerate(
          requireString(p.workspaceId, 'workspaceId'),
          requireString(p.sessionId, 'sessionId'),
        )
      case IpcChannel.RepoWikiStop:
        return repoWikiStop(requireString(p.workspaceId, 'workspaceId'))
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
      // ── SKILL.md 导入互认（pick = main 侧 dialog 误入守卫；import = 逐文件解析→写盘→叙事） ──
      case IpcChannel.CapabilityImportPick:
        throw new Error('CAR-E-DESKTOP: capability:import-pick 由 main 侧处理（契约通道误入宿主 dispatch）')
      case IpcChannel.CapabilityImport: {
        const handle = requireAliveHandle(requireString(p.workspaceId, 'workspaceId'), requireString(p.sessionId, 'sessionId'))
        if (!Array.isArray(p.paths) || p.paths.length === 0) {
          throw new Error('CAR-E-DESKTOP: capability:import 缺少 paths（string[]）')
        }
        if (p.paths.length > 50) throw new Error(`CAR-E-DESKTOP: 单次导入上限 50 个文件（当前 ${p.paths.length}）`)
        const results = p.paths.map((raw: unknown): { file: string; ok: boolean; id?: string; name?: string; chars?: number; error?: string } => {
          const file = String(raw)
          try {
            const content = readFileSync(file, 'utf8')
            const cand = skillMdToCapability(content, file.split(/[\\/]/).pop() ?? file)
            if (!cand.ok) return { file, ok: false, error: cand.error }
            // 冲突消解：id 已存在 → -2/-3 后缀（导入不覆盖既有条目——可预测且结果行可见）
            let id = cand.id
            for (let n = 2; loadCapability(handle.workspaceRoot, id) !== null; n++) id = `${cand.id}-${n}`
            const entry = writeCapability(handle.workspaceRoot, { ...cand, id })
            handle.appendNarrative('capability/write', { id: entry.id, kind: entry.kind, name: entry.name, imported: true, source: file })
            return { file, ok: true, id: entry.id, name: entry.name, chars: entry.spec.length }
          } catch (err) {
            return { file, ok: false, error: err instanceof Error ? err.message : String(err) }
          }
        })
        return { results }
      }
      // ── C4 导入向导预览（先收集后计划）：只读解析 + id 冲突预测——零写盘零落链（执行走 CapabilityImport；
      //    预览与执行间文件可变 = 以执行时实际消解为准，预览行 conflict 仅作计划呈现） ──
      case IpcChannel.CapabilityImportPreview: {
        const handle = requireAliveHandle(requireString(p.workspaceId, 'workspaceId'), requireString(p.sessionId, 'sessionId'))
        if (!Array.isArray(p.paths) || p.paths.length === 0) {
          throw new Error('CAR-E-DESKTOP: capability:import-preview 缺少 paths（string[]）')
        }
        if (p.paths.length > 50) throw new Error(`CAR-E-DESKTOP: 单次导入上限 50 个文件（当前 ${p.paths.length}）`)
        const results = p.paths.map((raw: unknown): { file: string; ok: boolean; id?: string; name?: string; chars?: number; predictedId?: string; conflict?: boolean; error?: string } => {
          const file = String(raw)
          try {
            const content = readFileSync(file, 'utf8')
            const cand = skillMdToCapability(content, file.split(/[\\/]/).pop() ?? file)
            if (!cand.ok) return { file, ok: false, error: cand.error }
            const conflict = loadCapability(handle.workspaceRoot, cand.id) !== null
            let predictedId = cand.id
            if (conflict) {
              for (let n = 2; loadCapability(handle.workspaceRoot, predictedId) !== null; n++) predictedId = `${cand.id}-${n}`
            }
            return { file, ok: true, id: cand.id, name: cand.name, chars: cand.spec.length, predictedId, conflict }
          } catch (err) {
            return { file, ok: false, error: err instanceof Error ? err.message : String(err) }
          }
        })
        return { results }
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
      // ── T-FV：文件查看器（file:shell-open 属 main 侧 shell 能力，不入宿主） ──
      case IpcChannel.FilePreview:
        return filePreview(
          requireString(p.workspaceId, 'workspaceId'),
          requireString(p.sessionId, 'sessionId'),
          requireString(p.path, 'path'),
        )
      case IpcChannel.FileOpen:
        return fileOpenLog(
          requireString(p.workspaceId, 'workspaceId'),
          requireString(p.sessionId, 'sessionId'),
          requireString(p.path, 'path'),
          p.how === 'browser' ? 'browser' : 'system',
        )
      case IpcChannel.FileShellOpen:
        throw new Error('CAR-E-DESKTOP: file:shell-open 由 main 侧处理（契约通道误入宿主 dispatch）')
      // ── T-FV-2：任务控制面（subagent:kill / bash:output / bash:kill——宿主动作不过授权门，
      // turn:abort 同口径；落链在 manager 内部——subagent/kill、bash/start|exit|kill） ──
      case IpcChannel.SubagentKill: {
        const handle = requireAliveHandle(requireString(p.workspaceId, 'workspaceId'), requireString(p.sessionId, 'sessionId'))
        return handle.killSubagent(requireString(p.subagentId, 'subagentId'))
      }
      case IpcChannel.BashOutput: {
        const handle = requireAliveHandle(requireString(p.workspaceId, 'workspaceId'), requireString(p.sessionId, 'sessionId'))
        return handle.bashOutput(requireString(p.taskId, 'taskId'))
      }
      case IpcChannel.BashKill: {
        const handle = requireAliveHandle(requireString(p.workspaceId, 'workspaceId'), requireString(p.sessionId, 'sessionId'))
        return handle.bashKill(requireString(p.taskId, 'taskId'))
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
        // C1：热更新开启时登记变更即刷新（states 不再陈旧至下次会话创建；关闭态维持原样）
        if (hotStore.get().toolSourcesHot) await hotRefreshAfterRegistryChange()
        return { registrations: pluginRegistry.get(), states: lastPluginLoad ?? [] }
      }
      case IpcChannel.PluginsRemove: {
        pluginRegistry.remove(requireString(p.id, 'id'))
        if (hotStore.get().toolSourcesHot) await hotRefreshAfterRegistryChange()
        return { registrations: pluginRegistry.get(), states: lastPluginLoad ?? [] }
      }
      // —— C1：工具源热更新开关（缺省关——D-V10-2；Set 即时生效 start/stop，状态面呈现 degraded/loadErrors） ——
      case IpcChannel.ToolSourceHotGet:
        return toolSourceHotState()
      case IpcChannel.ToolSourceHotSet: {
        hotStore.set({ toolSourcesHot: p.enabled === true })
        if (hotStore.get().toolSourcesHot) await ensureHotHandle()
        else {
          hotHandle?.stop()
          hotHandle = null
        }
        return toolSourceHotState()
      }
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
      // C1：热更新 watcher 收口（fs.watch 句柄不收口 = 钉住事件环，同 MCP 先例）
      hotHandle?.stop()
      hotHandle = null
      // T-ME：auto 进化复核超时计时器全清（收口后 handle 查无即 no-op，此处防悬挂句柄）
      for (const t of evolveTimers.values()) clearTimeout(t)
      evolveTimers.clear()
    },
  }
}
