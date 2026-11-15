/**
 * s-kinds · C2 失败细类消费面（内核 1.23.0-W1 turnEnd meta.kind/abortedAt 桌面消费——W-1c）
 *
 * 判据（shared/failure-kinds.ts + host-core/doctor.ts summarizeRecentFailures）：
 *  - 注册表对拍：FAILURE_KIND_IDS 与内核 LlmErrorKind 9 类一一对应（漏项 fail-visible 钉死）；
 *  - failureKindLabel：已知类别中文标签 / 未知 null（消费方回退原文，禁静默吞）/ 空值 null；
 *  - summarizeRecentFailures：无失败 = ok:true；error+kind = 红行中文标签 + 处置动作随标签；
 *    aborted+abortedAt 两值标签；未知 kind 原样呈现（向后兼容禁静默）；ts 降序 top5。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ABORTED_AT_LABEL, FAILURE_KIND_IDS, failureKindLabel } from '../src/shared/failure-kinds.ts'
import { summarizeRecentFailures, type TurnEndLite } from '../src/host-core/doctor.ts'

test('s-kinds: 注册表对拍——9 类与内核 LlmErrorKind 一一对应（W-0 审计终表）', () => {
  assert.deepEqual(
    [...FAILURE_KIND_IDS].sort(),
    [
      'context-limit-suspect',
      'no-finish-reason',
      'proto-invalid-args',
      'provider-stream-error',
      'refusal',
      'stream-midbreak',
      'transport-4xx',
      'transport-exhausted',
      'unmapped-finish',
    ],
    '九类全在表（漏项 = 内核加类桌面未跟——fail-visible 钉死）',
  )
  // 处置动作随标签（W-0 审计映射——refusal 换模型 / context-limit 压缩）
  assert.ok(FAILURE_KIND_IDS.length === 9)
})

test('s-kinds: failureKindLabel——已知/未知/空值三态', () => {
  assert.equal(failureKindLabel('refusal'), '模型拒答（建议换模型或调整提示词）')
  assert.equal(failureKindLabel('transport-4xx'), '传输失败（provider 4xx）')
  assert.equal(failureKindLabel('context-limit-suspect'), '疑似上下文超限（建议压缩或缩短输入）')
  assert.equal(failureKindLabel('not-a-real-kind'), null, '未知类别 null——消费方回退原文呈现')
  assert.equal(failureKindLabel(undefined), null)
  assert.equal(failureKindLabel(null), null)
})

test('s-kinds: summarizeRecentFailures——无失败 ok:true / error+kind 红行中文标签', () => {
  // 无失败
  const empty = summarizeRecentFailures([{ ts: 1, meta: { reason: 'completed' } }])
  assert.equal(empty.ok, true)
  assert.match(empty.detail, /无 error\/aborted turn/)
  // error + kind（1.23.0 形态）→ 红行 + 中文标签
  const rows: TurnEndLite[] = [
    { ts: 10, meta: { reason: 'error', kind: 'context-limit-suspect' } },
  ]
  const r = summarizeRecentFailures(rows)
  assert.equal(r.ok, false, '失败在案 = 红行（fail-visible）')
  assert.ok(r.detail.includes('疑似上下文超限（建议压缩或缩短输入）'), '中文标签 + 处置动作随标签')
  assert.ok(r.detail.includes('error'))
})

test('s-kinds: summarizeRecentFailures——abortedAt 两值标签 / 未知 kind 原样 / ts 降序 top5', () => {
  const rows: TurnEndLite[] = [
    { ts: 1, meta: { reason: 'aborted', abortedAt: 'before-request' } },
    { ts: 2, meta: { reason: 'aborted', abortedAt: 'in-flight' } },
    { ts: 3, meta: { reason: 'error', kind: 'not-a-real-kind' } },
    { ts: 4, meta: { reason: 'error', kind: 'transport-4xx' } },
    { ts: 5, meta: { reason: 'error', kind: 'refusal' } },
    { ts: 6, meta: { reason: 'error', kind: 'stream-midbreak' } }, // top5 之外（ts=1 被裁）
  ]
  const r = summarizeRecentFailures(rows)
  assert.equal(r.ok, false)
  // ts 降序：midbreak(6) → refusal(5) → transport(4) → 未知(3) → in-flight(2)；before-request(1) 被裁
  assert.ok(r.detail.includes('流中断（已消费内容不重放）'))
  assert.ok(r.detail.includes('模型拒答'))
  assert.ok(r.detail.includes('传输失败'))
  assert.ok(r.detail.includes('not-a-real-kind（未知类别——原样呈现）'), '未知 kind 原样呈现（禁静默吞）')
  assert.ok(r.detail.includes('在途取消'), 'abortedAt in-flight 标签')
  assert.ok(!r.detail.includes('未发出即取消'), 'top5 裁剪（ts=1 before-request 出窗）')
  assert.ok(!r.detail.includes('completed'), '成功收口不入失败行')
  // abortedAt 标签表
  assert.equal(ABORTED_AT_LABEL['before-request'], '未发出即取消')
  assert.equal(ABORTED_AT_LABEL['in-flight'], '在途取消')
})
