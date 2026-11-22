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
 *    K3（D-K2-2，内核 1.16.0）：上限可经 `car.config llm.subagent.maxConcurrent/maxCumulative`
 *    配置——缺省回落 Q-A3 常量（无键 = 行为与 K2 逐字节一致）；模型锚点
 *    `llm.subagent.model` 覆盖继承（池/端点覆盖激活时被压过——service 层裁决，与 llm.model 同口径）；
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
  bindReplToTool,
  createPtcRepl,
  loadSessionLog,
  recoverInterrupted,
  runTurn,
  type AuthzRequest,
  type PtcReplHandle,
  type SubagentConfig,
} from '@lqc123qwe/car-runtime'
import { parseEventLine } from './model.ts'
import { fsReadTool } from './tools.ts'
import { shotReadTool } from './evidence.ts'
import { parseVisualVerdict, type VisualVerdict } from './visual-verdict.ts'
import { assertSafeId } from './sessions.ts'
import { resolveSubagentType } from './subagentTypes.ts'
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
  /** 1.19.0：子链会话 id（流式增量推送归组用——缺省 = 不推增量） */
  sessionId?: string
}

export interface SubagentManagerDeps {
  parentSessionId: string
  workspaceId: string
  workspaceRoot: string
  sessionsDir: string
  /** B-3（D-VB3-1）：userData 目录（shot_read 受管证据读面——visual 判定档子面装配前提） */
  userDataDir: string
  authzTimeoutMs: number
  parentLog: SessionLog
  parentPolicy: () => SessionPolicy
  parentCurrentTurnId: () => string
  parentModel: () => string | null
  /** WB-2P：纪律面继承（spawn 注入子链首轮——指令 + 长期记忆 enabled 条目；称呼/人格/风格
   *  不继承——子代理不直接面对用户。service 注入即时渲染闭包（实时跟随同源）；缺省 = 零注入） */
  discipline?: () => string
  /** K3（D-K2-2 / 内核 1.16.0）：car.config `llm.subagent` 三键——model 覆盖（池/端点压过由 service 裁决后传 undefined）/ 护栏上限（缺省 = Q-A3 常量） */
  subagent?: SubagentConfig
  fileSecurity: FileSecurityEngine | null
  emitEvent: (sessionId: string, event: SessionEventDTO) => void
  emitAuthzPending: (p: AuthzPendingPush) => void
  emitAuthzResolved: (p: AuthzResolvedPush) => void
  /** 0.12.0（D-V12-3）：附注随决策返回（对象形态——内核 1.25.1 落链） */
  waitAuthzDecision: (sessionId: string, requestId: string) => Promise<{ response: 'once' | 'session' | 'deny' | 'cancelled'; note?: string }>
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
  /** B-3（D-VB3-1 / §4.8）：visual 判定档——verdict 即视觉门结果（主面禁复判）；判定 fail ≠ 工具执行 fail */
  verdict?: VisualVerdict
  /** visual 型末条 assistant 未按契约解析（fail-visible 呈现——叙事 warn + 本键标注，禁静默吞） */
  verdictUnparsed?: true
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
  /** 0.14.0（Z-3 / D-QD1-2）：ptc 型专属——持久 REPL（release = join/kill/abort 三路 + closeAll 兜底） */
  repl: PtcReplHandle | null
  /** 类型声明档 id（spawn 叙事/行面呈现——缺省 readonly） */
  type: string
}

export class SubagentManager {
  private readonly children = new Map<string, ChildEntry>()
  private readonly whitelistDefs: HostToolDef[]
  private readonly deps: SubagentManagerDeps

  /** 护栏生效上限（K3：config 覆盖 > Q-A3 常量缺省——无键 = 行为与 K2 逐字节一致） */
  private get maxConcurrent(): number {
    return this.deps.subagent?.maxConcurrent ?? SUBAGENT_MAX_CONCURRENT
  }

  private get maxCumulative(): number {
    return this.deps.subagent?.maxCumulative ?? SUBAGENT_MAX_CUMULATIVE
  }

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

