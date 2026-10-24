/**
 * K2（1.16 子 Agent 最小闭环）：编排管理器 + 子 Agent 执行体（宿主侧组合，内核零加法）
 *
 * 口径（《1.16-K2-迭代规划》T-K2-1~4 / 《K1-评估报告》零加法结论）：
 *  - **编排三工具 = 宿主定义工具**挂父会话工具注册表（capability/attachment 宿主通道先例），
 *    EventKind 零新增——编排事件 = 父链 `system` + `payload.type='subagent/spawn|join|kill'`
 *    （session/recover 同款先例；system kind 恒进模型投影——模型对编排动作可见）；
 *  - **子链 = 平铺独立会话链**（Q-A1）：SessionLog + SessionFileStore 落同 sessionsDir，
 *    session-start 载荷带 parentSessionId/parentTurnId；`subagent_spawn` 对子面工具清单
 *    不可见（构造性主强子弱——首版禁再派生，白名单 = 只读 fs_read）；
 *  - **授权门归属父**：子 runTurn 的 authorize 代理回父授权编排（规则面/父会话策略/子
 *    grant 面/人审门同序），决策审计落**子链**（子 AuthzService 绑子链——先落日志后放行
 *    不回退）；人审弹窗在父（pending/resolved 推送携父 sessionId，requestId 内嵌子 id 路由）；
 *  - **护栏 fail-visible**：并发 ≤3 / 单父累计 ≤10（累计沿父链 spawn 事件计数——跨重启
 *    收敛）；超限 = spawn 工具结构化错误交回模型 + 父链 toolCall/toolResult 成对落痕，禁静默排队；
 *  - **停止级联**：杀父（abortTurn/close）= 全部活跃子链 abort（内核 runTurn 以 aborted
 *    收口——运行期取消，与 interrupted 恢复补记不混用）；在途人审即时取消；
 *  - **孤儿/恢复形态**（K1 POC 实证）：spawn 事件先落父链再建子链——崩溃于两者之间 =
 *    孤儿（父链恢复完整，宿主按子链缺失处理）；父 open 恢复时按载荷扫描枚举子链逐一
 *    recoverInterrupted（幂等由链内收敛保证）；断链子链 = 只读跳过，不影响父链恢复。
 */
import { randomBytes } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  AuthzService,
  SessionFileStore,
  SessionLog,
  loadSessionLog,
  recoverInterrupted,
  runTurn,
  type AuthzRequest,
} from '@lqc123qwe/car-runtime'
import { parseEventLine } from './model.ts'
import { fsReadTool } from './tools.ts'
import { assertSafeId } from './sessions.ts'
import { usageOver } from './session-handle.ts'
import type { HostModelFn, HostToolDef } from './types.ts'
import type { FileSecurityEngine } from './fileSecurity.ts'
import type { SessionPolicy } from './securitySettingsStore.ts'
import type { AuthzPendingPush, AuthzResolvedPush, SessionEventDTO } from '../shared/ipc-contract.ts'

/** Q-A3 定案护栏参数 */
export const SUBAGENT_MAX_CONCURRENT = 3
export const SUBAGENT_MAX_CUMULATIVE = 10
/** join 摘要回父上限（超限显性标注 truncated——工具结果面可见，非静默截断） */
export const SUBAGENT_SUMMARY_MAX_CHARS = 4000

/** 首版子面白名单 = 只读类（编排/凭据/写类一律不进子面——CI 反证断言见 test/k2-subagent.spec.ts） */
export const SUBAGENT_TOOL_WHITELIST: readonly string[] = ['fs_read']

export interface ChildModelFnOpts {
  log: SessionLog
  signal: { aborted: boolean }
  currentTurnId: () => string
  currentModel: () => string
  toolDefs: HostToolDef[]
}

