/**
 * S3-S5 · 计量聚合（计量设计 §4.6；立项书 VD4；S3 规划 DASH_METERING + PRICE_IF）
 *
 * 口径：
 *  - 事实本体 = 会话 JSONL usage 事件（model/adapterId/四分量/providerRaw——内核 1.11 D-33 落链
 *    形态实查 chatStep.ts:113-119）——**禁估算**：无 usage 的 turn 显性化（coverage + turnsWithoutUsage）；
 *  - 金额 = PriceProvider 现算（R-D5 两模式：本地模式 null → 金额字段 **null**，渲染层「价目未同步」
 *    **禁 0 禁伪造**）；部分模型缺价目 → 该聚合面金额 null（禁部分现算的静默混算）；
 *  - 日柱 = 近 7 个本地日窗口（含零事实日——「该日无事实」≠「金额伪造 0」；金额在价目未同步时为 null）；
 *  - 缓存命中率 = cacheRead ÷（input + cacheRead）（计量设计 §1.1 归一口径：input 已扣缓存读）；
 *  - 覆盖率 = 有 usage 的 turn / turn 总数（turnEnd 计数，authz:* 审计事件不计——ctx-pop usageOver 同口径）；
 *  - turn 明细含关联能力列 = turn 内 toolCall 工具集合（关联呈现——计量设计 §4.4：usage 物理上不可
 *    拆到单个工具，**不做跨能力求和**）；usage 事件为请求级，turn 行 = 同 turn 多请求聚合（requests 计数）。
 */
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { loadSessionLog } from '@lqc123qwe/car-runtime'
import { sessionsDirFor } from './sessions.ts'

export interface UsageFact {
  sessionId: string
  ts: number
  turnId: string
  model: string | null
  adapterId: string | null
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
}

