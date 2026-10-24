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
  loadMemoryForInjection,
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
  /** 授权决策来源（生产 = 渲染层 authz:respond 等待；测试 = 脚本直答） */
  waitAuthzDecision: (sessionId: string, requestId: string) => Promise<AuthzResponse>
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
  private readonly tools: HostToolDef[]
  private modelFn: HostModelFn | null = null
  private readonly waiters = new Map<string, (d: AuthzResponse) => void>()
  private turnSeq = 0
  private currentTurnIdValue = ''
  private readonly deps: SessionHandleDeps
  private subagents: SubagentManager | null = null

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
    this.tools = mergeToolSources(
      builtinTools(
        init.workspaceRoot,
        init.deps.fileSecurity,
        init.deps.backup ? { store: init.deps.backup, ctx: { workspaceId: init.workspaceId, sessionId: init.sessionId } } : undefined,
      ),
      init.deps.extraTools ?? [],
    )
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
    this.tools.push(...m.tools())
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
    }
    return this.policy
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
    // S6（D-S6-2）：记忆注入装配——会话首轮一次（链上已有注入行 = resume 会话不重注，
    // append-only 链的注入刷新语义登记 v0.3 评估）；开关 = 渲染层每次发送显式携带（端侧偏好
    // localStorage，默认开）；超预算 = 内核 fail-visible 异常同步抛出（渲染层红条——禁静默截断）。
    // **置于 busy=true 之前**：throw 时 turn 未开、busy 未置（否则预算红条后用户再发会被
    // busy 分流吞进引导队列——S6M-4 实证的死锁形态）。
    // T-24（C-5）：能力引用注入先行——返回实际字符数，记忆面按合并预算的剩余额度装载。
    const capabilityChars = this.injectCapabilityRefs()
    // T-25（C-3/C-5）：附件全文注入次之（fulltext 态未注入者）——路径登记形态不注入（fs_read 按需读）。
    const attachmentChars = this.injectAttachments((this.deps.memoryBudgetChars ?? 8000) - capabilityChars)
    if (opts.memoryInject && this.deps.memoryStore && !this.chainHasMemoryInjection()) {
      const budget = this.deps.memoryBudgetChars ?? 8000
      const inj = loadMemoryForInjection(this.deps.memoryStore, { budgetChars: budget - capabilityChars - attachmentChars })
      if (inj.count > 0) {
        this.log.append('user', 'system', 'system', inj.rendered, { injection: 'memory', count: inj.count, chars: inj.totalChars })
      }
    }
    this.busy = true
    this.abort.aborted = false
    // S5（D-S5-2）：自动压缩挂载点——先压缩后 append user（保护段 = 首个 system + 最近 N turn，
    // 内核 planCompaction 语义；N 来自配置；shouldCompact 缺省关 = 1.13 行为零变化）。
    // 自动触发 = best-effort：shouldCompact（事件计数）命中但保护段覆盖全部 turn（无可折叠区间）时
    // 跳过本回合压缩——非降级面（用户显式 session:compact 仍 fail-visible 传播 NORANGE）。
    if (this.compactionCfg && shouldCompact(this.log, this.compactionCfg)) {
      try {
        applyCompaction(this.log, { turnId: 'compaction', protectLastTurns: this.compactionCfg.protectLastTurns ?? 4 })
      } catch (err) {
        console.error('[host] 自动压缩跳过（无可折叠区间）：', err instanceof Error ? err.message : err)
      }
    }
    const turnId = 'T' + String(++this.turnSeq)
    this.currentTurnIdValue = turnId
    this.log.append('user', 'user', turnId, text)
    this.runTurnFor(turnId)
    return { turnId }
  }

  /** 链上是否已有记忆注入行（meta.injection==='memory' 的 system 事件） */
  chainHasMemoryInjection(): boolean {
    return this.log.events.some((e) => e.kind === 'system' && (e.meta as Record<string, unknown> | null)?.['injection'] === 'memory')
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

  /** 单 turn 执行（turnId 对应的 user 事件由调用方保证已落链——普通 turn 与引导消费共用） */
  private runTurnFor(turnId: string): void {
    const tools = new Map<string, HostToolDef>(this.tools.map((t) => [t.name, t]))
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
    const action = fileActionOf(call.tool)
    // capability 分派：fs 三件按动作（K-FS-3）；MCP 工具 = 'mcp'；未知工具按最高约束 fs-write（T-22）
    const capability: AuthzRequest['capability'] =
      call.tool === 'fs_read'
        ? 'fs-read'
        : call.tool === 'fs_delete'
          ? 'fs-delete'
          : call.tool.startsWith('mcp_')
            ? 'mcp'
            : 'fs-write'
    const resource = action
      ? typeof call.args['path'] === 'string'
        ? String(call.args['path'])
        : describeResource(call.tool, call.args)
      : call.tool.startsWith('mcp_')
        ? `${call.tool}（远程 MCP）`
        : describeResource(call.tool, call.args)
    // ⓪会话策略「只读」：写/删/未知类（MCP 工具副作用未知 = 按最高约束）一律拒；fs_read 不在此拦截
    if (this.policy === 'readonly' && action !== 'read') {
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
    // ②会话 grant 面（按工具）：命中走 decideBySessionPolicy 幂等落链
    if (this.grants.has(call.tool)) {
      this.authz.decideBySessionPolicy({
        authorizationId: `${this.sessionId}:policy:${call.tool}:${call.id}`,
        actor: 'user',
        capability,
        resource,
      })
      return true
    }
    // ③人审门（现行 S2 流程原样）
    const authorizationId = `${this.sessionId}:${this.currentTurnIdValue}:${call.tool}:${call.id}`
    let responded: AuthzResponse | null = null
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
        responded = await this.deps.waitAuthzDecision(this.sessionId, authorizationId)
        if (responded === 'session') this.grants.add(call.tool)
        return responded === 'once' || responded === 'session'
      },
    )
    // 内核 decideByUser 对「用户拒绝」与「超时」都记 EXPIRED/timeout——桌面以回调实答区分展示口径，
    // 链上记录以内核为真值（不旁路不改写）
    const outcome: AuthzResolvedPush['outcome'] =
      responded === 'once' || responded === 'session'
        ? 'approved'
        : responded === 'deny'
          ? 'denied'
          : responded === 'cancelled'
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