export interface SubagentManagerDeps {
  parentSessionId: string
  workspaceId: string
  workspaceRoot: string
  sessionsDir: string
  authzTimeoutMs: number
  parentLog: SessionLog
  parentPolicy: () => SessionPolicy
  parentCurrentTurnId: () => string
  parentModel: () => string | null
  fileSecurity: FileSecurityEngine | null
  emitEvent: (sessionId: string, event: SessionEventDTO) => void
  emitAuthzPending: (p: AuthzPendingPush) => void
  emitAuthzResolved: (p: AuthzResolvedPush) => void
  waitAuthzDecision: (sessionId: string, requestId: string) => Promise<'once' | 'session' | 'deny' | 'cancelled'>
  makeChildModelFn: (o: ChildModelFnOpts) => HostModelFn
  /** 子会话索引登记（spawn 时落 title——列表面徽标/parent 列数据源） */
  registerChildSession: (sessionId: string, title: string) => void
}

export interface SubagentJoinResult {
  ok: true
  subagentId: string
  reason: string
  steps: number
  summary: string
  summaryTruncated?: boolean
}

interface ChildEntry {
  sessionId: string
  task: string
  model: string
  parentTurnId: string
  log: SessionLog
  store: SessionFileStore
  abort: { aborted: boolean }
  authz: AuthzService
  grants: Set<string>
  done: Promise<{ reason: string; steps: number }>
  settled: { reason: string; steps: number } | null
  joined: boolean
  usageSummarized: boolean
  /** store 关闭幂等标记（join 落完 usage / 句柄 close 级联——两路单点收敛） */
  closed: boolean
  /** 在途人审的取消出口（kill/级联 abort 时即时 cancelled——不放任等超时） */
  cancelAuthz: (() => void) | null
}

export class SubagentManager {
  private readonly children = new Map<string, ChildEntry>()
  private readonly whitelistDefs: HostToolDef[]
  private readonly deps: SubagentManagerDeps

  constructor(deps: SubagentManagerDeps) {
    this.deps = deps
    this.whitelistDefs = SUBAGENT_TOOL_WHITELIST.flatMap((name) => {
      if (name !== 'fs_read') {
        throw new Error(`CAR-E-SUBAGENT-WHITELIST: 白名单条目未接线（${name}）——子面工具定义缺失`)
      }
      return [fsReadTool(deps.workspaceRoot, deps.fileSecurity ?? undefined)]
    })
  }

  /** 编排三工具（挂父会话工具注册表——主面模型可见；子面构造性不可见） */
  tools(): HostToolDef[] {
    return [this.spawnTool(), this.joinTool(), this.killTool()]
  }

  // ── T-K2-3：护栏（fail-visible——结构化错误交回模型，父链成对落痕） ──

  /** 本会话累计派生数（父链 spawn 事件计数——append-only 链即真值，跨重启收敛） */
  cumulativeSpawns(): number {
    let n = 0
    for (const e of this.deps.parentLog.events) {
      if (e.kind !== 'system') continue
      if (((e.payload ?? {}) as Record<string, unknown>)['type'] === 'subagent/spawn') n++
    }
    return n
  }

  activeCount(): number {
    let n = 0
    for (const c of this.children.values()) if (!c.settled) n++
    return n
  }

  // ── T-K2-1：编排动作（父链编排事件 + 子链生命周期） ──

