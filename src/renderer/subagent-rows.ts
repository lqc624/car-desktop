/**
 * v0.4（T-30 最小档）：子 Agent 状态区行派生——链即真值（主链 spawn/join/kill 事件，
 * 零新事实源）。纯函数可测；join 摘要全文 = 子链 assistant 流（T-29 审计跳转覆盖）。
 */
export interface SubagentRow {
  id: string
  task: string
  state: 'active' | 'joined' | 'killed'
  joinReason: string | null
}

export function subagentRowsFrom(events: ReadonlyArray<{ kind: string; payload: unknown }>): SubagentRow[] {
  const closed = new Map<string, string>()
  for (const e of events) {
    if (e.kind !== 'system') continue
    const p = e.payload as Record<string, unknown> | null
    if (!p) continue
    if (p['type'] === 'subagent/join') closed.set(String(p['subagentId']), 'joined:' + String(p['reason'] ?? '?'))
    else if (p['type'] === 'subagent/kill') closed.set(String(p['subagentId']), 'killed')
  }
  return events
    .filter((e) => e.kind === 'system' && (e.payload as Record<string, unknown> | null)?.['type'] === 'subagent/spawn')
    .map((e) => {
      const p = e.payload as Record<string, unknown>
      const id = String(p['subagentId'] ?? '?')
      const c = closed.get(id)
      return { id, task: String(p['task'] ?? ''), state: c === 'killed' ? 'killed' : c ? 'joined' : 'active', joinReason: c?.startsWith('joined:') ? c.slice(7) : null }
    })
}
