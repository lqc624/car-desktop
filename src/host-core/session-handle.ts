/**
 * 常驻会话句柄（S2-S1 核心；零 Electron import）
 *
 * 口径：
 *  - **resumable 语义（D-S2-6）**：内核 SessionLog 无恢复面（构造器仅 sessionId，
 *    #tail 私有——跨进程重建必致 seq/prevHash 链分叉）。故：本进程 session:create
 *    的会话 = resumable 句柄（可续写 turn）；先前运行的会话 = **只读回放**（服务层
 *    无句柄、无追加），新 turn fail-visible 拒绝——续写能力登记内核 SessionLog 恢复面
 *    加法候选，桌面禁私补。
 *  - 授权门（D-S2-5）：120s 超时默认拒绝真值在内核 decideByUser；三档映射 =
 *    once（approve=true）/ session（写 grant 缓存[按工具，平台 sessionGrants 同口径]
 *    后续同类操作走 decideBySessionPolicy 幂等落链）/ deny（approve=false）；
 *  - 授权门重排（S3-S2，桌面端文件安全设计 §6.2）：规则面（fileSecurity 引擎）> 会话 grant 面 > 人审门——
 *    allow/deny/fallback-outside 由 decideByRule policy 直判落链（reason 带 ruleId），ask 落入现行三档流程；
 *  - 推送（D-S2-1）：sink 序 = store.append(fsync) 先、emit 后——推送失败不破坏落链
 *    （emit 永不 throw；内核 sink throw = fail-fast 语义仅留给盘面失败）；
 *  - 授权审计事件形态 = 内核 #commit：kind:'turnEnd' + turnId:'authz:*'（渲染层按
 *    turnId 前缀区分，不当真 turn 收口渲染）。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import {
  runTurn,
  SessionFileStore,
  SessionLog,
  AuthzService,
  shouldCompact,
  applyCompaction,
  recoverInterrupted,
  buildMemoryIndex,
  recallMemories,
  pendingSteerTurns,
  type AuthzRequest,
  type CompactionConfig,
  type MemoryStore,
} from '@lqc123qwe/car-runtime'
import type { AuthzPendingPush, AuthzResolvedPush, SessionEventDTO, SessionUsageResult } from '../shared/ipc-contract.ts'
import { parseEventLine } from './model.ts'
import { builtinTools, fileActionOf } from './tools.ts'
import { mergeToolSources } from './toolSources.ts'
import type { CapabilityEntry } from './capabilities.ts'
import type { FileSecurityEngine } from './fileSecurity.ts'
import type { BackupStore } from './backupStore.ts'
import type { SecuritySettings, SessionPolicy } from './securitySettingsStore.ts'
import type { HostModelFn, HostToolDef } from './types.ts'
import type { SubagentManager } from './subagent.ts'
import type { BashTaskManager, BashOutputResult } from './bashTasks.ts'
import type { BrowserHitlPayload, BrowserNetGateResult, BrowserTasks } from './browserTasks.ts'
import { classifyActRisk, describeActTarget } from './browserTasks.ts'
import { domainOfUrl, type BrowserGrantsStore } from './browserGrants.ts'
import { buildPersonaText, type PersonalizationState } from '../shared/personalization.ts'
import { buildUserProfileText, type UserProfileState } from '../shared/userProfile.ts'

export type AuthzResponse = 'once' | 'session' | 'deny' | 'cancelled'

// ── T-25（PRD C-3）：附件双形态分类（文本全文 ≤200KB / 路径登记） ──

export const ATTACHMENT_FULLTEXT_MAX = 200 * 1024

const TEXT_EXTS = new Set([
  '.txt', '.md', '.markdown', '.json', '.csv', '.tsv', '.yml', '.yaml', '.xml', '.html', '.htm', '.css',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs', '.java', '.c', '.h', '.cpp', '.hpp',
  '.sh', '.bat', '.ps1', '.sql', '.ini', '.cfg', '.conf', '.toml', '.log', '.env.example',
])

export interface AttachmentRow {
  path: string
  mode: 'fulltext' | 'path-ref'
  size: number
  mime: string
}

function extOf(p: string): string {
  const i = p.lastIndexOf('.')
  return i >= 0 ? p.slice(i).toLowerCase() : ''
}

function mimeOf(p: string): string {
  const ext = extOf(p)
  const map: Record<string, string> = {
    '.txt': 'text/plain', '.md': 'text/markdown', '.markdown': 'text/markdown', '.json': 'application/json',
    '.csv': 'text/csv', '.tsv': 'text/tab-separated-values', '.yml': 'text/yaml', '.yaml': 'text/yaml',
    '.xml': 'text/xml', '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css',
    '.js': 'text/javascript', '.mjs': 'text/javascript', '.cjs': 'text/javascript', '.ts': 'text/typescript',
    '.tsx': 'text/typescript', '.jsx': 'text/javascript', '.py': 'text/x-python', '.go': 'text/x-go',
    '.rs': 'text/x-rust', '.java': 'text/x-java', '.sql': 'text/x-sql', '.sh': 'text/x-sh',
    '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.zip': 'application/zip',
  }
  return map[ext] ?? (TEXT_EXTS.has(ext) ? 'text/plain' : 'application/octet-stream')
}

export interface SessionHandleDeps {
  workspaceId: string
  /** 与内核 AuthzService timeoutMs 同源注入（默认 120_000；测试注入短超时） */
  authzTimeoutMs: number
  /** 会话目录（service 侧由工作区根推导注入） */
  sessionsDir: string
  emitEvent: (sessionId: string, event: SessionEventDTO) => void
  emitAuthzPending: (p: AuthzPendingPush) => void
  emitAuthzResolved: (p: AuthzResolvedPush) => void
  /** B-2（D-B2-4）：HITL 接管推送（service emit → push:browser-hitl → 渲染层接管卡）；缺省 = 无推送（测试形态） */
  emitBrowserHitl?: (p: BrowserHitlPayload) => void
  /** B-2（D-B2-6）：受控窗口重建触发（service emit → push:browser-need-window → main 中继重建）；缺省 = 不触发 */
  emitBrowserNeedWindow?: () => void
  /** B-2（§4.7 consent 硬化）：浏览器网络授权 grants 持久化（派发前重查 + 按会话×域名分片）；缺省 = 仅内存 grants */
  browserGrants?: BrowserGrantsStore
  /** 授权决策来源（生产 = 渲染层 authz:respond 等待；测试 = 脚本直答）；0.12.0（D-V12-3）：附注随决策返回 */
  waitAuthzDecision: (sessionId: string, requestId: string) => Promise<{ response: AuthzResponse; note?: string }>
  /** Z-7（D-V12-2）：userData 目录（viewer-state.json 文件交接面——main 写入、fileviewer_get_view 读）；缺省 = 工具不注册 */
  userDataDir?: string
  /** 文件安全引擎（S3-S2；service 装配单例——规则面 > grant 面 > 人审门 编排入口） */
  fileSecurity?: FileSecurityEngine
  /** 安全设置读取（S3-S3：新建会话默认策略 + 备份开关/上限即时读） */
  securitySettings?: () => SecuritySettings
  /** 自动备份存储（S3-S3：先保后变；开关与配额经 securitySettings 即时生效） */
  backup?: BackupStore
  /** S4：插件/MCP 工具源桥（builtin 之外并入 toolsMap——跨源同名在 mergeToolSources 显式报错） */
  extraTools?: HostToolDef[]
  /** S4：MCP 工具名 → 远程 server url（网络轴判定数据源；stdio 工具不在册） */
  mcpToolUrl?: Map<string, string>
  /** S4-S2：装配时解析的上下文窗口（元数据表/端点声明；null = 不显示百分比） */
  contextWindow: number | null
  /** S5（D-S5-2）：压缩策略（car.config llm.compaction——会话创建时读取注入；缺省 undefined = 关） */
  compactionCfg?: CompactionConfig
  /** S6（D-S6-2）：工作区记忆存储（service 按工作区懒创建注入；缺省 = 记忆面不可用） */
  memoryStore?: MemoryStore
  /** S6（D-S6-2）：记忆注入字符预算（缺省 8000——字符近似门控，超限 fail-visible） */
  memoryBudgetChars?: number
  /** T-24（PRD C-1）：能力库读取面（service 注入 workspaceRoot 闭包；缺省 = 引用面不可用） */
  loadCapabilities?: () => CapabilityEntry[]
  /** T-ME：回合收口回调（runTurn 正常收口后触发——auto 进化的空闲点检查；缺省 = 无操作） */
  onTurnClosed?: () => void
  /** T-MP：个性化设置面（service 注入 store.state 闭包——创建时快照；缺省 = 无指令） */
  personalization?: () => PersonalizationState
  /** WB-2：用户级画像面（service 注入 store.state 闭包——创建时快照；显式开关出厂关 = 零注入） */
  userProfile?: () => UserProfileState
}

