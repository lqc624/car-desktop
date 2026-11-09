/**
 * 记忆进化（T-ME / 原型「记忆与进化」进化主体）共享面：类型 + 压力确定性派生 + 链事件派生。
 * 双侧共用（宿主进化核与渲染层 MemoryView），零内核依赖（redact 等内核面留在 host-core/memoryEvolve.ts）。
 *
 * 口径：
 *  - **压力 = 确定性派生禁估算**：全部记忆条目正文字符数 / CAP（32,000 = 4× 注入预算 8000，
 *    loadMemoryForInjection 同字符口径），pct = min(100, ceil(chars/CAP×100))；
 *  - **auto 触发**：回合收口（宿主空闲点）检查 pct ≥ EVOLVE_AUTO_PCT 自动发起；
 *  - **复核超时**：auto 候选 EVOLVE_REVIEW_TIMEOUT_MS（缺省 120s）未复核默认放弃——
 *    M3 timeout-default-deny 同语义；手动运行无超时；
 *  - **落链叙事**（kind='system' + payload.type，EventKind 零新增——subagent/* 同款先例）：
 *    `memory/evolution`（run：runId/auto/model/pressure/usage?/candidates/dropped）、
 *    `memory/evolution-apply {runId, cid, op, targetId?, memoryId?}`、
 *    `memory/evolution-reject {runId, cid, op, feedback?|reason?}`、
 *    `memory/evolution-failed {runId, auto, reason}`。批准落盘本体 = 内核 MemoryStore
 *    写入（kind='memory' 事件自动落链）。
 */

/** 压力满格字符数（4× 注入预算——记忆体量过 4 个 turn 注入预算即黄区） */
export const MEMORY_PRESSURE_CAP_CHARS = 32_000
/** auto 进化触发阈值（回合收口检查） */
export const EVOLVE_AUTO_PCT = 70
/** auto 候选复核超时（缺省 120s——timeout-default-deny 同语义；测试可注入覆写） */
export const EVOLVE_REVIEW_TIMEOUT_MS = 120_000

export type EvolutionOp = 'add' | 'update' | 'delete'

export interface EvolutionCandidate {
  cid: string
  op: EvolutionOp
  /** update/delete 的目标记忆 id（宿主校验必须存在于 store） */
  targetId?: string
  /** add/update 的新正文（已过内核 redact——宿主侧保证） */
  text: string
  tags?: string[]
  reason: string
}

export interface MemoryPressure {
  chars: number
  count: number
  pct: number
}

export function memoryPressureOf(entries: ReadonlyArray<{ text: string }>): MemoryPressure {
  const chars = entries.reduce((n, e) => n + e.text.length, 0)
  return { chars, count: entries.length, pct: Math.min(100, Math.ceil((chars / MEMORY_PRESSURE_CAP_CHARS) * 100)) }
}

// ── 链事件派生（渲染层摘要表 + 复核区重建；纯函数可测） ──

export interface EvolutionSummaryRow {
  runId: string
  ts: number
  auto: boolean
  model: string
  /** 候选总数（run 事件） */
  candidates: number
  applied: number
  rejected: number
  usage?: { input: number; output: number }
}

export interface EvolutionPending {
  runId: string
  startedTs: number
  auto: boolean
  candidate: EvolutionCandidate
}

interface EvLike {
  kind: string
  ts: number
  payload: unknown
}

const narrOf = (e: EvLike): Record<string, unknown> | null => {
  if (e.kind !== 'system') return null
  const p = e.payload as Record<string, unknown> | null
  if (!p) return null
  const t = String(p['type'] ?? '')
  return t.startsWith('memory/evolution') ? p : null
}

/** 进化摘要行（链序 = run 事件序；决策计数 = apply/reject 叙事按 runId 归并） */
export function evolutionRowsFrom(events: ReadonlyArray<EvLike>): EvolutionSummaryRow[] {
  const runs = new Map<string, EvolutionSummaryRow>()
  for (const e of events) {
    const p = narrOf(e)
    if (!p || p['type'] !== 'memory/evolution') continue
    const runId = String(p['runId'] ?? '?')
    const cands = Array.isArray(p['candidates']) ? (p['candidates'] as unknown[]).length : 0
    const u = p['usage'] as Record<string, unknown> | undefined
    runs.set(runId, {
      runId,
      ts: e.ts,
      auto: p['auto'] === true,
      model: String(p['model'] ?? ''),
      candidates: cands,
      applied: 0,
      rejected: 0,
      ...(u && typeof u['input'] === 'number' ? { usage: { input: Number(u['input']), output: Number(u['output']) } } : {}),
    })
  }
  for (const e of events) {
    const p = narrOf(e)
    if (!p) continue
    const row = runs.get(String(p['runId'] ?? ''))
    if (!row) continue
    if (p['type'] === 'memory/evolution-apply') row.applied++
    else if (p['type'] === 'memory/evolution-reject') row.rejected++
  }
  return [...runs.values()]
}

/** 复核中候选（run 候选 − 已决——重启后复核区可重建；链即真值） */
export function evolutionPendingFrom(events: ReadonlyArray<EvLike>): EvolutionPending[] {
  const started = new Map<string, { ts: number; auto: boolean; candidates: EvolutionCandidate[] }>()
  const decided = new Set<string>()
  for (const e of events) {
    const p = narrOf(e)
    if (!p) continue
    if (p['type'] === 'memory/evolution') {
      const runId = String(p['runId'] ?? '?')
      started.set(runId, {
        ts: e.ts,
        auto: p['auto'] === true,
        candidates: Array.isArray(p['candidates']) ? (p['candidates'] as EvolutionCandidate[]) : [],
      })
    } else if (p['type'] === 'memory/evolution-apply' || p['type'] === 'memory/evolution-reject') {
      decided.add(String(p['runId'] ?? '?') + '::' + String(p['cid'] ?? ''))
    }
  }
  const out: EvolutionPending[] = []
  for (const [runId, r] of started) {
    for (const c of r.candidates) {
      if (!decided.has(runId + '::' + c.cid)) out.push({ runId, startedTs: r.ts, auto: r.auto, candidate: c })
    }
  }
  return out
}
