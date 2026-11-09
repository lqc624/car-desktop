/**
 * T-FV-2 任务行派生单测（task-rows.ts——subagent/* + bash/* 合并派生，取代 T-30 subagent-rows.spec）。
 * 链即真值：收口事件后到覆盖；秒表起点 = spawn/bash/start 事件 ts。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatDuration, taskRowsFrom, type TaskRow } from '../src/renderer/task-rows.ts'

type Ev = { kind: string; ts: number; payload: unknown }
const sys = (ts: number, payload: Record<string, unknown>): Ev => ({ kind: 'system', ts, payload })

test('TR-1 子代理行：spawn→join 收口时长与 reason；kill → 已终止', () => {
  const rows = taskRowsFrom([
    sys(1000, { type: 'subagent/spawn', subagentId: 'SA-1', task: '调研任务' }),
    sys(9000, { type: 'subagent/join', subagentId: 'SA-1', reason: 'finish' }),
    sys(2000, { type: 'subagent/spawn', subagentId: 'SA-2', task: '会被终止' }),
    sys(5000, { type: 'subagent/kill', subagentId: 'SA-2', reason: 'user/model requested kill' }),
  ])
  assert.equal(rows.length, 2)
  const a = rows[0]!
  assert.equal(a.kind, 'subagent')
  assert.equal(a.state, 'joined')
  assert.equal(a.startedTs, 1000)
  assert.equal(a.durationMs, 8000, '收口时长 = join.ts − spawn.ts')
  assert.equal(a.joinReason, 'finish')
  const b = rows[1]!
  assert.equal(b.state, 'killed')
  assert.equal(b.joinReason, null)
})

test('TR-2 bash 行：start→exit(done+exitCode) / kill(stopped) / 收割(stopped)', () => {
  const rows = taskRowsFrom([
    sys(1000, { type: 'bash/start', taskId: 'BK-1', command: 'node -e console.log(42)', cwd: 'D:\\ws' }),
    sys(3000, { type: 'bash/exit', taskId: 'BK-1', exitCode: 0, durationMs: 2000, outputBytes: 3 }),
    sys(1000, { type: 'bash/start', taskId: 'BK-2', command: 'sleep 30', cwd: 'D:\\ws' }),
    sys(2000, { type: 'bash/kill', taskId: 'BK-2', reason: 'user' }),
    sys(1000, { type: 'bash/start', taskId: 'BK-3', command: 'legacy', cwd: 'D:\\ws' }),
    sys(9000, { type: 'bash/exit', taskId: 'BK-3', exitCode: null, durationMs: null, outputBytes: null, stopped: true, note: '宿主重启收割' }),
  ])
  const byId = new Map(rows.map((r) => [r.id, r]))
  const done = byId.get('BK-1')!
  assert.equal(done.state, 'done')
  assert.equal(done.exitCode, 0)
  assert.equal(done.durationMs, 2000)
  assert.equal(done.title, 'node -e console.log(42)')
  assert.equal(byId.get('BK-2')!.state, 'stopped')
  assert.equal(byId.get('BK-3')!.state, 'stopped', '收割补记（stopped:true）→ stopped 而非 done')
})

test('TR-3 后到覆盖：kill 后 join（aborted）= joined + reason；混合链行序 = 链序', () => {
  const rows = taskRowsFrom([
    sys(1000, { type: 'subagent/spawn', subagentId: 'SA-1', task: '先杀后汇' }),
    sys(2000, { type: 'subagent/kill', subagentId: 'SA-1', reason: 'x' }),
    sys(3000, { type: 'subagent/join', subagentId: 'SA-1', reason: 'aborted' }),
    sys(1500, { type: 'bash/start', taskId: 'BK-1', command: 'echo hi', cwd: '.' }),
  ])
  assert.equal(rows[0]!.state, 'joined', 'kill 后 join（内核返回 aborted）= 已汇合 + reason（k2 链序实证同款）')
  assert.equal(rows[0]!.joinReason, 'aborted')
  assert.equal(rows[1]!.kind, 'bash')
})

test('TR-4 非系统事件与幽灵收口不产行（K2 幽灵口径同款）', () => {
  const rows = taskRowsFrom([
    { kind: 'user', ts: 1, payload: 'hi' },
    sys(2, { type: 'subagent/join', subagentId: 'SA-GHOST', reason: 'finish' }),
    sys(3, { type: 'bash/exit', taskId: 'BK-GHOST', exitCode: 0, durationMs: 1, outputBytes: 1 }),
  ])
  assert.equal(rows.length, 0)
})

test('TR-5 formatDuration：6s / 1m05s（原型 ts-dur 同款）', () => {
  assert.equal(formatDuration(0), '0s')
  assert.equal(formatDuration(6000), '6s')
  assert.equal(formatDuration(65000), '1m05s')
  assert.equal(formatDuration(3600000), '60m00s')
  assert.equal(formatDuration(-1), '—')
  assert.equal(formatDuration(Number.NaN), '—')
})

test('TR-6 空事件流 = 空行集', () => {
  const rows: TaskRow[] = taskRowsFrom([])
  assert.equal(rows.length, 0)
})
