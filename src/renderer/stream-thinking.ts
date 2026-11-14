/**
 * v0.9.0 · thinking 消费批纯函数面（内核 1.22 / D-SD2~D-SD4）
 *
 *  - StreamBuf / applyStreamDelta：流式增量归并（1.19.0 面扩展——thinkingDelta 追加，
 *    按 turnId 换道重建；thinking 与 text 独立流，可共存到达）；
 *  - thinkingRowsFrom：thinking 事件 → 叙事 chip 派生（内核 1.22 一块一事件——同 turn
 *    聚合块数与字数；主面零原文纪律：chip 只显计数，原文唯一展示面 = 审计页）。
 *
 * 渲染提示面纪律（1.19.0 延续）：不落链、不持久；事实本体仍以落盘行为准。
 */
import type { SessionDeltaPush } from '../shared/ipc-contract'

export interface StreamBuf {
  turnId: string
  text: string
  toolName: string | null
  /** v0.9.0：思考掩蔽流缓冲（内核侧已脱敏——D-C1 主面即时态；assistant/turnEnd 到达清零） */
  thinking: string
}

/** 流式增量归并（纯函数——按 turnId 换道重建，textDelta/thinkingDelta 追加，toolName 首见钉住） */
export function applyStreamDelta(prev: StreamBuf | null, p: SessionDeltaPush): StreamBuf {
  const base = prev && prev.turnId === p.turnId ? prev : { turnId: p.turnId, text: '', toolName: null, thinking: '' }
  return {
    turnId: base.turnId,
    text: base.text + (p.textDelta ?? ''),
    toolName: p.toolName ?? base.toolName,
    thinking: base.thinking + (p.thinkingDelta ?? ''),
  }
}

/** thinking 叙事 chip 派生（纯函数——同 turn 聚合；块数 = thinking 事件数〔一块一事件〕；字数 = payload 长度合计） */
export interface ThinkingRow {
  turnId: string
  chars: number
  blocks: number
  /** 首块 seq（叙事行插入位——chip 出现在该 turn thinking 首事件位置） */
  firstSeq: number
}

export function thinkingRowsFrom(
  events: ReadonlyArray<{ kind: string; turnId: string; seq: number; payload: unknown }>,
): ThinkingRow[] {
  const rows = new Map<string, ThinkingRow>()
  for (const e of events) {
    if (e.kind !== 'thinking') continue
    const p = typeof e.payload === 'string' ? e.payload : ''
    if (!p.length) continue
    const cur = rows.get(e.turnId) ?? { turnId: e.turnId, chars: 0, blocks: 0, firstSeq: e.seq }
    cur.chars += p.length
    cur.blocks += 1
    rows.set(e.turnId, cur)
  }
  return [...rows.values()]
}
