/**
 * B-3（D-VB3-1 / §4.8 视觉验收判据化协议）· verdict 契约与解析
 *
 * 口径：
 *  - 判据先行：验收判据（页面清单 + 每页判据）写在 subagent_spawn 的 task 文本——链序
 *    spawn(判据) → browser/shot → join(verdict) 即证据（防「先看后编」的叙事化验收，N-B1 同族）；
 *  - 判定面（visual 子代理档）末条 assistant 输出 verdict JSON；join 时解析——宽松取 JSON
 *    子串（模型可能带说明文字/代码围栏）+ 严格形状校验；坏形态 = fail-visible（上层落
 *    verdictUnparsed，禁静默吞）；
 *  - 判定 fail ≠ 工具执行 fail（§4.8 两态分立）：verdict.fail 时 toolResult 仍 ok:true，
 *    行面 warn 分立呈现；主面禁复判——收到的 verdict 即视觉门结果。
 */

export interface VisualVerdictIssue {
  severity?: string
  note?: string
}

export interface VisualVerdictPage {
  shotId: string
  verdict: 'pass' | 'fail'
  issues?: VisualVerdictIssue[]
}

export interface VisualVerdict {
  pages: VisualVerdictPage[]
  summary?: string
}

/**
 * 判定面末条 assistant 文本 → verdict。宽松提取（首个 { 至末个 }）+ 逐字段形状校验，
 * 任一违规整体判 null（不做部分采纳——半份 verdict 比没有更危险）。
 */
export function parseVisualVerdict(text: string | undefined | null): VisualVerdict | null {
  if (!text) return null
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const obj = parsed as Record<string, unknown>
  const pagesRaw = obj['pages']
  if (!Array.isArray(pagesRaw) || pagesRaw.length === 0) return null
  const pages: VisualVerdictPage[] = []
  for (const p of pagesRaw) {
    if (typeof p !== 'object' || p === null) return null
    const e = p as Record<string, unknown>
    const shotId = e['shotId']
    const verdict = e['verdict']
    if (typeof shotId !== 'string' || !shotId) return null
    if (verdict !== 'pass' && verdict !== 'fail') return null
    let issues: VisualVerdictIssue[] | undefined
    if (e['issues'] !== undefined) {
      if (!Array.isArray(e['issues'])) return null
      issues = []
      for (const i of e['issues']) {
        if (typeof i !== 'object' || i === null) return null
        const ie = i as Record<string, unknown>
        issues.push({
          ...(typeof ie['severity'] === 'string' ? { severity: ie['severity'] } : {}),
          ...(typeof ie['note'] === 'string' ? { note: ie['note'] } : {}),
        })
      }
    }
    pages.push({ shotId, verdict, ...(issues ? { issues } : {}) })
  }
  const summary = typeof obj['summary'] === 'string' ? obj['summary'] : undefined
  return { pages, ...(summary !== undefined ? { summary } : {}) }
}