  spawn(task: string, id?: string): { ok: true; subagentId: string; state: 'running'; note: string } {
    const active = this.activeCount()
    if (active >= SUBAGENT_MAX_CONCURRENT) {
      throw new Error(`CAR-E-SUBAGENT-CONC: 并发子 Agent 超上限（${active} ≥ ${SUBAGENT_MAX_CONCURRENT}）——护栏 fail-visible，禁静默排队`)
    }
    const cumulative = this.cumulativeSpawns()
    if (cumulative >= SUBAGENT_MAX_CUMULATIVE) {
      throw new Error(`CAR-E-SUBAGENT-CUM: 本会话累计派生子 Agent 超上限（${cumulative} ≥ ${SUBAGENT_MAX_CUMULATIVE}）——护栏 fail-visible，禁静默排队`)
    }
    const model = this.deps.parentModel()
    if (!model) {
      throw new Error('CAR-E-SUBAGENT-MODEL: 父会话模型锚点缺失——子 Agent 继承父锚点（Q-A2），无法派生')
    }
    const subagentId = id ?? 'SA-' + Date.now().toString(36) + '-' + randomBytes(2).toString('hex')
    assertSafeId('会话', subagentId)
    if (this.children.has(subagentId)) {
      throw new Error(`CAR-E-SUBAGENT-DUP: 子 Agent id 已存在（${subagentId}）`)
    }
    // R-K2-2：磁盘存在性守卫——children map 仅本进程本会话；跨会话/跨运行复用同 id 会对既有
    // JSONL 以重启 seq 追加（哈希链破坏——审计红线）。链文件已存在 = fail-visible 拒绝，禁覆盖。
    if (existsSync(join(this.deps.sessionsDir, subagentId + '.jsonl'))) {
      throw new Error(`CAR-E-SUBAGENT-DUP: 子链文件已存在（${subagentId}.jsonl）——id 与历史子链冲突，换 id 重试（追加会破坏既有哈希链）`)
    }
    const turnId = this.deps.parentCurrentTurnId()
    // 父链编排事件先落（K1 孤儿形态口径：spawn 声明先于子链创建——崩溃于两者之间 = 孤儿可恢复）
    this.deps.parentLog.append('runtime', 'system', turnId, {
      type: 'subagent/spawn',
      subagentId,
      parentTurnId: turnId,
      task,
      model,
      guards: { maxConcurrent: SUBAGENT_MAX_CONCURRENT, maxCumulative: SUBAGENT_MAX_CUMULATIVE, active: active + 1, cumulative: cumulative + 1 },
      whitelist: [...SUBAGENT_TOOL_WHITELIST],
    })
    const log = new SessionLog(subagentId)
    const store = new SessionFileStore(join(this.deps.sessionsDir, subagentId + '.jsonl'))
    log.attachSink((line) => {
      store.append(line)
      this.deps.emitEvent(subagentId, parseEventLine(line))
    })
    log.append('runtime', 'system', 'session', {
      type: 'session-start',
      workspaceId: this.deps.workspaceId,
      parentSessionId: this.deps.parentSessionId,
      parentTurnId: turnId,
      task,
      model,
      whitelist: [...SUBAGENT_TOOL_WHITELIST],
    })
    log.append('user', 'user', 'T1', task)
    const child: ChildEntry = {
      sessionId: subagentId,
      task,
      model,
      parentTurnId: turnId,
      log,
      store,
      abort: { aborted: false },
      authz: new AuthzService({ log, timeoutMs: this.deps.authzTimeoutMs }),
      grants: new Set(),
      done: Promise.resolve({ reason: '', steps: 0 }),
      settled: null,
      joined: false,
      usageSummarized: false,
      closed: false,
      cancelAuthz: null,
    }
    const childModelFn = this.deps.makeChildModelFn({
      log,
      signal: child.abort,
      currentTurnId: () => 'T1',
      currentModel: () => child.model,
      toolDefs: this.whitelistDefs,
    })
    const tools = new Map(this.whitelistDefs.map((t) => [t.name, t]))
    child.done = runTurn({
      log,
      turnId: 'T1',
      model: childModelFn,
      tools,
      preset: { mode: 'confirm', authorizeAll: true, authorize: this.childAuthorize(child) },
      signal: child.abort,
    }).then(
      (r) => {
        child.settled = { reason: r.reason, steps: r.steps }
        return child.settled
      },
      (err) => {
        child.settled = { reason: 'error', steps: 0 }
        console.error(`[host] 子 Agent ${subagentId} 异常（内核已收口或落盘失败）：`, err instanceof Error ? err.message : err)
        return child.settled
      },
    )
    this.children.set(subagentId, child)
    this.deps.registerChildSession(subagentId, `子 Agent · ${task.slice(0, 24)}`)
    return { ok: true, subagentId, state: 'running', note: '子 Agent 并发运行中——用 subagent_join 汇合取结论（阻塞至收口）' }
  }

