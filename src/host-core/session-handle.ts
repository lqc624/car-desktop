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
import { runTurn, SessionFileStore, SessionLog, AuthzService, type AuthzRequest } from '@lqc123qwe/car-runtime'
import type { AuthzPendingPush, AuthzResolvedPush, SessionEventDTO, SessionUsageResult } from '../shared/ipc-contract.ts'
import { parseEventLine } from './model.ts'
import { builtinTools, fileActionOf } from './tools.ts'
import type { FileSecurityEngine } from './fileSecurity.ts'
import type { BackupStore } from './backupStore.ts'
import type { SecuritySettings, SessionPolicy } from './securitySettingsStore.ts'
import type { HostModelFn, HostToolDef } from './types.ts'

export type AuthzResponse = 'once' | 'session' | 'deny' | 'cancelled'

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

  private readonly store: SessionFileStore
  private readonly authz: AuthzService
  private readonly fileSecurity: FileSecurityEngine | null
  private readonly grants = new Set<string>()
  private readonly tools: HostToolDef[]
  private modelFn: HostModelFn | null = null
  private readonly waiters = new Map<string, (d: AuthzResponse) => void>()
  private turnSeq = 0
  private currentTurnIdValue = ''
  private readonly deps: SessionHandleDeps

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
    this.tools = builtinTools(
      init.workspaceRoot,
      init.deps.fileSecurity,
      init.deps.backup ? { store: init.deps.backup, ctx: { workspaceId: init.workspaceId, sessionId: init.sessionId } } : undefined,
    )
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
   */
  static resume(init: HandleInit, log: SessionLog): SessionHandle {
    let maxTurn = 0
    for (const e of log.events) {
      const m = /^T(\d+)$/.exec(e.turnId)
      if (m) maxTurn = Math.max(maxTurn, Number(m[1]))
    }
    return new SessionHandle(init, { log, turnSeq: maxTurn })
  }

  /** 生产装配（service 调用）：chatStep 模型回调或测试覆盖 */
  attachModelFn(fn: HostModelFn): void {
    this.modelFn = fn
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

  /** 已知事件全集（本会话生于本进程，内存即全量；usage/回放共用） */
  knownEvents(): readonly SessionEventDTO[] {
    return this.log.events as unknown as readonly SessionEventDTO[]
  }

  sendTurn(text: string): { turnId: string } {
    if (this.busy) throw new Error('CAR-E-DESKTOP: 上一 turn 仍在进行（停止或等待收口后再发）')
    if (!this.modelFn) {
      throw new Error(
        'CAR-E-LLM-CONFIG: 模型回调未装配——需要 car.config llm（baseUrl+model）与凭据' +
          '（OPENAI_API_KEY / ANTHROPIC_API_KEY；env 兜底需 CAR_ALLOW_ENV_CREDENTIALS=1——' +
          '内核适配器 resolve 未透传 llm.allowEnvFallback，接线缺口已登记）',
      )
    }
    this.busy = true
    this.abort.aborted = false
    const turnId = 'T' + String(++this.turnSeq)
    this.currentTurnIdValue = turnId
    this.log.append('user', 'user', turnId, text)
    const tools = new Map<string, HostToolDef>(this.tools.map((t) => [t.name, t]))
    // 内核 runTurn 自带全部收口语义（error/aborted/成对补记/turnEnd usage 聚合）——
    // 桌面 catch 仅宿主日志，禁补造任何链上事件。
    // authorizeAll（K-FS-1，1.13.0）：readonly 类（fs_read）同样进授权门——读取规则面可达
    const turnPreset = { mode: 'confirm', authorizeAll: true, authorize: this.authorize } as const
    void runTurn({
      log: this.log,
      turnId,
      model: this.modelFn,
      tools,
      preset: turnPreset,
      signal: this.abort,
    }).then(
      (r) => {
        this.busy = false
        return r
      },
      (err) => {
        this.busy = false
        console.error(`[host] turn ${turnId} 异常（内核已收口）：`, err instanceof Error ? err.message : err)
      },
    )
    return { turnId }
  }

  abortTurn(): void {
    this.abort.aborted = true
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
    const capability: AuthzRequest['capability'] =
      call.tool === 'fs_read' ? 'fs-read' : call.tool === 'fs_delete' ? 'fs-delete' : 'fs-write'
    const resource = action && typeof call.args['path'] === 'string' ? String(call.args['path']) : describeResource(call.tool, call.args)
    // ⓪会话策略「只读」：写/删（及未知工具——最高约束）一律拒；读取不在此拦截
    if (this.policy === 'readonly' && action !== 'read') {
      this.authz.decideByRule(
        { authorizationId: `${this.sessionId}:policy-ro:${call.tool}:${call.id}`, actor: 'user', capability, resource },
        { decision: 'DENIED', reason: `session-policy:readonly deny ${action ?? call.tool}` },
      )
      return false
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
  for (const e of events) {
    if (e.kind === 'turnEnd' && !e.turnId.startsWith('authz:')) turns++
    if (e.kind !== 'usage') continue
    const p = (e.payload ?? {}) as Record<string, unknown>
    const n = (k: string): number => (typeof p[k] === 'number' ? (p[k] as number) : 0)
    input += n('input')
    output += n('output')
    cacheRead += n('cacheRead')
    cacheCreation += n('cacheCreation')
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
    coverage: turns > 0 ? usageTurns.size / turns : null,
  }
}

function describeResource(tool: string, args: Record<string, unknown>): string {
  if (fileActionOf(tool) && typeof args['path'] === 'string') return String(args['path'])
  return JSON.stringify(args).slice(0, 120)
}