interface HandleInit {
  sessionId: string
  workspaceId: string
  workspaceRoot: string
  /** config llm.model 锚点（model/set 会话覆盖前的初值） */
  configModel: string | null
  /** 模型装配失败原因（S2 修补：建会话当场 fail-visible，禁吞 console） */
  modelError: string | null
  deps: SessionHandleDeps
}

export class SessionHandle {
  readonly sessionId: string
  readonly workspaceId: string
  readonly workspaceRoot: string
  readonly resumable = true
  readonly log: SessionLog
  sessionModel: string | null
  readonly modelError: string | null
  title = '未命名会话'
  busy = false
  readonly abort = { aborted: false }
  /** 会话策略（S3-S3）：新建 = securitySettings 默认值；会话内 setPolicy 切换（落链） */
  policy: SessionPolicy
  /** S4-S2：装配时解析的上下文窗口（D-C5：null = 渲染层不显示百分比） */
  readonly contextWindow: number | null
  /** S4-S3：会话级窗口声明（model/set 随链；null = 未声明，回退装配值） */
  sessionWindow: number | null = null
  /** S5（D-S5-3）：会话级思考档位（model/set 随链；null = 未选，off 同义） */
  sessionReasoning: 'off' | 'low' | 'medium' | 'high' | null = null
  /** S5（D-S5-2）：压缩策略（sendTurn 自动挂载点判定入参） */
  readonly compactionCfg: CompactionConfig | undefined
  /** T-22（D-S6-7）打开即恢复：resume 时恢复层补记报告（全零 = null——clean resume 无恢复动作） */
  recoveryReport: { turnsClosed: number; pairedCalls: number } | null = null

  private readonly store: SessionFileStore
  private readonly authz: AuthzService
  private readonly fileSecurity: FileSecurityEngine | null
  private readonly mcpToolUrl: Map<string, string> | null
  private readonly grants = new Set<string>()
  /** 模型可见工具面（活引用）：attachRuntimeModel 以此为 toolDefs——attachSubagents 后置 push
   *  对每请求可见（R-DRILL-1：此前生产快照分叉致真模型看不见编排三工具）。
   *  C3（WB-1）：readonly 策略 = 本数组**原位裁剪**写声明工具（setPolicy 时 splice/rebuild——
   *  引用稳定 = 活引用语义不破）；执行注册表恒走 allTools（授权门保留：门拦 + 面藏双层） */
  readonly tools: HostToolDef[] = []
  /** C3：全量工具注册表（执行面——runTurnFor 派发 map 数据源；含被面藏的 write 声明工具） */
  private readonly allTools: HostToolDef[] = []
  private modelFn: HostModelFn | null = null
  private readonly waiters = new Map<string, (d: AuthzResponse) => void>()
  private turnSeq = 0
  private currentTurnIdValue = ''
  private readonly deps: SessionHandleDeps
  private subagents: SubagentManager | null = null
  /** T-FV-2：后台 bash 任务面（attachBashTasks 接线——工具入注册表 + 级联 + 孤儿收割） */
  private bashTasks: BashTaskManager | null = null
  private browserTasks: BrowserTasks | null = null
  // T-MP 快照字段退役（WB-2P 实时跟随——每轮对账 store 渲染文本 vs 链上最后注入，见 sendTurn）

  private constructor(init: HandleInit, opts: { log?: SessionLog; turnSeq?: number } = {}) {
    this.sessionId = init.sessionId
    this.workspaceId = init.workspaceId
    this.workspaceRoot = init.workspaceRoot
    this.sessionModel = init.configModel
    this.modelError = init.modelError
    this.deps = init.deps
    this.store = new SessionFileStore(init.deps.sessionsDir + '/' + init.sessionId + '.jsonl')
    this.log = opts.log ?? new SessionLog(init.sessionId)
    this.turnSeq = opts.turnSeq ?? 0
    this.policy = init.deps.securitySettings?.().sessionDefaultPolicy ?? 'default'
    this.contextWindow = init.deps.contextWindow ?? null
    this.compactionCfg = init.deps.compactionCfg
    this.allTools.push(
      ...mergeToolSources(
        builtinTools(
          init.workspaceRoot,
          init.deps.fileSecurity,
          init.deps.backup ? { store: init.deps.backup, ctx: { workspaceId: init.workspaceId, sessionId: init.sessionId } } : undefined,
          init.deps.userDataDir,
        ),
        init.deps.extraTools ?? [],
      ),
    )
    this.tools.push(...this.allTools)
    // C3（WB-1）：出生即 readonly（securitySettings 默认值）时面裁剪立即生效
    this.applyToolFaceTrim()
    this.mcpToolUrl = init.deps.mcpToolUrl ?? null
    this.fileSecurity = init.deps.fileSecurity ?? null
    this.authz = new AuthzService({ log: this.log, timeoutMs: init.deps.authzTimeoutMs })
    // 序 = 先落盘（fsync，fail-fast 保留）后推送（emit 永不 throw——推送失败不破坏落链）
    this.log.attachSink((line) => {
      this.store.append(line)
      this.deps.emitEvent(this.sessionId, parseEventLine(line))
    })
  }

  /** 新建（本进程可续写）句柄：session-start 由此单点落链 */
  static createFresh(init: HandleInit): SessionHandle {
    const h = new SessionHandle(init)
    h.log.append('runtime', 'system', 'session', { type: 'session-start', workspaceId: init.workspaceId })
    // T-MP：个性化注入挂 sendTurn（WB-2P 实时跟随——每轮对账，无创建时快照）
    return h
  }

  /**
   * 跨运行续写重建（S3-S4，D-S2-6 退役）：log = 载入面产出的 SessionLog（链已验完整——
   * 调用方 service 断链 fail-visible 前置），store 同路径 O_APPEND 续写零截断。
   * turnSeq 对齐历史链（扫描既有 T<n> 取最大——新 turn 不与历史 turnId 撞号，usage 聚合按
   * turnId 扫描，撞号即串账）；session-start 不补记（链上已有）。
   * S6（D-S6-3 / R-8）：resume 即接入内核恢复层——未闭合 turn（含消费前崩溃的引导排队事件）
   * 补记 turnEnd=interrupted（内核 s56 定性锁定：消息已发未跑）；补记经 sink 落盘 + 推送，
   * 渲染层待执行徽标据此消隐。
   */
  static resume(init: HandleInit, log: SessionLog): SessionHandle {
    let maxTurn = 0
    for (const e of log.events) {
      const m = /^T(\d+)$/.exec(e.turnId)
      if (m) maxTurn = Math.max(maxTurn, Number(m[1]))
    }
    const h = new SessionHandle(init, { log, turnSeq: maxTurn })
    // T-MP：个性化 resume 不再恢复快照（WB-2P 实时跟随——下一 turn 对账 store 渲染文本
    // vs 链上最后注入，不一致即追加；一致则旧前缀继续生效）
    const report = recoverInterrupted(h.log)
    // T-22：补记报告出面（service 层 open 路径据此落 session/recover 叙事 + 渲染层明示——禁静默补记）
    h.recoveryReport =
      report.turnsClosed > 0 || report.pairedCalls > 0
        ? { turnsClosed: report.turnsClosed, pairedCalls: report.pairedCalls }
        : null
    if (report.turnsClosed > 0 || report.pairedCalls > 0) {
      console.error(`[host] resume 恢复层补记：interrupted turn ×${report.turnsClosed}、合成 toolResult ×${report.pairedCalls}`)
    }
    return h
  }

  /** 生产装配（service 调用）：chatStep 模型回调或测试覆盖 */
  attachModelFn(fn: HostModelFn): void {
    this.modelFn = fn
  }