  async join(subagentId: string): Promise<SubagentJoinResult> {
    const child = this.children.get(subagentId)
    if (!child) throw new Error(`CAR-E-SUBAGENT-UNKNOWN: 子 Agent 不存在（${subagentId}）——本进程未派生或已跨运行`)
    if (child.joined) throw new Error(`CAR-E-SUBAGENT-JOINED: 子 Agent 已汇合（${subagentId}）——结论已在上下文，禁重复汇合`)
    const r = await child.done
    const raw = child.log.events
      .filter((e) => e.kind === 'assistant' && typeof e.payload === 'string')
      .map((e) => e.payload as string)
      .join('\n\n')
    const summaryTruncated = raw.length > SUBAGENT_SUMMARY_MAX_CHARS
    const summary = summaryTruncated ? raw.slice(0, SUBAGENT_SUMMARY_MAX_CHARS) + '…（超长截断，全文见子链）' : raw
    // 子链 usage 汇总事件随 join 落子链（system kind + type 标识——usage kind 会致 usageOver 双计，
    // 计量红线禁重复事实；parentTurnId 归因面）
    if (!child.usageSummarized) {
      const u = usageOver(child.log.events as unknown as readonly SessionEventDTO[])
      child.log.append('runtime', 'system', 'T1', {
        type: 'subagent/usage',
        parentSessionId: this.deps.parentSessionId,
        parentTurnId: child.parentTurnId,
        input: u.input,
        output: u.output,
        cacheRead: u.cacheRead,
        cacheCreation: u.cacheCreation,
        requests: u.requests,
      })
      child.usageSummarized = true
    }
    // usage 落子链后单点关 store（join 后子链不再有写面——closed 标记幂等）
    this.closeChildStore(child)
    this.deps.parentLog.append('runtime', 'system', this.deps.parentCurrentTurnId(), {
      type: 'subagent/join',
      subagentId,
      reason: r.reason,
      steps: r.steps,
      summaryChars: summary.length,
    })
    child.joined = true
    return { ok: true, subagentId, reason: r.reason, steps: r.steps, summary, ...(summaryTruncated ? { summaryTruncated: true } : {}) }
  }

  kill(subagentId: string): { ok: true; subagentId: string; note: string } {
    const child = this.children.get(subagentId)
    if (!child) throw new Error(`CAR-E-SUBAGENT-UNKNOWN: 子 Agent 不存在（${subagentId}）`)
    if (child.settled) {
      throw new Error(`CAR-E-SUBAGENT-KILL-STATE: 子 Agent 已收口（${subagentId} reason=${child.settled.reason}）——无需终止`)
    }
    child.abort.aborted = true
    child.cancelAuthz?.()
    this.deps.parentLog.append('runtime', 'system', this.deps.parentCurrentTurnId(), {
      type: 'subagent/kill',
      subagentId,
      reason: 'user/model requested kill',
    })
    return { ok: true, subagentId, note: '已发终止信号——子链以 aborted 收口（运行期取消，与 interrupted 补记不混用）' }
  }

  /** T-K2-4：杀父级联——全部活跃子链 abort + 在途人审即时取消 */
  abortAll(): void {
    for (const c of this.children.values()) {
      if (c.settled) continue
      c.abort.aborted = true
      c.cancelAuthz?.()
    }
  }

  /** T-K2-4：句柄 close 级联收口——abort 全部活跃子链 + 子链 store 关闭（与父 close 同口径） */
  closeAll(): void {
    for (const c of this.children.values()) {
      c.abort.aborted = true
      c.cancelAuthz?.()
      this.closeChildStore(c)
    }
  }

  private closeChildStore(child: ChildEntry): void {
    if (child.closed) return
    child.closed = true
    child.store.close()
  }

  // ── T-K2-2：子链授权门（代理父授权编排；决策审计落子链） ──

