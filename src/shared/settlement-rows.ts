/**
 * W-2 消费面 · 回合结算回执行构造（纯函数——App 任务行 + doctor 近期结算行共用）
 *
 * 口径（内核 1.24 settlement / D-B2-9）：hasUnknownOutcomes 显式呈现 = fail-visible
 * （《Qwen-Code 对照分析》§5——「取消后结果不明的工具显式记账」进桌面任务行验收项）；
 * 授权拒绝计数与护栏事实随行呈现；老链（1.23 及更早）无 settlement 事件 = 无行（容错）。
 */

export interface SettlementLite {
  outcome: string
  failureKind?: string
  requestSent: boolean
  declaredToolUseIds: string[]
  dispatchedToolUseIds: string[]
  tool: {
    permissionDenialCount: number
    hasUnknownOutcomes: boolean
    unknownToolUseIds?: string[]
    stopRequested: boolean
    bounded: boolean
  }
}

export interface SettlementRow {
  tone: 'dim' | 'warn'
  text: string
}

export function settlementRow(p: SettlementLite): SettlementRow {
  const declared = p.declaredToolUseIds.length
  const unknown = p.tool.hasUnknownOutcomes
    ? Math.max(p.tool.unknownToolUseIds?.length ?? 0, p.declaredToolUseIds.filter((id) => !p.dispatchedToolUseIds.includes(id)).length)
    : 0
  const denial = p.tool.permissionDenialCount
  const flags: string[] = []
  if (p.tool.stopRequested) flags.push('工具主动收口')
  if (p.tool.bounded) flags.push('取消落派发边界')
  const head =
    `回合结算 ${p.outcome}${p.failureKind ? `（${p.failureKind}）` : ''}` +
    ` · 工具 ${declared}${denial ? ` · 授权拒 ${denial}` : ''}${flags.length ? ` · ${flags.join('/')}` : ''}——settlement 已落链`
  if (unknown > 0) {
    return {
      tone: 'warn',
      text: `⚠ ${head} · ${unknown} 个工具结果不明（hasUnknownOutcomes——取消后结果不明的显式记账，副作用状态见审计链）`,
    }
  }
  return { tone: 'dim', text: head }
}