  /**
   * K2（1.16 子 Agent）：编排管理器接线——三工具入父会话工具注册表（本 turn 起模型可见）。
   * 级联挂点 = abortTurn（杀父 → 全部活跃子链 abort）与 close（收口即级联）。
   */
  attachSubagents(m: SubagentManager): void {
    this.subagents = m
    this.attachTools(m.tools())
  }

  /**
   * T-FV-2：后台 bash 任务面接线——bash_run 工具入父会话工具注册表（本 turn 起模型可见），
   * 接线即孤儿收割（重启后链上无收口的 bash/start 补 stopped——K2 补记先例）。
   * 级联挂点 = abortTurn（杀父 → 全部运行中任务树杀）与 close（收口即级联）。
   */
  attachBashTasks(m: BashTaskManager): void {
    this.bashTasks = m
    this.attachTools(m.tools())
    m.reapOrphans()
  }

  /**
   * C3-B1/B-2：受控浏览器工具面接线——browser_open/browser_read/browser_act 入会话工具注册表
   * （本 turn 起模型可见；提案 §4.2 前台原子工具）。网络轴判定在 authorize ⓪″（browser_open
   * 目标 url 过 decideNetwork——Q-B3 readonly+网络轴与远程 MCP 同口径）+ act 运行面 pre/post
   * 双检（browserNetGate 注入）；高危确认门 ⓪‴；HITL 接管协议（emitHitl + isAborted）；
   * 窗口重建钩子（ensureWindow → push:browser-need-window 中继）；落链叙事 browser/* 由 manager 承载。
   */
  attachBrowserTasks(m: BrowserTasks): void {
    this.browserTasks = m
    this.attachTools(m.tools())
    // B-2：会话级钩子晚绑定（deps 由 service 注入——缺省形态测试零推送零重建）
    m.hooks({
      browserNetGate: (callId, url, phase) => this.browserNetGate(callId, url, phase),
      isAborted: () => this.abort.aborted,
      emitHitl: (p) => this.deps.emitBrowserHitl?.(p),
      ensureWindow: () => this.deps.emitBrowserNeedWindow?.(),
    })
  }

  /**
   * B-2（D-B2-3）：browser_act 导航网络轴（pre/post 双相——decideNetwork 规则面 + policy 语义
   * 与 authorize 编排同源；审计落 authz 链 kind='turnEnd' turnId='authz:*' 同款）。
   * pre 相（锚点 href 预检）：规则命中即判；未命中 = 拒（跨域导航请 browser_open 重走网络轴——防绕过）；
   * 只读策略白名单外恒拒。post 相（act 已引发导航）：规则命中即判；未命中 = 只读拒（导航已发生
   * 不可撤销——审计留痕 + 工具报错）、非只读 APPROVED 留痕 + note 标注（结果 crossNav）。
   */
  private browserNetGate(callId: string, url: string, phase: 'pre' | 'post'): BrowserNetGateResult {
    if (!this.fileSecurity) return { tier: 'allow' } // 无规则引擎（测试形态）→ 不拦（登记）
    const nd = this.fileSecurity.decideNetwork(url)
    if (nd) {
      this.authz.decideByRule(
        { authorizationId: `${this.sessionId}:net-rule:browser-act-${phase}:${callId}`, actor: 'user', capability: 'mcp', resource: url },
        { decision: nd.tier === 'allow' ? 'APPROVED' : 'DENIED', reason: `net-rule:${nd.rule.id} ${nd.tier} browser_act ${phase}` },
      )
      return { tier: nd.tier === 'allow' ? 'allow' : 'deny' }
    }
    if (this.policy === 'readonly') {
      this.authz.decideByRule(
        { authorizationId: `${this.sessionId}:net-policy-ro:browser-act-${phase}:${callId}`, actor: 'user', capability: 'mcp', resource: url },
        { decision: 'DENIED', reason: `session-policy:readonly deny browser_act ${phase} 导航（网络轴未命中白名单——提案 §4.3 只读硬拒）` },
      )
      return { tier: 'deny' }
    }
    if (phase === 'pre') {
      this.authz.decideByRule(
        { authorizationId: `${this.sessionId}:net-pre:browser-act:${callId}`, actor: 'user', capability: 'mcp', resource: url },
        { decision: 'DENIED', reason: 'browser-act:pre-nav 未命中网络白名单——跨域导航请 browser_open 重走网络轴（防绕过）' },
      )
      return { tier: 'deny' }
    }
    this.authz.decideByRule(
      { authorizationId: `${this.sessionId}:net-post:browser-act:${callId}`, actor: 'user', capability: 'mcp', resource: url },
      { decision: 'APPROVED', reason: 'browser-act:post-nav 已发生导航审计留痕（未命中白名单——不可撤销性登记）' },
    )
    return { tier: 'allow', note: 'post-nav-unadjudicated' }
  }

  /** T-FV-2：用户/渲染层任务控制面（宿主动作不过授权门——与 turn:abort 同口径；manager 落链） */
  bashRun(command: string, cwd?: string): { ok: true; taskId: string; state: 'running'; note: string } {
    if (!this.bashTasks) throw new Error('CAR-E-DESKTOP: 后台任务面未挂载（会话未打开或无运行时）')
    return this.bashTasks.run(command, cwd)
  }

  bashOutput(taskId: string): BashOutputResult {
    if (!this.bashTasks) throw new Error('CAR-E-DESKTOP: 后台任务面未挂载（会话未打开或无运行时）')
    return this.bashTasks.output(taskId)
  }

  bashKill(taskId: string): { ok: true; taskId: string; note: string } {
    if (!this.bashTasks) throw new Error('CAR-E-DESKTOP: 后台任务面未挂载（会话未打开或无运行时）')
    return this.bashTasks.kill(taskId, 'user')
  }

  /** T-FV-2：用户主动停子代理（subagent:kill IPC——manager.kill 自落 subagent/kill 链，渲染叙事行/行态现成消费者） */
  killSubagent(subagentId: string): { ok: true; subagentId: string; note: string } {
    if (!this.subagents) throw new Error('CAR-E-DESKTOP: 子 Agent 编排未挂载（会话未打开或无运行时）')
    return this.subagents.kill(subagentId)
  }

  currentTurnId(): string {
    return this.currentTurnIdValue
  }

  /** 链上留痕（model/set、session/rename、session/delete——resumable 才可落；索引面为标题/删除态权威） */
  appendNarrative(type: string, extra: Record<string, unknown> = {}): void {
    this.log.append('runtime', 'system', 'session', { type, ...extra })
  }

  /**
   * 会话策略切换（S3-S3）：default（默认安全）/ session（会话内放行）/ readonly（只读）。
   * 落链口径 = D-S2-3（既有 system kind + payload.type：`session/policy`）——EventKind 冻结面零新增；
   * 策略即时生效于后续 authorize 判定（在途 turn 收口后可见）。
   */
  setPolicy(policy: SessionPolicy): SessionPolicy {
    if (this.policy !== policy) {
      this.policy = policy
      this.appendNarrative('session/policy', { policy })
      this.applyToolFaceTrim()
    }
    return this.policy
  }

  /** C3（WB-1 · D-V171-1）：工具接线单点——allTools 恒收全量；readonly 面藏（恢复时自 allTools 重建） */
  private attachTools(defs: readonly HostToolDef[]): void {
    this.allTools.push(...defs)
    if (this.policy === 'readonly') return
    this.tools.push(...defs)
  }

  /**
   * C3（WB-1 · D-V171-1/D-V171-2）声明面裁剪：readonly 策略 = 模型可见面**原位**移除
   * `declaredSideEffect !== 'readonly'` 工具（未知类按最高约束——声明缺失视为 write）；
   * 引用稳定（splice/rebuild 不换数组对象——attach 时捕获的活引用语义保持，R-DRILL-1 纪律）；
   * 执行注册表（runTurnFor）恒走 allTools——授权门保留（纵深双层：门拦 + 面藏，BT-3 判据不动）。
   */
  private applyToolFaceTrim(): void {
    if (this.policy === 'readonly') {
      for (let i = this.tools.length - 1; i >= 0; i--) {
        if (this.tools[i]!.declaredSideEffect !== 'readonly') this.tools.splice(i, 1)
      }
      return
    }
    // 非 readonly：自全量注册表重建（保序——attach 顺序即 allTools 序）
    if (this.tools.length !== this.allTools.length) {
      this.tools.length = 0
      this.tools.push(...this.allTools)
    }
  }