  private childAuthorize(child: ChildEntry): (call: { id: string; tool: string; args: Record<string, unknown> }) => Promise<boolean> {
    return async (call) => {
      const capability: AuthzRequest['capability'] = 'fs-read'
      const resource =
        typeof call.args['path'] === 'string'
          ? String(call.args['path'])
          : JSON.stringify(call.args).slice(0, 120)
      // ① 规则面（读轴——与父 fs_read 同口径；deny/fallback-outside 直判落子链）
      if (this.deps.fileSecurity) {
        const d = this.deps.fileSecurity.decide('read', call.args['path'], this.deps.workspaceRoot)
        const ruleReq = {
          authorizationId: `${child.sessionId}:rule:${call.tool}:${call.id}`,
          actor: 'user' as const,
          capability,
          resource: d.target,
        }
        if (d.tier === 'allow') {
          child.authz.decideByRule(ruleReq, { decision: 'APPROVED', reason: `file-rule:${d.rule!.id} allow read` })
          return true
        }
        if (d.tier === 'deny') {
          child.authz.decideByRule(ruleReq, {
            decision: 'DENIED',
            reason: d.rule ? `file-rule:${d.rule.id} deny read` : `file-arg:missing-path deny read`,
          })
          return false
        }
        if (d.tier === 'fallback-outside') {
          child.authz.decideByRule(ruleReq, {
            decision: 'DENIED',
            reason: 'file-fallback:outside-workspace deny read (现行沙盒语义——未命中规则不放宽)',
          })
          return false
        }
        // 'ask' | 'fallback-inside' → 落入父策略/子 grant 面/人审门
      }
      // ①′ 父会话策略「会话内放行」（后置于规则面——拒绝红线先决）；只读策略不拦读取（父 ⓪ 同口径）
      if (this.deps.parentPolicy() === 'session') {
        child.authz.decideBySessionPolicy({
          authorizationId: `${child.sessionId}:policy-session:${call.tool}:${call.id}`,
          actor: 'user',
          capability,
          resource,
        })
        return true
      }
      // ② 子会话 grant 面（三档 session 批准写 grant——子会话内幂等）
      if (child.grants.has(call.tool)) {
        child.authz.decideBySessionPolicy({
          authorizationId: `${child.sessionId}:policy:${call.tool}:${call.id}`,
          actor: 'user',
          capability,
          resource,
        })
        return true
      }
      // ③ 人审门：弹窗在父（pending 携父 sessionId）、决策审计落子链（子 authz #commit 绑子链）
      const authorizationId = `${child.sessionId}:T1:${call.tool}:${call.id}`
      let responded: 'once' | 'session' | 'deny' | 'cancelled' | null = null
      const decision = await child.authz.decideByUser(
        { authorizationId, actor: 'user', capability, resource },
        async () => {
          this.deps.emitAuthzPending({
            kind: 'pending',
            workspaceId: this.deps.workspaceId,
            sessionId: this.deps.parentSessionId,
            requestId: authorizationId,
            tool: call.tool,
            capability,
            resource,
            timeoutMs: this.deps.authzTimeoutMs,
            ts: Date.now(),
          })
          responded = await Promise.race([
            this.deps.waitAuthzDecision(child.sessionId, authorizationId),
            new Promise<'cancelled'>((resolve) => {
              child.cancelAuthz = () => resolve('cancelled')
            }),
          ])
          child.cancelAuthz = null
          if (responded === 'session') child.grants.add(call.tool)
          return responded === 'once' || responded === 'session'
        },
      )
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
        workspaceId: this.deps.workspaceId,
        sessionId: this.deps.parentSessionId,
        requestId: authorizationId,
        outcome,
        decidedBy: outcome === 'approved' ? 'user' : outcome === 'cancelled' ? 'host' : 'timeout',
      })
      return decision.decision === 'APPROVED'
    }
  }

  // ── 编排三工具定义（HostToolDef；declaredSideEffect='readonly'——编排动作自身不改
  //    工作区文件；父面 authorizeAll=true 使其仍过授权门，审计「凭什么派生」可回答） ──

  private spawnTool(): HostToolDef {
    return {
      name: 'subagent_spawn',
      declaredSideEffect: 'readonly',
      description:
        '派生子 Agent 并发执行只读调研任务（工具面仅 fs_read；护栏：并发 ≤3、单会话累计 ≤10）。' +
        '参数：task（任务描述）、id?（可选引用 id，缺省自动生成）。派生后立即返回不阻塞——用 subagent_join 汇合取结论。',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: '子 Agent 要完成的任务（自包含——子链独立上下文，看不到本会话历史）' },
          id: { type: 'string', description: '可选引用 id（join/kill 时定位；缺省自动生成）' },
        },
        required: ['task'],
      },
      run: async (args) => {
        const task = args['task']
        if (typeof task !== 'string' || task.length === 0) {
          throw new Error('CAR-E-SUBAGENT-ARGS: subagent_spawn 缺少 task（string）')
        }
        const id = typeof args['id'] === 'string' && args['id'].length ? String(args['id']) : undefined
        return this.spawn(task, id)
      },
    }
  }

  private joinTool(): HostToolDef {
    return {
      name: 'subagent_join',
      declaredSideEffect: 'readonly',
      description: '汇合指定子 Agent：等待其收口并返回结论摘要（阻塞至收口）。参数：id（spawn 返回的引用 id）。',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: '子 Agent 引用 id' } },
        required: ['id'],
      },
      run: async (args) => {
        const id = args['id']
        if (typeof id !== 'string' || id.length === 0) {
          throw new Error('CAR-E-SUBAGENT-ARGS: subagent_join 缺少 id（string）')
        }
        return this.join(id)
      },
    }
  }

  private killTool(): HostToolDef {
    return {
      name: 'subagent_kill',
      declaredSideEffect: 'readonly',
      description: '终止指定子 Agent（子链以 aborted 收口）。参数：id（spawn 返回的引用 id）。',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: '子 Agent 引用 id' } },
        required: ['id'],
      },
      run: async (args) => {
        const id = args['id']
        if (typeof id !== 'string' || id.length === 0) {
          throw new Error('CAR-E-SUBAGENT-ARGS: subagent_kill 缺少 id（string）')
        }
        return this.kill(id)
      },
    }
  }
}

