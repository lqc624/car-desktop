/**
 * v0.4 · T-30 子 Agent 状态区行派生（最小档——链即真值）
 *  - spawn 未收口 → active；join → joined + reason；kill → killed
 *  - 同 id 多次收口事件以链序最后一击为准（append-only 后到覆盖）
 *  - 无 spawn 的 join/kill 幽灵事件不产出行
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { subagentRowsFrom } from '../src/renderer/subagent-rows.ts'

const ev = (kind: string, payload: unknown): { kind: string; payload: unknown } => ({ kind, payload })

test('T-30: 三态行派生——active/joined/killed + joinReason', () => {
  const rows = subagentRowsFrom([
    ev('system', { type: 'subagent/spawn', subagentId: 'sa-1', task: '调研 A' }),
    ev('system', { type: 'subagent/spawn', subagentId: 'sa-2', task: '调研 B' }),
    ev('system', { type: 'subagent/spawn', subagentId: 'sa-3', task: '调研 C' }),
    ev('system', { type: 'subagent/join', subagentId: 'sa-1', reason: 'completed', steps: 3, summaryChars: 120 }),
    ev('system', { type: 'subagent/kill', subagentId: 'sa-2' }),
  ])
  assert.equal(rows.length, 3)
  assert.deepEqual(rows[0], { id: 'sa-1', task: '调研 A', state: 'joined', joinReason: 'completed' })
  assert.deepEqual(rows[1], { id: 'sa-2', task: '调研 B', state: 'killed', joinReason: null })
  assert.deepEqual(rows[2], { id: 'sa-3', task: '调研 C', state: 'active', joinReason: null })
})

test('T-30: 非 spawn/join/kill 事件零干扰 + 幽灵收口不产出行', () => {
  const rows = subagentRowsFrom([
    ev('system', { type: 'session-start' }),
    ev('user', 'hi'),
    ev('system', { type: 'subagent/join', subagentId: 'ghost', reason: 'completed', steps: 0, summaryChars: 0 }),
    ev('usage', { input: 1 }),
  ])
  assert.equal(rows.length, 0, '幽灵 join（无对应 spawn）不产行；其他事件零干扰')
})