  /**
   * C7（AD-2 · D-V171-5）：后台完成引导 append（不起 run——与 sendTurn busy 路径同形态：
   * user 事件 `T<n>` 落链 → pendingSteerTurns FIFO 在下一 turn 收口后经 drainPending 消费）。
   * 空闲期 append = 留待下次 sendTurn 收口后交付（等待语义闭合，不即时烧 token）。
   */
  steer(text: string): { turnId: string } {
    const steerId = 'T' + String(++this.turnSeq)
    this.log.append('user', 'user', steerId, text)
    return { turnId: steerId }
  }

  /**
   * 会话级思考档位（S5 / D-S5-3）：off/low/medium/high——落链口径 = model/set payload 加法
   * （reasoning 键，EventKind 零新增）；off/缺席 = chatStep 不下发该字段（字节面零痕迹）。
   */
  setReasoning(effort: 'off' | 'low' | 'medium' | 'high'): void {
    if (this.sessionReasoning !== effort) {
      this.sessionReasoning = effort
      // model/set 复用（会话级参数同一链面）：payload.reasoning 随链
      this.appendNarrative('model/set', {
        model: this.sessionModel ?? '',
        reasoning: effort,
        ...(this.sessionWindow ? { contextWindow: this.sessionWindow } : {}),
      })
    }
  }

  /** 立即压缩（S5 / D-S5-2 IPC session:compact）：fail-visible（CAR-E-COMPACT-* 向渲染层传播）；保护段 N 来自配置 */
  compactNow(): { seq: number; compactedUpTo: number; compactedEvents: number } {
    const ev = applyCompaction(this.log, { turnId: 'compaction', protectLastTurns: this.compactionCfg?.protectLastTurns ?? 4 })
    const p = ev.payload as { compactedUpTo: number; compactedEvents: number }
    return { seq: ev.seq, compactedUpTo: p.compactedUpTo, compactedEvents: p.compactedEvents }
  }

  /**
   * K5-C（V4）：token 维度阈值缺省装配（内核 1.18.0 D-51 消费面）。
   * enabled 仍由 car.config llm.compaction 显式开启（内核 1.13 兼容线——桌面不改缺省开关）；
   * 开启且用户未显式给 thresholdTokens 时，缺省 = 窗口 × 0.78（对齐 ctx-pop 黄线口径：
   * >78% warn / >92% danger——压缩取黄线先动）。窗口真值 = model/set 会话窗口 ?? 端点声明窗口
   * （service 同口径）；两者皆无 = 不装 token 维度（禁估算，modelMeta 缺口面同 D-C5）。
   * 用户显式 thresholdTokens 压过缺省（car.config 单一事实源）。
   */
  private armedCompactionCfg(): CompactionConfig | undefined {
    const cfg = this.compactionCfg
    if (!cfg || cfg.enabled !== true) return undefined
    if (cfg.thresholdTokens !== undefined) return cfg
    const window = this.sessionWindow ?? this.contextWindow
    if (!window) return cfg
    return { ...cfg, thresholdTokens: Math.floor(window * 0.78) }
  }

  /** 已知事件全集（本会话生于本进程，内存即全量；usage/回放共用） */
  knownEvents(): readonly SessionEventDTO[] {
    return this.log.events as unknown as readonly SessionEventDTO[]
  }

  /**
   * 发送消息开 turn；S6（D-S6-3）busy 分流 = **引导发出**：执行中输入框保持可用——消息
   * 以新 turnId 落链排队（发出时刻 append user 事件——内核 SessionLog.append 本就可调），
   * 当前 turn 收口后 FIFO 续跑（drainPending）。**引导 ≠ 注入当前 turn 上下文**——内核
   * 投影隔离（deriveMessages activeTurnId 口径）保证当前 turn 各步请求体零污染。
   */
  sendTurn(text: string, opts: { memoryInject?: boolean } = {}): { turnId: string; steer?: boolean } {
    if (this.busy) {
      const steerId = 'T' + String(++this.turnSeq)
      this.log.append('user', 'user', steerId, text)
      return { turnId: steerId, steer: true }
    }
    if (!this.modelFn) {
      throw new Error(
        'CAR-E-LLM-CONFIG: 模型回调未装配——需要 car.config llm（baseUrl+model）与凭据' +
          '（OPENAI_API_KEY / ANTHROPIC_API_KEY；env 兜底需 CAR_ALLOW_ENV_CREDENTIALS=1——' +
          '内核适配器 resolve 未透传 llm.allowEnvFallback，接线缺口已登记）',
      )
    }
    // S6（D-S6-2）→ 0.12.0（D-V12-7，内核 1.25 召回层消费）：记忆面装配 = **首轮索引常驻 +
    // 每 turn 确定性召回**（buildMemoryIndex/recallMemories——legacy 全量注入退役不再调用）。
    // 首轮判重 = chainHasMemoryInjection 双 meta 键（'memory' | 'memory-index'——旧会话升级防双注入）；
    // 召回零命中 = 零注入零落链（缺席无需取证）；预算 fail-visible 同步抛出（渲染层红条——禁静默截断）。
    // **置于 busy=true 之前**：throw 时 turn 未开、busy 未置（S6M-4 死锁形态防线不动）。
    // T-24（C-5）：能力引用注入先行——返回实际字符数，记忆面按合并预算的剩余额度装载。
    const capabilityChars = this.injectCapabilityRefs()
    // T-25（C-3/C-5）：附件全文注入次之（fulltext 态未注入者）——路径登记形态不注入（fs_read 按需读）。
    const attachmentChars = this.injectAttachments((this.deps.memoryBudgetChars ?? 8000) - capabilityChars)
    if (opts.memoryInject && this.deps.memoryStore) {
      const budget = this.deps.memoryBudgetChars ?? 8000
      const pool = budget - capabilityChars - attachmentChars
      if (!this.chainHasMemoryInjection()) {
        const idx = buildMemoryIndex(this.deps.memoryStore, { budgetChars: pool })
        if (idx.count > 0) {
          this.log.append('user', 'system', 'system', idx.rendered, {
            injection: 'memory-index',
            count: idx.count,
            chars: idx.totalChars,
            ...(idx.driftRepaired ? { driftRepaired: idx.driftRepaired } : {}),
          })
        }
      }
      // 每 turn 召回（D-Z5-3）：tags ∪ keywords ≥2 字符确定性子串匹配（内核 1.25——禁 LLM 禁估算）
      const rec = recallMemories(this.deps.memoryStore, text, { budgetChars: pool })
      if (rec.count > 0) {
        this.log.append('user', 'system', 'system', rec.rendered, {
          injection: 'memory-recall',
          hits: rec.hits,
          count: rec.count,
          chars: rec.totalChars,
        })
      }
    }
    this.busy = true
    this.abort.aborted = false
    // S5（D-S5-2）：自动压缩挂载点——先压缩后 append user（保护段 = 首个 system + 最近 N turn，
    // 内核 planCompaction 语义；N 来自配置；shouldCompact 缺省关 = 1.13 行为零变化）。
    // 自动触发 = best-effort：shouldCompact 命中但保护段覆盖全部 turn（无可折叠区间）时
    // 跳过本回合压缩——非降级面（用户显式 session:compact 仍 fail-visible 传播 NORANGE）。
    const armed = this.armedCompactionCfg()
    if (armed && shouldCompact(this.log, armed)) {
      try {
        applyCompaction(this.log, { turnId: 'compaction', protectLastTurns: armed.protectLastTurns ?? 4 })
      } catch (err) {
        console.error('[host] 自动压缩跳过（无可折叠区间）：', err instanceof Error ? err.message : err)
      }
    }
    // T-MP → WB-2P：个性化注入（**实时跟随**语义，用户裁决 2026-11-22）——每轮对账：当前设置
    // 渲染文本 ≠ 链上最后注入文本 → 追加新注入（落链）；无注入（首轮）或压缩折叠后亦注入。
    // 快照语义退役——改设置后已开会话下一 turn 即生效，resume 同样跟随最新设置。
    // 置于压缩块之后（压缩重注/设置变更注入事件都落在压缩边界之后不被折叠）；不受 opts.memoryInject
    // 门控——persona/长期记忆是常驻指令面不是记忆预算面。
    const ps = this.deps.personalization?.() ?? { toneStyle: 'default', customPrompt: '', addressName: '', personaText: '' }
    const personaText = buildPersonaText(ps)
    if (personaText && this.chainNeedsConstantInjection('persona', personaText)) {
      this.log.append('user', 'system', 'system', personaText, {
        injection: 'persona',
        toneStyle: ps.toneStyle,
        chars: personaText.length,
      })
    }
    const up = this.deps.userProfile?.() ?? { enabled: false, entries: [] }
    const upText = buildUserProfileText(up)
    if (upText && this.chainNeedsConstantInjection('user-profile', upText)) {
      this.log.append('user', 'system', 'system', upText, {
        injection: 'user-profile',
        count: up.entries.length,
        chars: upText.length,
      })
    }
    const turnId = 'T' + String(++this.turnSeq)
    this.currentTurnIdValue = turnId
    this.log.append('user', 'user', turnId, text)
    this.runTurnFor(turnId)
    return { turnId }
  }

