/**
 * T-FV-2 任务进程条行派生——链即真值（主链 subagent/* + bash/* 叙事，零新事实源；
 * 取代 v0.4 T-30 subagent-rows——子代理行并入统一任务行，类型徽标 bash / 子代理）。
 * 纯函数可测；秒表/收口时长数据源 = 事件 ts（epoch ms——内核 SessionLog.append 盖 Date.now()）。
 */
export interface TaskRow {
  kind: 'subagent' | 'bash'
  id: string
  /** 子代理 = 任务描述；bash = 命令行 */
  title: string
  state: 'active' | 'joined' | 'killed' | 'done' | 'stopped'
  /** 启动时刻（subagent/spawn / bash/start 事件 ts——秒表起点） */
  startedTs: number
  /** 收口时长（收口事件 ts − 启动 ts；未收口 = null——运行中以 now−startedTs 实时计） */
  durationMs: number | null
  /** bash 退出码（done 态；信号终止/收割 = null） */
  exitCode: number | null
  joinReason: string | null
}

/** 秒表格式（原型 ts-dur 同款：6s / 1m05s） */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}

/** 收口事件表（后到覆盖——kill 后 join 返回 aborted 的链序天然成立） */
export function taskRowsFrom(events: ReadonlyArray<{ kind: string; ts: number; payload: unknown }>): TaskRow[] {
  const closed = new Map<string, { state: 'joined' | 'killed' | 'done' | 'stopped'; ts: number; reason: string | null; exitCode: number | null }>()
  for (const e of events) {
    if (e.kind !== 'system') continue
    const p = e.payload as Record<string, unknown> | null
    if (!p) continue
    const id = p['subagentId'] ?? p['taskId']
    if (typeof id !== 'string') continue
    const type = String(p['type'] ?? '')
    if (type === 'subagent/join') closed.set(id, { state: 'joined', ts: e.ts, reason: String(p['reason'] ?? '?'), exitCode: null })
    else if (type === 'subagent/kill') closed.set(id, { state: 'killed', ts: e.ts, reason: String(p['reason'] ?? '?'), exitCode: null })
    else if (type === 'bash/exit')
      closed.set(id, {
        state: p['stopped'] === true ? 'stopped' : 'done',
        ts: e.ts,
        reason: typeof p['note'] === 'string' ? p['note'] : null,
        exitCode: typeof p['exitCode'] === 'number' ? p['exitCode'] : null,
      })
    else if (type === 'bash/kill') closed.set(id, { state: 'stopped', ts: e.ts, reason: String(p['reason'] ?? '?'), exitCode: null })
  }
  const rows: TaskRow[] = []
  for (const e of events) {
    if (e.kind !== 'system') continue
    const p = e.payload as Record<string, unknown> | null
    if (!p) continue
    if (p['type'] === 'subagent/spawn' && typeof p['subagentId'] === 'string') {
      const id = p['subagentId']
      const c = closed.get(id)
      rows.push({
        kind: 'subagent',
        id,
        title: String(p['task'] ?? ''),
        state: c?.state ?? 'active',
        startedTs: e.ts,
        durationMs: c ? c.ts - e.ts : null,
        exitCode: null,
        joinReason: c?.state === 'joined' ? c.reason : null,
      })
    } else if (p['type'] === 'bash/start' && typeof p['taskId'] === 'string') {
      const id = p['taskId']
      const c = closed.get(id)
      rows.push({
        kind: 'bash',
        id,
        title: String(p['command'] ?? ''),
        state: c?.state ?? 'active',
        startedTs: e.ts,
        durationMs: c ? c.ts - e.ts : null,
        exitCode: c?.exitCode ?? null,
        joinReason: null,
      })
    }
  }
  return rows
}
