/**
 * T-ME 记忆进化共享派生单测（src/shared/memory-evolution.ts——压力/摘要/复核中候选；链即真值）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  memoryPressureOf,
  evolutionRowsFrom,
  evolutionPendingFrom,
  MEMORY_PRESSURE_CAP_CHARS,
} from '../src/shared/memory-evolution.ts'

type Ev = { kind: string; ts: number; payload: unknown }
const sys = (ts: number, payload: Record<string, unknown>): Ev => ({ kind: 'system', ts, payload })

test('ME-R1 压力派生：字符/条目/pct（确定性禁估算；CAP = 32k）', () => {
  assert.deepEqual(memoryPressureOf([]), { chars: 0, count: 0, pct: 0 })
  const p = memoryPressureOf([{ text: 'a'.repeat(16000) }, { text: 'b'.repeat(16000) }])
  assert.equal(p.chars, 32000)
  assert.equal(p.count, 2)
  assert.equal(p.pct, 100)
  const half = memoryPressureOf([{ text: 'x'.repeat(MEMORY_PRESSURE_CAP_CHARS / 2) }])
  assert.equal(half.pct, 50)
  assert.equal(memoryPressureOf([{ text: 'x'.repeat(320000) }]).pct, 100, '超限钳到 100')
})

const RUN = {
  type: 'memory/evolution',
  runId: 'EV-1',
  auto: false,
  model: 'm-live',
  pressure: { chars: 24000, count: 3, pct: 75 },
  candidates: [
    { cid: 'C1', op: 'update', targetId: 'm-1', text: '新正文', reason: '过时' },
    { cid: 'C2', op: 'add', text: '新增', reason: '补缺口' },
  ],
  dropped: 1,
}

test('ME-R2 摘要行：run + apply/reject 计数归并（usage 有则随行）', () => {
  const rows = evolutionRowsFrom([
    sys(1000, RUN),
    sys(2000, { type: 'memory/evolution-apply', runId: 'EV-1', cid: 'C1', op: 'update', memoryId: 'm-1' }),
    sys(3000, { type: 'memory/evolution-reject', runId: 'EV-1', cid: 'C2', op: 'add', feedback: '不需要' }),
    sys(4000, { type: 'memory/evolution', runId: 'EV-2', auto: true, model: 'm2', pressure: { chars: 1, count: 1, pct: 1 }, candidates: [{ cid: 'C1', op: 'add', text: 'x', reason: '' }], usage: { input: 100, output: 20 } }),
  ])
  assert.equal(rows.length, 2)
  assert.equal(rows[0]!.candidates, 2)
  assert.equal(rows[0]!.applied, 1)
  assert.equal(rows[0]!.rejected, 1)
  assert.equal(rows[0]!.usage, undefined, 'run 无 usage 事件 = 省键（禁估算）')
  assert.equal(rows[1]!.auto, true)
  assert.deepEqual(rows[1]!.usage, { input: 100, output: 20 })
})

test('ME-R3 复核中候选：run 候选 − 已决（重启可重建）；已决幂等剔除', () => {
  const base = [sys(1000, RUN)]
  assert.equal(evolutionPendingFrom(base).length, 2, '两候选均未决')
  const decided = [
    ...base,
    sys(2000, { type: 'memory/evolution-apply', runId: 'EV-1', cid: 'C1', op: 'update', memoryId: 'm-1' }),
  ]
  const pending = evolutionPendingFrom(decided)
  assert.equal(pending.length, 1)
  assert.equal(pending[0]!.candidate.cid, 'C2')
  assert.equal(pending[0]!.runId, 'EV-1')
  assert.equal(pending[0]!.startedTs, 1000)
  // 非系统事件 / 非 memory/evolution 叙事零污染
  assert.equal(evolutionPendingFrom([{ kind: 'user', ts: 1, payload: 'hi' }, sys(2, { type: 'subagent/spawn', subagentId: 'SA-1' })]).length, 0)
})