  /** 链上是否已有记忆注入行（0.12.0 D-V12-7：双 meta 键判重——legacy 'memory' 与索引 'memory-index' 皆算已注入，旧会话升级防双注入） */
  chainHasMemoryInjection(): boolean {
    return this.log.events.some((e) => {
      if (e.kind !== 'system') return false
      const inj = (e.meta as Record<string, unknown> | null)?.['injection']
      return inj === 'memory' || inj === 'memory-index'
    })
  }

  /**
   * T-MP → WB-2P：常驻指令面注入需求判定（**实时跟随**语义，用户裁决 2026-11-22）——
   * ①链上无该注入（首轮）；②最后一条注入早于最后一条 compact 事件（压缩折叠后重注——内核
   * 折叠下界 = 首个 system.seq+1，非首条 system 会被折叠，重注保持常驻存活）；③**当前渲染
   * 文本 ≠ 链上最后注入文本**（设置变更 → 追加新注入——append-only 链上旧注入仍在前缀，
   * 模型以最近一份为准，与压缩重注既有语义同级）。任一命中 = 注入。
   */
  private chainNeedsConstantInjection(key: 'persona' | 'user-profile', currentText: string): boolean {
    let lastInjectSeq = -1
    let lastInjectText: string | null = null
    let lastCompact = -1
    for (const e of this.log.events) {
      if (e.kind !== 'system') continue
      const inj = (e.meta as Record<string, unknown> | null)?.['injection']
      if (inj === key) {
        lastInjectSeq = e.seq
        lastInjectText = String(e.payload ?? '')
      }
      if ((e.payload as Record<string, unknown> | null)?.['type'] === 'compact') lastCompact = e.seq
    }
    if (lastInjectSeq < 0) return true
    if (lastCompact >= 0 && lastInjectSeq < lastCompact) return true
    return lastInjectText !== currentText
  }

  // ── T-24（PRD C-2/C-5）：能力引用面（引用=prompt 注入，EventKind 零新增） ──

  /**
   * 当轮活跃引用集（引用态扫描）：kind=system + meta.injection==='capability' 的 add/remove
   * 事件按链序收敛——同 refId 后者覆盖前者（撤销 = 补偿事件，链不可变）。
   */
  private activeCapabilityRefs(): string[] {
    const state = new Map<string, boolean>()
    for (const e of this.log.events) {
      if (e.kind !== 'system') continue
      const meta = e.meta as Record<string, unknown> | null
      if (!meta || meta['injection'] !== 'capability') continue
      if (meta['op'] !== 'add' && meta['op'] !== 'remove') continue
      state.set(String(meta['refId']), meta['op'] === 'add')
    }
    return [...state.entries()].filter(([, on]) => on).map(([id]) => id)
  }

  /** 引用条目（选中即落链 add；重复引用幂等） */
  capabilityRefAdd(id: string): void {
    if (this.activeCapabilityRefs().includes(id)) return
    const entry = this.deps.loadCapabilities?.().find((e) => e.id === id)
    if (!entry) throw new Error(`CAR-E-DESKTOP: 能力条目不存在（${id}）`)
    this.log.append('user', 'system', 'system', entry.name, { injection: 'capability', refId: id, op: 'add' })
  }

  /** 撤销引用（remove 补偿事件落链——下一 turn 注入集不再含该条目） */
  capabilityRefRemove(id: string): void {
    if (!this.activeCapabilityRefs().includes(id)) {
      throw new Error(`CAR-E-DESKTOP: 引用不存在或已撤销（${id}）`)
    }
    this.log.append('user', 'system', 'system', id, { injection: 'capability', refId: id, op: 'remove' })
  }

  /**
   * turn 装配注入（sendTurn 挂载点）：活跃引用集非空且与上一注入集不同 → 渲染 spec 文本
   * append system ctx 行（meta.op='inject'）；维护中/已退役条目 meta.warnings 明示（禁静默注入）。
   * 返回注入字符数（与记忆注入合并预算 C-5——记忆面按剩余预算装载，超限 fail-visible 不静默截断）。
   */
  private injectCapabilityRefs(): number {
    if (!this.deps.loadCapabilities) return 0
    const activeIds = this.activeCapabilityRefs()
    if (!activeIds.length) return 0
    const last = [...this.log.events]
      .reverse()
      .find((e) => e.kind === 'system' && (e.meta as Record<string, unknown> | null)?.['injection'] === 'capability' && (e.meta as Record<string, unknown>)['op'] === 'inject')
    if (last && JSON.stringify((last.meta as Record<string, unknown>)['refs']) === JSON.stringify(activeIds)) return 0
    const entries = this.deps.loadCapabilities()
    const parts: string[] = []
    const warnings: string[] = []
    for (const id of activeIds) {
      const entry = entries.find((e) => e.id === id)
      if (!entry) {
        warnings.push(`引用条目不可得（${id}）——本轮跳过（条目已删除或文件损坏）`)
        continue
      }
      const tag = entry.status === 'maintain' ? '【维护中】' : entry.status === 'retired' ? '【已退役】' : ''
      if (tag) warnings.push(`引用条目「${entry.name}」${tag}——注入明示`)
      parts.push(`## ${entry.name}（${entry.kind}${tag}）\n\n${entry.spec}`)
    }
    const rendered = parts.join('\n\n---\n\n')
    const chars = rendered.length
    const budget = this.deps.memoryBudgetChars ?? 8000
    if (chars > budget) {
      throw new Error(
        `CAR-E-MEM-BUDGET: 能力引用注入超合并预算（${chars} > ${budget} 字符——记忆+引用+附件共享上下文预算，fail-visible 禁静默截断）`,
      )
    }
    this.log.append('user', 'system', 'system', rendered, {
      injection: 'capability',
      op: 'inject',
      refs: activeIds,
      count: parts.length,
      chars,
      ...(warnings.length ? { warnings } : {}),
    })
    if (warnings.length) console.error('[host] 能力引用注入告警：', warnings.join('; '))
    return chars
  }

  // ── T-25（PRD C-3）：附件面（file/attach 恒落链——文本全文注入 / 路径登记双形态） ──

  /**
   * 附件登记：fileSecurity 引擎判定（与 fs_read 同口径——工作区外 fallback-outside / deny 硬拒
   * 落链）；文本类且 ≤200KB = fulltext（turn 装配全文注入），其余 = path-ref（模型经 fs_read
   * 按需读取，走授权门/规则面——默认安全心智）。file/attach 叙事恒落链（append-only）。
   */
  attachmentAdd(paths: string[]): AttachmentRow[] {
    const out: AttachmentRow[] = []
    for (const p of paths) {
      if (this.fileSecurity) {
        const d = this.fileSecurity.decide('read', p, this.workspaceRoot)
        if (d.tier === 'deny' || d.tier === 'fallback-outside') {
          throw new Error(
            `CAR-E-DESKTOP: 附件路径被安全规则拒绝（${p}——${d.tier === 'deny' ? '命中拒绝规则' : '工作区外路径'}；与 fs_read 同口径硬拒落链）`,
          )
        }
      }
      const st = statSync(p) // 不存在 = fail-visible（含 ENOENT 全文）
      const mime = mimeOf(p)
      const mode: AttachmentRow['mode'] = TEXT_EXTS.has(extOf(p)) && st.size <= ATTACHMENT_FULLTEXT_MAX ? 'fulltext' : 'path-ref'
      this.appendNarrative('file/attach', { path: p, size: st.size, mime, mode })
      out.push({ path: p, mode, size: st.size, mime })
    }
    return out
  }

