/**
 * Z-1 延伸（0.15.0 / D-Z15-4）· 同父分支对比对齐器（纯函数，零 IO 零 LLM 零估算——确定性红线）
 *
 * 主用例「同题不同答」：分叉 = 回到同一问题之前换方案（D-Z13-1 排除语义）→ 两支 user
 * 前缀大概率相同、assistant 增量不同。对齐 = user 锚点分段 + lookahead-1 贪心：锚点相同
 * 并排、不同如实错位标注不硬拼（R-4——锚点不匹配时确定性退避，不追求语义智能）。
 */
import type { SessionEventDTO } from '../shared/ipc-contract'

/** 对比输入：一链的对话事件全集 + 该链 fork-in 标记的 upToSeq（分叉点——调用方读链取得） */
export interface BranchEvents {
  events: SessionEventDTO[]
  /** fork-in 标记 payload.upToSeq（分叉边界：子链 = [0, upToSeq) 逐字节迁移） */
  forkUpToSeq: number
}

export interface DiffItem {
  role: 'user' | 'assistant'
  text: string
}

export interface DiffSegment {
  /** aligned = 两支 user 锚点相同（同题并排）；a-only / b-only = 错位段（如实标注） */
  kind: 'aligned' | 'a-only' | 'b-only'
  /** 锚点 user 文本（a-only 段 = A 支锚点；b-only 段 = B 支锚点） */
  userText: string
  aItems: DiffItem[]
  bItems: DiffItem[]
}

export interface BranchDiff {
  /** 公共前缀对话件数（seq < min(两 fork-upTo) 的 user+assistant 文本件——折叠区） */
  commonPrefixCount: number
  /** 公共前缀内 user 锚点文本序列（折叠区标题展示「同题」面） */
  commonPrefixUsers: string[]
  segments: DiffSegment[]
}

/** 对话面 = user / assistant 且 payload 为字符串的件（fork 标记 / toolCall / turnEnd / thinking 等非对话件不进对比视图） */
function dialogEvents(events: SessionEventDTO[]): Array<{ seq: number; role: 'user' | 'assistant'; text: string }> {
  const out: Array<{ seq: number; role: 'user' | 'assistant'; text: string }> = []
  for (const e of events) {
    if ((e.kind === 'user' || e.kind === 'assistant') && typeof e.payload === 'string') {
      out.push({ seq: e.seq, role: e.kind, text: e.payload })
    }
  }
  return out
}

/** 一链增量（seq >= forkUpTo 的对话件）按 user 锚点切段；段尾 assistant 归锚点段（无锚点尾件如实归 last 段） */
interface BranchSegment {
  userText: string
  items: DiffItem[]
}

function branchSegments(events: SessionEventDTO[], forkUpToSeq: number): BranchSegment[] {
  const segs: BranchSegment[] = []
  let cur: BranchSegment | null = null
  for (const d of dialogEvents(events)) {
    if (d.seq < forkUpToSeq) continue
    if (d.role === 'user') {
      cur = { userText: d.text, items: [] }
      segs.push(cur)
    } else if (cur) {
      cur.items.push({ role: 'assistant', text: d.text })
    }
    // R-4 边界：分叉边界前无 user 锚点的孤立 assistant（构造态）如实丢弃——无锚点不可对齐
  }
  return segs
}

export function alignBranches(a: BranchEvents, b: BranchEvents): BranchDiff {
  const boundary = Math.min(a.forkUpToSeq, b.forkUpToSeq)
  const prefixUsers: string[] = []
  let commonPrefixCount = 0
  for (const d of dialogEvents(a.events)) {
    if (d.seq >= boundary) break
    if (d.role === 'user') prefixUsers.push(d.text)
    commonPrefixCount++
  }
  const sa = branchSegments(a.events, a.forkUpToSeq)
  const sb = branchSegments(b.events, b.forkUpToSeq)
  const segments: DiffSegment[] = []
  let i = 0
  let j = 0
  while (i < sa.length || j < sb.length) {
    const A = sa[i]
    const B = sb[j]
    if (A && B && A.userText === B.userText) {
      segments.push({ kind: 'aligned', userText: A.userText, aItems: A.items, bItems: B.items })
      i++
      j++
      continue
    }
    // lookahead-1 贪心：一侧下一锚点与对侧当前锚点相同时，本侧独立成段（改问法错位如实标注）
    const Anext = sa[i + 1]
    const Bnext = sb[j + 1]
    if (A && B && Anext && Anext.userText === B.userText) {
      segments.push({ kind: 'a-only', userText: A.userText, aItems: A.items, bItems: [] })
      i++
    } else if (A && B && Bnext && A.userText === Bnext.userText) {
      segments.push({ kind: 'b-only', userText: B.userText, aItems: [], bItems: B.items })
      j++
    } else if (A && B) {
      // 双锚点互不匹配且 lookahead 皆不接 → 双双独立成段（R-4：如实错位标注，不硬拼成 aligned）
      segments.push({ kind: 'a-only', userText: A.userText, aItems: A.items, bItems: [] })
      segments.push({ kind: 'b-only', userText: B.userText, aItems: [], bItems: B.items })
      i++
      j++
    } else if (A) {
      segments.push({ kind: 'a-only', userText: A.userText, aItems: A.items, bItems: [] })
      i++
    } else if (B) {
      segments.push({ kind: 'b-only', userText: B.userText, aItems: [], bItems: B.items })
      j++
    }
  }
  return { commonPrefixCount, commonPrefixUsers: prefixUsers, segments }
}