  spawn(task: string, id?: string, type?: string): { ok: true; subagentId: string; state: 'running'; note: string } {
    // 0.14.0（Z-3 / D-QD1-1）：类型声明档——缺省 readonly（现行为零变化）；未知 id fail-visible
    const spec = resolveSubagentType(type)
    const active = this.activeCount()
    if (active >= this.maxConcurrent) {
      throw new Error(`CAR-E-SUBAGENT-CONC: 并发子 Agent 超上限（${active} ≥ ${this.maxConcurrent}）——护栏 fail-visible，禁静默排队`)
    }
    const cumulative = this.cumulativeSpawns()
    if (cumulative >= this.maxCumulative) {
      throw new Error(`CAR-E-SUBAGENT-CUM: 本会话累计派生子 Agent 超上限（${cumulative} ≥ ${this.maxCumulative}）——护栏 fail-visible，禁静默排队`)
    }
    // K3（D-K2-2）：config 覆盖锚点 > 继承父现值（Q-A2）——service 层已在池/端点覆盖激活时置 undefined
    const model = this.deps.subagent?.model ?? this.deps.parentModel()
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
      ...(spec.id !== 'readonly' ? { subagentType: spec.id } : {}),
      guards: { maxConcurrent: this.maxConcurrent, maxCumulative: this.maxCumulative, active: active + 1, cumulative: cumulative + 1 },
      whitelist: [...spec.toolface],
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
      ...(spec.id !== 'readonly' ? { subagentType: spec.id } : {}),
      whitelist: [...spec.toolface],
    })
    log.append('user', 'user', 'T1', task)
    // WB-2P（用户裁决 2026-11-22）：纪律面继承——指令 + 长期记忆（enabled 条目）以 system 事件
    // 落子链（注入必落链纪律；紧邻任务上下文）。双源皆空 = 零注入零落链。
    const discipline = this.deps.discipline?.() ?? ''
    if (discipline) {
      log.append('user', 'system', 'T1', discipline, { injection: 'discipline', chars: discipline.length })
    }
    // 0.14.0（Z-3 / D-QD1-1）：类型声明档装配——spec.toolface → 子面 defs（fs_read 直挂；run_code =
    // bindReplToTool(REPL 实例)）。装配序：child 先建（authz/log 真值）→ ptc 型挂 REPL → runTurn。
    const specDefs: HostToolDef[] = []
    for (const name of spec.toolface) {
      if (name === 'fs_read') {
        specDefs.push(fsReadTool(this.deps.workspaceRoot, this.deps.fileSecurity ?? undefined))
      } else if (name === 'run_code') {
        // run_code 定义延后（child 建好后绑 REPL 实例——见下）
      } else if (name === 'shot_read') {
        // B-3（D-VB3-1）：visual 判定档——受管证据读面（userData/browser-shots；父面不注册，
        // 禁自看图复判的 toolface 级 enforcement）
        specDefs.push(shotReadTool(this.deps.userDataDir))
      } else {
        throw new Error(`CAR-E-SUBAGENT-WHITELIST: 白名单条目未接线（${name}）——子面工具定义缺失`)
      }
    }
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
      repl: null,
      type: spec.id,
    }
    if (spec.id === 'ptc') {
      // 0.14.0（D-QD1-2）：ptc 型专属持久 REPL——生命周期 = spawn 创建 → join/kill/abort 三路 release
      // + closeAll 兜底（D-QD1-8）；REPL 程序内子调用逐次过门（D-QD1-5：bridge 重入 childAuthorize
      // 全编排链——规则面/人审门弹卡父会话与 bash 同形态，审计落子链）
      const repl = createPtcRepl({
        tools: new Map(
          specDefs.map((d) => [d.name, { run: async (args: unknown) => {
            const ok = await this.childAuthorize(child)({ id: 'br-' + Math.random().toString(36).slice(2), tool: d.name, args: (args ?? {}) as Record<string, unknown> })
            if (!ok) throw new Error('authorization-denied (ptc bridge)——程序内子调用授权拒绝落审计')
            return d.run((args ?? {}) as Record<string, unknown>)
          } }]),
        ),
        audit: (d) => log.append('runtime', 'system', 'T1', { type: 'ptc/' + d['kind'], ...d }),
      })
      child.repl = repl
      specDefs.push({
        name: 'run_code',
        declaredSideEffect: 'write',
        description: '执行一段 erasable TS 程序（持久 REPL——跨调用绑定续写；inspect-only 输出契约：用打印显式输出，末表达式丢弃）。参数：code + description 双必填。',
        run: bindReplToTool(repl).run,
      })
    }
    const childModelFn = this.deps.makeChildModelFn({
      log,
      signal: child.abort,
      currentTurnId: () => 'T1',
      currentModel: () => child.model,
      toolDefs: specDefs,
      sessionId: subagentId,
    })
    const tools = new Map(specDefs.map((t) => [t.name, t]))
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
    // B-3（D-VB3-1 / §4.8 判据化协议）：visual 判定档——末条 assistant 按 verdict 契约解析。
    // 解析失败 = verdictUnparsed（fail-visible：叙事 warn + toolResult 标注，禁静默吞）；
    // 判定 fail ≠ 工具执行 fail（两态分立——toolResult 仍 ok:true，行面 warn 呈现）。
    let verdict: VisualVerdict | null = null
    let verdictUnparsed = false
    if (child.type === 'visual') {
      const lastAssistant = [...child.log.events].reverse().find((e) => e.kind === 'assistant' && typeof e.payload === 'string')
      verdict = parseVisualVerdict(typeof lastAssistant?.payload === 'string' ? lastAssistant.payload : undefined)
      verdictUnparsed = verdict === null
    }
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
    // B-3：visual 判定档 verdict 随父链叙事落链（§4.8「verdict 落链」——payload.type 先例，
    // EventKind 零新增；subagent/join 形态字节兼容不动，verdict 走独立 browser/verdict 事件）
    if (child.type === 'visual') {
      const passCount = verdict ? verdict.pages.filter((p) => p.verdict === 'pass').length : 0
      const failCount = verdict ? verdict.pages.length - passCount : 0
      this.deps.parentLog.append('runtime', 'system', this.deps.parentCurrentTurnId(), {
        type: 'browser/verdict',
        subagentId,
        ...(verdict
          ? {
              passCount,
              failCount,
              pages: verdict.pages.map((p) => ({ shotId: p.shotId, verdict: p.verdict, issues: p.issues ?? [] })),
              ...(verdict.summary ? { summary: verdict.summary } : {}),
            }
          : {}),
        ...(verdictUnparsed ? { verdictUnparsed: true } : {}),
      })
    }
    child.joined = true
    return {
      ok: true,
      subagentId,
      reason: r.reason,
      steps: r.steps,
      summary,
      ...(summaryTruncated ? { summaryTruncated: true } : {}),
      ...(verdict ? { verdict } : {}),
      ...(verdictUnparsed ? { verdictUnparsed: true } : {}),
    }
  }

  kill(subagentId: string): { ok: true; subagentId: string; note: string } {
    const child = this.children.get(subagentId)
    if (!child) throw new Error(`CAR-E-SUBAGENT-UNKNOWN: 子 Agent 不存在（${subagentId}）`)
    if (child.settled) {
      throw new Error(`CAR-E-SUBAGENT-KILL-STATE: 子 Agent 已收口（${subagentId} reason=${child.settled.reason}）——无需终止`)
    }
    child.abort.aborted = true
    child.cancelAuthz?.()
    child.repl?.release() // 0.14.0（D-QD1-8）：kill 即时 release（不等收口——REPL 状态随终止销毁）
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
      c.repl?.release() // 0.14.0（D-QD1-8）：级联 abort 释放 ptc REPL
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
    // 0.14.0（D-QD1-8）：ptc 型 REPL release（join/级联 close 路径单点收敛）
    child.repl?.release()
  }

  // ── T-K2-2：子链授权门（代理父授权编排；决策审计落子链） ──

  private childAuthorize(child: ChildEntry): (call: { id: string; tool: string; args: Record<string, unknown> }) => Promise<boolean> {
    return async (call) => {
      // ⓪⁼（0.16.0 / B-3 / D-VB3-1）：shot_read——受管证据读面直判（visual 判定档专属工具；
      // userData/browser-shots 不经 fileSecurity 规则——出厂 deny 面针对模型 fs 通用面，
      // 证据读面为受管交接形态〔fileviewer_get_view 同款〕；redact 在工具 run 内承担）
      if (call.tool === 'shot_read') {
        child.authz.decideByRule(
          { authorizationId: `${child.sessionId}:ro-tool:${call.tool}:${call.id}`, actor: 'user', capability: 'fs-read', resource: 'browser-shots（userData/browser-shots 受管证据）' },
          { decision: 'APPROVED', reason: 'ro-toolface auto-approve（shot_read——visual 判定档受管证据读面）' },
        )
        return true
      }
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
      // 0.12.0（D-V12-3）：waitAuthzDecision 对象形态 { response, note? }——附注随子链决策落链（内核 1.25.1）；
      // holder 形态（闭包 let 变量的 CFA 窄化在 decideByUser await 边界会把外层读点判成 never——属性读不受影响）
      const authorizationId = `${child.sessionId}:T1:${call.tool}:${call.id}`
      const answered: { v: { response: 'once' | 'session' | 'deny' | 'cancelled'; note?: string } | null } = { v: null }
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
          answered.v = await Promise.race([
            this.deps.waitAuthzDecision(child.sessionId, authorizationId),
            new Promise<{ response: 'cancelled' }>((resolve) => {
              child.cancelAuthz = () => resolve({ response: 'cancelled' })
            }),
          ])
          child.cancelAuthz = null
          if (answered.v?.response === 'session') child.grants.add(call.tool)
          return {
            approve: answered.v?.response === 'once' || answered.v?.response === 'session',
            ...(typeof answered.v?.note === 'string' && answered.v.note.trim() ? { note: answered.v.note.trim().slice(0, 500) } : {}),
          }
        },
      )
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
          type: { type: 'string', description: '可选类型声明档（0.14.0：readonly=只读扇出缺省档 / ptc=程序化工具调用持久 REPL；0.16.0：visual=视觉验收判定面〔shot_read 证据读面——判据写在 task、末条输出逐页 JSON verdict〕。未知类型 fail-visible）' },
        },
        required: ['task'],
      },
      run: async (args) => {
        const task = args['task']
        if (typeof task !== 'string' || task.length === 0) {
          throw new Error('CAR-E-SUBAGENT-ARGS: subagent_spawn 缺少 task（string）')
        }
        const id = typeof args['id'] === 'string' && args['id'].length ? String(args['id']) : undefined
        const type = typeof args['type'] === 'string' && args['type'].length ? String(args['type']) : undefined
        return this.spawn(task, id, type)
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