  /** 撤销附件（file/attach-remove 补偿事件——未注入的不再注入；已注入行链上保留，零改写） */
  attachmentRemove(path: string): void {
    if (!this.activeAttachments().has(path)) {
      throw new Error(`CAR-E-DESKTOP: 附件不存在或已撤销（${path}）`)
    }
    this.appendNarrative('file/attach-remove', { path })
  }

  /** 会话附件态（file/attach + file/attach-remove 链序收敛——路径 → 登记行） */
  private activeAttachments(): Map<string, AttachmentRow> {
    const state = new Map<string, AttachmentRow>()
    for (const e of this.log.events) {
      if (e.kind !== 'system') continue
      const p = e.payload as Record<string, unknown> | null
      if (!p || p['type'] !== 'file/attach') continue
      state.set(String(p['path']), { path: String(p['path']), mode: p['mode'] === 'fulltext' ? 'fulltext' : 'path-ref', size: Number(p['size'] ?? 0), mime: String(p['mime'] ?? 'application/octet-stream') })
    }
    for (const e of this.log.events) {
      if (e.kind !== 'system') continue
      const p = e.payload as Record<string, unknown> | null
      if (!p || p['type'] !== 'file/attach-remove') continue
      state.delete(String(p['path']))
    }
    return state
  }

  /**
   * turn 装配注入：fulltext 态且未注入（链上无同路径 injection:'attachment' 行）→ 全文 append
   * system ctx 行。返回注入字符数（C-5 合并预算——超剩余额度 fail-visible，禁静默截断）。
   */
  private injectAttachments(budgetChars: number): number {
    const active = this.activeAttachments()
    if (![...active.values()].some((a) => a.mode === 'fulltext')) return 0
    const injected = new Set(
      this.log.events
        .filter((e) => e.kind === 'system' && (e.meta as Record<string, unknown> | null)?.['injection'] === 'attachment')
        .map((e) => String((e.meta as Record<string, unknown>)['path'])),
    )
    let total = 0
    for (const a of active.values()) {
      if (a.mode !== 'fulltext' || injected.has(a.path)) continue
      let content: string
      try {
        content = readFileSync(a.path, 'utf8')
      } catch (err) {
        throw new Error(`CAR-E-DESKTOP: 附件读取失败（${a.path}）——${err instanceof Error ? err.message : err}（fail-visible 禁静默跳过）`)
      }
      const chars = content.length
      if (total + chars > budgetChars) {
        throw new Error(
          `CAR-E-MEM-BUDGET: 附件注入超合并预算（${total + chars} > ${budgetChars} 字符——记忆+引用+附件共享上下文预算，fail-visible 禁静默截断）`,
        )
      }
      this.log.append('user', 'system', 'system', content, {
        injection: 'attachment',
        path: a.path,
        mime: a.mime,
        chars,
      })
      total += chars
    }
    return total
  }

  /** 单 turn 执行（turnId 对应的 user 事件由调用方保证已落链——普通 turn 与引导消费共用）。
   *  C3：执行注册表恒走 allTools 全量（面藏不减执行能力——授权门照常判定，BT-3 判据不动） */
  private runTurnFor(turnId: string): void {
    const tools = new Map<string, HostToolDef>(this.allTools.map((t) => [t.name, t]))
    // 内核 runTurn 自带全部收口语义（error/aborted/成对补记/turnEnd usage 聚合）——
    // 桌面 catch 仅宿主日志，禁补造任何链上事件。
    // authorizeAll（K-FS-1，1.13.0）：readonly 类（fs_read）同样进授权门——读取规则面可达
    const turnPreset = { mode: 'confirm', authorizeAll: true, authorize: this.authorize } as const
    void runTurn({
      log: this.log,
      turnId,
      model: this.modelFn!,
      tools,
      preset: turnPreset,
      signal: this.abort,
    }).then(
      () => {
        this.busy = false
        // T-ME：回合收口 = 宿主空闲点（auto 进化检查挂这里——引导续跑的每条 turn 收口同此）
        try {
          this.deps.onTurnClosed?.()
        } catch (err) {
          console.error('[host] onTurnClosed 回调异常：', err instanceof Error ? err.message : err)
        }
        // S6（D-S6-3）：turn 收口后 FIFO 续跑——扫描引导排队逐条消费（引导 turn 的 user 事件
        // 已在链上，消费 = 以其自身 turnId 开 runTurn，模型读 sessionModel 现值 = 末次 model/set）
        void this.drainPending()
      },
      (err) => {
        this.busy = false
        console.error(`[host] turn ${turnId} 异常（内核已收口）：`, err instanceof Error ? err.message : err)
      },
    )
  }

  /**
   * 引导队列 FIFO 消费（D-S6-3）：pendingSteerTurns 按 seq 序逐条 runTurn；每条消费前检查
   * abort.aborted（停止 = 中断当前 turn + 停止续跑——pending 留链，下次 sendTurn 收口后统一
   * 消费保持 FIFO 顺序）；busy 由调用方维持 true（消费中再发消息 = 继续排队，语义正确）。
   * v0.3 终验修补（R-v03-1）：消费 run 必须 busy=true 门控（与 sendTurn 同口径）——否则轮询门
   * `!this.busy` 恒真，25ms tick 内未收口的引导被反复重发（模型错误 30s 重试窗 ≈ 上千并发
   * 重复 run，各自 error 收口 → 审计链刷数百条 turnEnd）；另设已尝试守卫：头部引导本轮
   * drain 已尝试仍 pending（run 拒绝未收口等异常形态）→ 停止续跑留待下次 sendTurn，禁无限循环。
   */
  private async drainPending(): Promise<void> {
    const attempted = new Set<string>()
    for (;;) {
      if (this.abort.aborted) return
      const pending = pendingSteerTurns(this.log)
      if (!pending.length) return
      const next = pending[0]!
      if (attempted.has(next.turnId)) return // 头部引导已尝试仍未收口 = 异常形态——停止续跑（fail-visible 留链）
      attempted.add(next.turnId)
      this.currentTurnIdValue = next.turnId
      this.busy = true
      this.runTurnFor(next.turnId)
      // runTurnFor 是 void 触发——等待收口：轮询 busy 翻转（收口后 then 里 busy=false + 触发下一轮 drain）
      await new Promise<void>((resolve) => {
        const t = setInterval(() => {
          if (!this.busy || this.abort.aborted) {
            clearInterval(t)
            resolve()
          }
        }, 25)
      })
      if (!this.busy) continue // 正常收口 → 继续扫下一条
      return // aborted → 停止续跑（pending 留链）
    }
  }

  abortTurn(): void {
    this.abort.aborted = true
    // T-K2-4：杀父级联——全部活跃子链 abort（内核以 aborted 收口）+ 在途子链人审即时取消
    this.subagents?.abortAll()
    // T-FV-2：bash 后台任务级联（turn 中断 = 全部运行中任务树杀）
    this.bashTasks?.abortAll()
  }