/** 价目（USD / 百万 token）——R-D5 平台 t_model_price 同步接口面；本地模式恒 null */
export interface PriceRates {
  input: number
  output: number
  cacheRead: number
}
export interface PriceProvider {
  ratesFor(model: string): PriceRates | null
}
export function nullPriceProvider(): PriceProvider {
  return { ratesFor: () => null }
}
export function tablePriceProvider(table: Record<string, PriceRates>): PriceProvider {
  return { ratesFor: (m) => table[m] ?? null }
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** usage 事实抽取（usage 事件 + turn 级工具关联 + turnEnd 计数——一次遍历） */
export function factsFromEvents(
  events: ReadonlyArray<{ kind: string; turnId: string; ts: number; payload: unknown; meta?: Record<string, unknown> | null }>,
  sessionId: string,
): { facts: UsageFact[]; toolsByTurn: Map<string, string[]>; turnEndCount: number; usageMissingTurns: number } {
  const facts: UsageFact[] = []
  const toolsByTurn = new Map<string, string[]>()
  let turnEndCount = 0
  // 1.18.2（R-K7-2）：内核 turnEnd.usageMissing 尾键——turn 有模型输出但 provider 未回执
  // usage（商汤网关实测 ~20%）。「无 usage」由此细分：网关真缺失 vs 无模型请求 turn。
  let usageMissingTurns = 0
  for (const e of events) {
    if (e.kind === 'usage' && !e.turnId.startsWith('authz:')) {
      const p = (e.payload ?? {}) as Record<string, unknown>
      facts.push({
        sessionId,
        ts: e.ts,
        turnId: e.turnId,
        model: typeof p['model'] === 'string' ? p['model'] : null,
        adapterId: typeof p['adapterId'] === 'string' ? p['adapterId'] : null,
        input: num(p['input']),
        output: num(p['output']),
        cacheRead: num(p['cacheRead']),
        cacheCreation: num(p['cacheCreation']),
      })
      continue
    }
    if (e.kind === 'toolCall' && !e.turnId.startsWith('authz:')) {
      const tool = (e.payload as Record<string, unknown> | null)?.['tool']
      if (typeof tool === 'string') {
        const list = toolsByTurn.get(e.turnId) ?? []
        if (!list.includes(tool)) list.push(tool)
        toolsByTurn.set(e.turnId, list)
      }
      continue
    }
    if (e.kind === 'turnEnd' && !e.turnId.startsWith('authz:')) {
      turnEndCount++
      if (e.meta?.['usageMissing'] === true) usageMissingTurns++
    }
  }
  return { facts, toolsByTurn, turnEndCount, usageMissingTurns }
}

const dayOf = (ts: number): string => {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export interface DayBar {
  day: string
  input: number
  output: number
  cacheRead: number
  cost: number | null
}
export interface ModelRow {
  model: string
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
  requests: number
  cost: number | null
}
export interface TurnRow {
  sessionId: string
  ts: number
  turnId: string
  model: string | null
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
  requests: number
  cost: number | null
  /** 关联能力列：turn 内工具集合（关联呈现，不跨能力求和） */
  tools: string[]
}
export interface MeteringSummary {
  generatedAt: number
  /** 价目是否全量同步（false = 渲染层「价目未同步」横幅——禁金额伪造） */
  priceSynced: boolean
  cards: {
    today: { input: number; output: number; cacheRead: number; cost: number | null }
    /** cacheRead ÷ (input + cacheRead)；无事实 = null（禁 0% 伪造） */
    cacheHitRate: number | null
    /** 有 usage 的 turn / turn 总数；无 turn = null */
    usageCoverage: number | null
    turnsWithoutUsage: number
    /** 网关未回执 usage 的 turn（内核 turnEnd.usageMissing 尾键——1.18.2 R-K7-2）；≤ turnsWithoutUsage，差值 = 无模型请求的 turn */
    usageMissingTurns: number
  }
  dailyBars: DayBar[]
  byModel: ModelRow[]
  turns: TurnRow[]
}

const costOf = (f: { input: number; output: number; cacheRead: number }, r: PriceRates): number =>
  (f.input * r.input + f.output * r.output + f.cacheRead * r.cacheRead) / 1e6

/**
 * 聚合（纯函数）：facts + turn 关联 → 四卡 / 7 日柱 / 按模型 / turn 明细。
 * now = 本地「今日」锚点（测试注入）；provider 缺价目 → 对应金额 null（禁 0）。
 */
export function summarizeFacts(
  facts: readonly UsageFact[],
  toolsByTurn: ReadonlyMap<string, string[]>,
  turnEndCount: number,
  provider: PriceProvider,
  now: number,
  usageMissingTurns = 0,
): MeteringSummary {
  const ratesCache = new Map<string, PriceRates | null>()
  const ratesFor = (model: string | null): PriceRates | null => {
    if (!model) return null
    if (!ratesCache.has(model)) ratesCache.set(model, provider.ratesFor(model))
    return ratesCache.get(model)!
  }
  // 按模型聚合 + 每模型金额（缺价目的模型 = null——禁部分现算混算）
  const byModelMap = new Map<string, { input: number; output: number; cacheRead: number; cacheCreation: number; requests: number; unpriced: boolean }>()
  const turnAgg = new Map<string, { sessionId: string; ts: number; model: string | null; input: number; output: number; cacheRead: number; cacheCreation: number; requests: number }>()
  for (const f of facts) {
    const key = f.model ?? '（未采集模型）'
    const m = byModelMap.get(key) ?? { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, requests: 0, unpriced: false }
    m.input += f.input
    m.output += f.output
    m.cacheRead += f.cacheRead
    m.cacheCreation += f.cacheCreation
    m.requests += 1
    if (!ratesFor(f.model)) m.unpriced = true
    byModelMap.set(key, m)
    // turn 行聚合（usage 请求级 → turn 级；ts 取首请求）
    const tKey = f.sessionId + '::' + f.turnId
    const t = turnAgg.get(tKey) ?? { sessionId: f.sessionId, ts: f.ts, model: f.model, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, requests: 0 }
    t.input += f.input
    t.output += f.output
    t.cacheRead += f.cacheRead
    t.cacheCreation += f.cacheCreation
    t.requests += 1
    turnAgg.set(tKey, t)
  }
  const priced = (cost: number, unpriced: boolean): number | null => (unpriced ? null : cost)
  const byModel: ModelRow[] = [...byModelMap.entries()]
    .map(([model, m]) => {
      const r = ratesFor(model === '（未采集模型）' ? null : model)
      return {
        model,
        input: m.input,
        output: m.output,
        cacheRead: m.cacheRead,
        cacheCreation: m.cacheCreation,
        requests: m.requests,
        cost: r && !m.unpriced ? priced(costOf(m, r), m.unpriced) : null,
      }
    })
    .sort((a, b) => b.input + b.output - (a.input + a.output))
  // turn 明细（关联能力列 = turn 内工具集合；金额按模型价目，缺 = null）
  const turns: TurnRow[] = [...turnAgg.entries()]
    .map(([tKey, t]) => {
      const r = ratesFor(t.model)
      return {
        sessionId: t.sessionId,
        ts: t.ts,
        turnId: turnKeyOf(tKey),
        model: t.model,
        input: t.input,
        output: t.output,
        cacheRead: t.cacheRead,
        cacheCreation: t.cacheCreation,
        requests: t.requests,
        cost: r ? costOf(t, r) : null,
        tools: toolsByTurn.get(turnKeyOf(tKey)) ?? [],
      }
    })
    .sort((a, b) => b.ts - a.ts)
  // 今日四卡 + 命中率 + 覆盖率
  const today = dayOf(now)
  const todayFacts = facts.filter((f) => dayOf(f.ts) === today)
  const todayUnpriced = todayFacts.some((f) => !ratesFor(f.model))
  const todayAgg = todayFacts.reduce(
    (acc, f) => ({ input: acc.input + f.input, output: acc.output + f.output, cacheRead: acc.cacheRead + f.cacheRead }),
    { input: 0, output: 0, cacheRead: 0 },
  )
  const todayCost = todayUnpriced
    ? null
    : todayFacts.reduce((sum, f) => {
        const r = ratesFor(f.model)
        return r ? sum + costOf(f, r) : sum
      }, 0)
  const totalInput = facts.reduce((s, f) => s + f.input, 0)
  const totalCacheRead = facts.reduce((s, f) => s + f.cacheRead, 0)
  // 7 日柱（近 7 个本地日，含零事实日；金额按日 facts 现算，缺价目 = null）
  const dailyBars: DayBar[] = []
  for (let i = 6; i >= 0; i--) {
    const dayTs = now - i * 86_400_000
    const day = dayOf(dayTs)
    const dayFacts = facts.filter((f) => dayOf(f.ts) === day)
    const dayUnpriced = dayFacts.some((f) => !ratesFor(f.model))
    dailyBars.push({
      day,
      input: dayFacts.reduce((s, f) => s + f.input, 0),
      output: dayFacts.reduce((s, f) => s + f.output, 0),
      cacheRead: dayFacts.reduce((s, f) => s + f.cacheRead, 0),
      cost: dayFacts.length === 0 ? null : dayUnpriced ? null : dayFacts.reduce((s, f) => s + (ratesFor(f.model) ? costOf(f, ratesFor(f.model)!) : 0), 0),
    })
  }
  const turnsWithUsage = new Set(facts.map((f) => f.sessionId + '::' + f.turnId)).size
  return {
    generatedAt: now,
    priceSynced: facts.length > 0 && facts.every((f) => !!ratesFor(f.model)),
    cards: {
      today: { ...todayAgg, cost: todayFacts.length === 0 || todayUnpriced ? null : todayCost },
      cacheHitRate: totalInput + totalCacheRead > 0 ? totalCacheRead / (totalInput + totalCacheRead) : null,
      usageCoverage: turnEndCount > 0 ? turnsWithUsage / turnEndCount : null,
      turnsWithoutUsage: Math.max(0, turnEndCount - turnsWithUsage),
      usageMissingTurns,
    },
    dailyBars,
    byModel,
    turns,
  }
}

/** turnAgg 复合键 → 原始 turnId（toolsByTurn 按 turnId 索引） */
function turnKeyOf(tKey: string): string {
  const idx = tKey.indexOf('::')
  return tKey.slice(idx + 2)
}

/** 工作区计量汇总：遍历全部会话 JSONL（事实本体——含已删除会话，删除仅索引态） */
export function workspaceMeteringSummary(workspaceRoot: string, provider: PriceProvider, now = Date.now()): MeteringSummary & { warnings: string[] } {
  const dir = sessionsDirFor(workspaceRoot)
  const facts: UsageFact[] = []
  const toolsByTurn = new Map<string, string[]>()
  let turnEndCount = 0
  let usageMissingTurns = 0
  const warnings: string[] = []
  let files: string[] = []
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
  } catch {
    return { ...summarizeFacts([], toolsByTurn, 0, provider, now), warnings }
  }
  for (const f of files) {
    const sessionId = f.slice(0, -'.jsonl'.length)
    try {
      const loaded = loadSessionLog(path.join(dir, f))
      const r = factsFromEvents(loaded.log.events, sessionId)
      facts.push(...r.facts)
      for (const [turnId, tools] of r.toolsByTurn) {
        const merged = toolsByTurn.get(turnId) ?? []
        for (const t of tools) if (!merged.includes(t)) merged.push(t)
        toolsByTurn.set(turnId, merged)
      }
      turnEndCount += r.turnEndCount
      usageMissingTurns += r.usageMissingTurns
    } catch (err) {
      warnings.push(`会话 ${sessionId} 解析失败跳过：${err instanceof Error ? err.message : err}`)
    }
  }
  return { ...summarizeFacts(facts, toolsByTurn, turnEndCount, provider, now, usageMissingTurns), warnings }
}