// ── T-K2-4：子链枚举/恢复/删除级联（宿主索引职责——K1 §1② 零内核扩展结论） ──

function sessionStartParentOf(file: string): string | null {
  const loaded = loadSessionLog(file)
  for (const e of loaded.log.events) {
    if (e.kind !== 'system') continue
    const p = (e.payload ?? {}) as Record<string, unknown>
    if (p['type'] === 'session-start' && typeof p['parentSessionId'] === 'string') return p['parentSessionId']
    return null
  }
  return null
}

/** 枚举指定父会话的全部子链 id（按 session-start 载荷扫描——链即真值，无旁路索引） */
export function childSessionIds(sessionsDir: string, parentSessionId: string): string[] {
  if (!existsSync(sessionsDir)) return []
  const out: string[] = []
  for (const f of readdirSync(sessionsDir)) {
    if (!f.endsWith('.jsonl')) continue
    const file = join(sessionsDir, f)
    try {
      if (sessionStartParentOf(file) === parentSessionId) out.push(f.slice(0, -'.jsonl'.length))
    } catch {
      // 单链解析失败不阻塞枚举（断链/损坏子链另行只读处理）
    }
  }
  return out
}

export interface ChildRecoveryReport {
  /** 补记 interrupted 的子链数 */
  recovered: number
  /** 断链跳过（只读回放）的子链数 */
  broken: number
}

/**
 * 父会话 open 恢复：子链逐一 recoverInterrupted（K1 POC 形态转正式实现）。
 * 幂等由链内收敛保证（turnEnd 已落即 closed）；补记经临时 store 落盘（子链重启后只读
 * 回放形态——不建常驻句柄）；断链子链只读跳过，不影响父链恢复。
 */
export function recoverChildSessions(sessionsDir: string, parentSessionId: string): ChildRecoveryReport {
  const report: ChildRecoveryReport = { recovered: 0, broken: 0 }
  if (!existsSync(sessionsDir)) return report
  for (const f of readdirSync(sessionsDir)) {
    if (!f.endsWith('.jsonl')) continue
    const file = join(sessionsDir, f)
    let parent: string | null
    try {
      parent = sessionStartParentOf(file)
    } catch {
      continue
    }
    if (parent !== parentSessionId) continue
    const loaded = loadSessionLog(file)
    if (loaded.brokenAt !== null) {
      report.broken++
      console.error(`[host] 子链断链（${f} brokenAt seq=${loaded.brokenAt}）——只读回放，不恢复`)
      continue
    }
    const store = new SessionFileStore(file)
    loaded.log.attachSink((line) => store.append(line))
    const rec = recoverInterrupted(loaded.log)
    store.close()
    if (rec.turnsClosed > 0 || rec.pairedCalls > 0) {
      report.recovered++
      console.error(`[host] 子链恢复补记（${f}）：interrupted turn ×${rec.turnsClosed}、合成 toolResult ×${rec.pairedCalls}`)
    }
  }
  return report
}