  /**
   * 授权门（runTurn preset.authorize 集成点——S3-S2 重排 + S3-S3 会话策略编排）：
   * ⓪会话策略「只读」先于规则面（policy 是比规则更严的约束——写/删一律拒，决策 100% 落链；
   *   读取照常走规则面，.ssh 等凭据目录的询问档在只读模式下依然可达）；
   * ①规则面（fileSecurity 引擎首条命中）：allow/deny = decideByRule policy 直判落链（reason 带
   *   ruleId，审计可回答「为什么没问人」）；fallback-outside = 现行沙盒语义硬拒（同样落链）；
   * ①′会话策略「会话内放行」后置于规则面（拒绝红线仍先决）——逐次 decideBySessionPolicy 落链；
   * ②会话 grant 面（按工具——平台 sessionGrants 同口径）：命中走 decideBySessionPolicy 幂等落链；
   * ③人审门（现行 S2 流程原样）：decideByUser 120s 超时默认拒绝，三档 once/session/deny。
   * capability 按工具分派（K-FS-3：fs-read/fs-write/fs-delete；未知工具按最高约束 fs-write——T-22）。
   */
  private readonly authorize = async (call: { id: string; tool: string; args: Record<string, unknown> }): Promise<boolean> => {
    // ⓪⁼（0.12.0 / D-V12-6）：readonly 工具面直判——fileviewer_get_view（本地查看器态读面，零副作用
    // 零网络轴零敏感目录语义）policy 直判落链（审计可回答「为什么没问人」——decideByRule 同口径）；
    // 会话策略「只读」亦放行（读面语义）。选区内容过 redact 在工具 run 内承担（D-V12-6 双护栏）。
    if (call.tool === 'fileviewer_get_view') {
      this.authz.decideByRule(
        { authorizationId: `${this.sessionId}:ro-tool:${call.tool}:${call.id}`, actor: 'user', capability: 'fs-read', resource: 'viewer-state（userData/viewer-state.json 交接投影）' },
        { decision: 'APPROVED', reason: 'readonly toolface auto-approve（fileviewer_get_view——本地查看器态，redact 在 run 内承担）' },
      )
      return true
    }
    // ⓪⁼（0.16.0 / B-3 / D-VB3-1）：browser_shot——页面读语义 + 受管证据落盘（§4.8 视觉验收）。
    // PNG 字节零进链（叙事仅元数据），落盘限 userData/browser-shots 受管目录（不触碰工作区/系统路径）；
    // 会话策略「只读」亦放行（读面语义——fileviewer_get_view 同款）。
    if (call.tool === 'browser_shot') {
      this.authz.decideByRule(
        { authorizationId: `${this.sessionId}:ro-tool:${call.tool}:${call.id}`, actor: 'user', capability: 'mcp', resource: 'browser-shot（userData/browser-shots 受管证据）' },
        { decision: 'APPROVED', reason: 'ro-toolface auto-approve（browser_shot——页面读语义+受管证据落盘，PNG 字节零进链）' },
      )
      return true
    }
    const action = fileActionOf(call.tool)
    // capability 分派：fs 三件按动作（K-FS-3）；MCP 工具 = 'mcp'；browser_* = 'mcp'（Q-B3 同口径——
    // readonly 声明 + 网络轴）；未知工具按最高约束 fs-write（T-22）
    const capability: AuthzRequest['capability'] =
      call.tool === 'fs_read'
        ? 'fs-read'
        : call.tool === 'fs_delete'
          ? 'fs-delete'
          : call.tool.startsWith('mcp_') || call.tool.startsWith('browser_')
            ? 'mcp'
            : 'fs-write'
    const resource = action
      ? typeof call.args['path'] === 'string'
        ? String(call.args['path'])
        : describeResource(call.tool, call.args)
      : call.tool.startsWith('mcp_')
        ? `${call.tool}（远程 MCP）`
        : describeResource(call.tool, call.args)
    // ⓪会话策略「只读」：写/删/未知类（MCP 工具副作用未知 = 按最高约束）一律拒；fs_read 不在此拦截；
    // browser_read 同为读取语义（C3-B1——readonly 声明，网络门在 open 时承担）不在此拦截
    if (this.policy === 'readonly' && action !== 'read' && call.tool !== 'browser_read') {
      this.authz.decideByRule(
        { authorizationId: `${this.sessionId}:policy-ro:${call.tool}:${call.id}`, actor: 'user', capability, resource },
        { decision: 'DENIED', reason: `session-policy:readonly deny ${action ?? call.tool}` },
      )
      return false
    }
    // ⓪′网络轴（S4：远程 MCP 工具——server url 判定，规则面先于一切；未命中 = ask 落入后续编排）
    if (action === null && call.tool.startsWith('mcp_') && this.fileSecurity) {
      const url = this.mcpToolUrl?.get(call.tool)
      if (url) {
        const nd = this.fileSecurity.decideNetwork(url)
        if (nd) {
          const netReq = {
            authorizationId: `${this.sessionId}:net-rule:${call.tool}:${call.id}`,
            actor: 'user' as const,
            capability,
            resource: url,
          }
          this.authz.decideByRule(netReq, {
            decision: nd.tier === 'allow' ? 'APPROVED' : 'DENIED',
            reason: `net-rule:${nd.rule.id} ${nd.tier} ${nd.rule.pattern}`,
          })
          return nd.tier === 'allow'
        }
        // 未命中 → ask（现行策略：MCP 工具全过人审门）——落入 grant 面 / 人审门
      }
    }
    // ⓪″网络轴（C3-B1：browser_open 目标 url——Q-B3 readonly+网络轴；白名单外首次人审 +
    // 会话 grant 缓存由现行编排承接；只读策略下白名单外 = 硬拒〔提案 §4.3「只读策略硬拒」〕）
    if (call.tool === 'browser_open' && this.fileSecurity) {
      const url = typeof call.args['url'] === 'string' ? String(call.args['url']) : ''
      if (url) {
        const nd = this.fileSecurity.decideNetwork(url)
        if (nd) {
          const netReq = {
            authorizationId: `${this.sessionId}:net-rule:${call.tool}:${call.id}`,
            actor: 'user' as const,
            capability,
            resource: url,
          }
          this.authz.decideByRule(netReq, {
            decision: nd.tier === 'allow' ? 'APPROVED' : 'DENIED',
            reason: `net-rule:${nd.rule.id} ${nd.tier} ${nd.rule.pattern}`,
          })
          return nd.tier === 'allow'
        }
        if (this.policy === 'readonly') {
          this.authz.decideByRule(
            { authorizationId: `${this.sessionId}:net-policy-ro:${call.tool}:${call.id}`, actor: 'user', capability, resource: url },
            { decision: 'DENIED', reason: 'session-policy:readonly deny browser_open（网络轴未命中白名单——提案 §4.3 只读硬拒）' },
          )
          return false
        }
        // 未命中且非只读策略 → 落 grant 面（B-2 = 域名粒度持久化）/ 人审门（首次某域人审，同域后续免审）
      }
    }
    // ⓪‴（B-2 / D-B2-2）：browser_act 高危子集恒走人审门——会话策略「会话内放行」与 grants
    // 不短路（提案 §4.3 第 2 条「即便『完全』策略下也弹确认卡」；确定性风险分类器 classifyActRisk）
    if (call.tool === 'browser_act' && classifyActRisk(call.args)) {
      return await this.humanGate(
        call,
        capability,
        `browser_act 高危动作（${describeActTarget(call.args)}）`,
        `${this.sessionId}:${this.currentTurnIdValue}:browser-act-risk:${call.id}`,
      )
    }
    // ①规则面
    if (action && this.fileSecurity) {
      const d = this.fileSecurity.decide(action, call.args['path'], this.workspaceRoot)
      const ruleReq = {
        authorizationId: `${this.sessionId}:rule:${call.tool}:${call.id}`,
        actor: 'user' as const,
        capability,
        resource: d.target,
      }
      if (d.tier === 'allow') {
        this.authz.decideByRule(ruleReq, { decision: 'APPROVED', reason: `file-rule:${d.rule!.id} allow ${action}` })
        return true
      }
      if (d.tier === 'deny') {
        const reason = d.rule
          ? `file-rule:${d.rule.id} deny ${action}`
          : `file-arg:missing-path deny ${action}`
        this.authz.decideByRule(ruleReq, { decision: 'DENIED', reason })
        return false
      }
      if (d.tier === 'fallback-outside') {
        this.authz.decideByRule(ruleReq, {
          decision: 'DENIED',
          reason: `file-fallback:outside-workspace deny ${action} (现行沙盒语义——未命中规则不放宽)`,
        })
        return false
      }
      // 'ask' | 'fallback-inside' → 落入策略「会话内放行」/ grant 面 / 人审门
    }
    // ①′会话策略「会话内放行」：规则面之后（拒绝红线先决）、grant 面之前——逐次 policy 直判落链
    if (this.policy === 'session') {
      this.authz.decideBySessionPolicy({
        authorizationId: `${this.sessionId}:policy-session:${call.tool}:${call.id}`,
        actor: 'user',
        capability,
        resource,
      })
      return true
    }
    // ②会话 grant 面：browser_open = 域名粒度持久化（B-2 / §4.7 consent 硬化——派发前现读盘，
    // 撤销立即生效；存储失败 = 拒绝授权与派发绝不降级）；其余工具维持工具粒度内存 grant（B-1 形态）
    if (call.tool === 'browser_open' && this.deps.browserGrants) {
      const url = typeof call.args['url'] === 'string' ? String(call.args['url']) : ''
      const domain = url ? domainOfUrl(url) : null
      if (domain) {
        let granted: boolean
        try {
          granted = this.deps.browserGrants.has(this.sessionId, `browser_open@${domain}`)
        } catch (e) {
          this.authz.decideByRule(
            { authorizationId: `${this.sessionId}:grants-store-error:${call.tool}:${call.id}`, actor: 'user', capability, resource: url },
            { decision: 'DENIED', reason: `browser-grants store error（fail-visible——${e instanceof Error ? e.message : '存储失败'}，清除授权记录可修复）` },
          )
          return false
        }
        if (granted) {
          this.authz.decideBySessionPolicy({
            authorizationId: `${this.sessionId}:policy:browser_open@${domain}:${call.id}`,
            actor: 'user',
            capability,
            resource: url,
          })
          return true
        }
      }
    } else if (call.tool !== 'browser_open' && this.grants.has(call.tool)) {
      this.authz.decideBySessionPolicy({
        authorizationId: `${this.sessionId}:policy:${call.tool}:${call.id}`,
        actor: 'user',
        capability,
        resource,
      })
      return true
    }
    // ③人审门（现行 S2 流程原样；browser_act 高危子集经 ⓪‴ 直入此门）
    return await this.humanGate(
      call,
      capability,
      resource,
      `${this.sessionId}:${this.currentTurnIdValue}:${call.tool}:${call.id}`,
    )
  }

  /**
   * ③人审门（B-2 从 authorize 编排提取共用——正常门与高危门同源）：内核 decideByUser 120s
   * 超时默认拒绝；三档响应。session 档授予面：browser_open = 域名粒度持久化（§4.7——写失败
   * 不阻断本次已批准授权，下次派发重查自然缺失 = 再次人审）；其余工具 = 工具粒度内存 grant。
   */
  private async humanGate(
    call: { id: string; tool: string; args: Record<string, unknown> },
    capability: AuthzRequest['capability'],
    resource: string,
    authorizationId: string,
  ): Promise<boolean> {
    // 0.12.0（D-V12-3）：holder 形态——闭包 let 变量在 decideByUser await 边界的 CFA 窄化会把外层读点
    // 判成 never（属性读不受影响）；对象形态实答 = 附注随决策落链（内核 1.25.1，批准/拒绝两档皆可带）
    const answered: { v: { response: AuthzResponse; note?: string } | null } = { v: null }
    const decision = await this.authz.decideByUser(
      { authorizationId, actor: 'user', capability, resource },
      async () => {
        this.deps.emitAuthzPending({
          kind: 'pending',
          workspaceId: this.workspaceId,
          sessionId: this.sessionId,
          requestId: authorizationId,
          tool: call.tool,
          capability,
          resource,
          timeoutMs: this.deps.authzTimeoutMs,
          ts: Date.now(),
        })
        answered.v = await this.deps.waitAuthzDecision(this.sessionId, authorizationId)
        if (answered.v.response === 'session') {
          if (call.tool === 'browser_open') {
            const url = typeof call.args['url'] === 'string' ? String(call.args['url']) : ''
            const domain = url ? domainOfUrl(url) : null
            if (domain) {
              try {
                this.deps.browserGrants?.grant(this.sessionId, `browser_open@${domain}`)
              } catch (e) {
                console.error(`[host] browser grant 持久化失败（${domain}）：`, e instanceof Error ? e.message : e)
              }
            }
            // 无域名可解析（畸形 url）→ 不授予——下次派发仍人审（fail-visible）
          } else {
            this.grants.add(call.tool)
          }
        }
        // cancelled = 会话关闭取消，归 false 无附注——决策 EXPIRED 同既有语义
        return {
          approve: answered.v.response === 'once' || answered.v.response === 'session',
          ...(typeof answered.v.note === 'string' && answered.v.note.trim() ? { note: answered.v.note.trim().slice(0, 500) } : {}),
        }
      },
    )
    // 内核 decideByUser 对「用户拒绝」与「超时」都记 EXPIRED/timeout——桌面以回调实答区分展示口径，
    // 链上记录以内核为真值（不旁路不改写）
    const outcome: AuthzResolvedPush['outcome'] =
      answered.v?.response === 'once' || answered.v?.response === 'session'
        ? 'approved'
        : answered.v?.response === 'deny'
          ? 'denied'
          : answered.v?.response === 'cancelled'
            ? 'cancelled'
            : 'timeout'
    this.deps.emitAuthzResolved({
      kind: 'resolved',
      workspaceId: this.workspaceId,
      sessionId: this.sessionId,
      requestId: authorizationId,
      outcome,
      decidedBy: outcome === 'approved' ? 'user' : outcome === 'cancelled' ? 'host' : 'timeout',
    })
    return decision.decision === 'APPROVED'
  }

  /** 渲染层 authz:respond 入口（未知 requestId = 已超时/已决——fail-visible） */
  respondAuthz(requestId: string, decision: Exclude<AuthzResponse, 'cancelled'>): void {
    const w = this.waiters.get(requestId)
    if (!w) throw new Error(`CAR-E-DESKTOP: 授权请求不存在或已决（${requestId}）`)
    this.waiters.delete(requestId)
    w(decision)
  }

  /** 授权等待注册（service 把 waitAuthzDecision 回调接到这里） */
  awaitAuthzDecision(requestId: string): Promise<AuthzResponse> {
    return new Promise((resolve) => {
      this.waiters.set(requestId, resolve)
    })
  }

  /** 句柄收口：store 关闭（续写 CAR-E-STORE fail-fast）+ 在途授权以 cancelled 决 */
  close(): void {
    for (const [id, w] of this.waiters) {
      w('cancelled')
      this.deps.emitAuthzResolved({
        kind: 'resolved',
        workspaceId: this.workspaceId,
        sessionId: this.sessionId,
        requestId: id,
        outcome: 'cancelled',
        decidedBy: 'host',
      })
    }
    this.waiters.clear()
    this.abort.aborted = true
    // T-K2-4：级联收口 = abort 全部子链 + 子链 store 关闭（与父 store 关闭同点）
    this.subagents?.closeAll()
    // T-FV-2：bash 后台任务级联收口
    this.bashTasks?.closeAll()
    this.store.close()
  }

  /** 用量聚合（usage 事件真实值求和——D-S2-4 禁估算） */
  usage(): SessionUsageResult {
    return usageOver(this.knownEvents())
  }
}

/** usage 聚合纯函数（resumable 传 log.events；只读会话传解析回放集——同一口径） */
export function usageOver(events: readonly SessionEventDTO[]): SessionUsageResult {
  let turns = 0
  let requests = 0
  const usageTurns = new Set<string>()
  let input = 0
  let output = 0
  let cacheRead = 0
  let cacheCreation = 0
  let lastInput: number | null = null
  let lastOutput: number | null = null
  let reasoning = 0
  let hasReasoning = false
  let lastReasoning: number | null = null
  for (const e of events) {
    if (e.kind === 'turnEnd' && !e.turnId.startsWith('authz:')) turns++
    if (e.kind !== 'usage') continue
    const p = (e.payload ?? {}) as Record<string, unknown>
    const n = (k: string): number => (typeof p[k] === 'number' ? (p[k] as number) : 0)
    input += n('input')
    output += n('output')
    cacheRead += n('cacheRead')
    cacheCreation += n('cacheCreation')
    // S5（D-S5-3 / K-MP-2b）：分段事实聚合——provider 真实细分，无事实不带键（禁估算）
    const seg = (p['segments'] ?? null) as { reasoningTokens?: unknown } | null
    if (seg && typeof seg.reasoningTokens === 'number') {
      reasoning += seg.reasoningTokens
      hasReasoning = true
      lastReasoning = seg.reasoningTokens
    }
    if (typeof p['input'] === 'number') lastInput = p['input'] as number
    if (typeof p['output'] === 'number') lastOutput = p['output'] as number
    requests++
    usageTurns.add(e.turnId)
  }
  return {
    turns,
    requests,
    turnsWithUsage: usageTurns.size,
    input,
    output,
    cacheRead,
    cacheCreation,
    lastInput,
    lastOutput,
    ...(hasReasoning ? { segments: { reasoningTokens: reasoning }, lastSegments: { reasoningTokens: lastReasoning! } } : {}),
    coverage: turns > 0 ? usageTurns.size / turns : null,
  }
}

function describeResource(tool: string, args: Record<string, unknown>): string {
  if (fileActionOf(tool) && typeof args['path'] === 'string') return String(args['path'])
  return JSON.stringify(args).slice(0, 120)
}
