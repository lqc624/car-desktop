/**
 * R-v03-1 回归：模型错误时引导 FIFO 消费有界（2026-10-23 v0.3 终验步⑦③红条）
 *
 * 红条形态：drainPending 启动引导 run 未置 busy 门控 → 轮询门 `!this.busy` 恒真 →
 * 25ms tick 内未收口的引导被反复重发（失败耗时 30s ≫ tick → 上千并发重复 run →
 * 审计链刷数百条 turnEnd error）。修复 = busy 门控 + 已尝试守卫。
 *
 * 本测试用 200ms 失败耗时（≫ 25ms tick——修复前必然触发重发窗口）断言：
 * 每条引导恰好一次 error 收口（turnEnd 计数 = 1），链事件总量有界。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createHostService, type HostService, type PushMessage } from '../src/host-core/service.ts'
import type { WorkspaceInfo } from '../src/shared/ipc-contract.ts'
import type { SessionHandle } from '../src/host-core/session-handle.ts'

function tmpDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `car-redbar-steer-${label}-`))
}

/**
 * 可控模型：首次调用 hang 300ms 后拒（保持 busy 窗口供引导排队）；
 * 后续调用 200ms 后拒（≫ 25ms 轮询 tick——修复前每个 tick 重发一次）。
 */
function gatedRejectingModel(): (h: SessionHandle) => () => Promise<{ stopReason: 'stop'; text: string; secretsRedacted: 0 }> {
  let first = true
  return (_h: SessionHandle) => async () => {
    if (first) {
      first = false
      await new Promise((r) => setTimeout(r, 300))
    } else {
      await new Promise((r) => setTimeout(r, 200))
    }
    throw new Error('CAR-E-LLM-UNREACHABLE: socket hang up')
  }
}

test('R-v03-1: steer drain under persistent model error stays bounded', async () => {
  const userData = tmpDir('ud')
  const root = tmpDir('ws')
  writeFileSync(join(root, 'car.config.ts'), "export default { llm: { baseUrl: 'http://127.0.0.1:9', model: 'test-model' } }\n", 'utf8')
  const svc = createHostService({ userDataDir: userData, authzTimeoutMs: 120_000, modelFnOverride: gatedRejectingModel() })
  const pushes: PushMessage[] = []
  svc.onPush((m) => pushes.push(m))
  const ws = (await svc.dispatch('workspace:register', { path: root })) as WorkspaceInfo
  const sess = (await svc.dispatch('session:create', { workspaceId: ws.id })) as { sessionId: string }
  const sid = sess.sessionId
  const wid = ws.id

  // T1 开 busy 窗口（不 await——300ms 后拒）；窗口内排队两条引导
  void svc.dispatch('turn:send', { workspaceId: wid, sessionId: sid, text: 'T1-主消息' })
  await new Promise((r) => setTimeout(r, 80))
  void svc.dispatch('turn:send', { workspaceId: wid, sessionId: sid, text: '引导A' })
  await new Promise((r) => setTimeout(r, 80))
  void svc.dispatch('turn:send', { workspaceId: wid, sessionId: sid, text: '引导B' })
  // 等 T1 error 收口 + drain 逐条消费（修复前：200ms 失败窗内每 25ms 重发 → 数十条重复 turnEnd）
  await new Promise((r) => setTimeout(r, 6000))
  const rep = (await svc.dispatch('audit:report', { workspaceId: wid, sessionId: sid })) as {
    events: Array<{ kind: string; turnId: string; meta?: Record<string, unknown> }>
  }
  const ends = rep.events.filter((e) => e.kind === 'turnEnd')
  const byTurn: Record<string, number> = {}
  for (const e of ends) byTurn[e.turnId] = (byTurn[e.turnId] ?? 0) + 1
  console.log('turnEnd counts by turnId:', JSON.stringify(byTurn))
  console.log('total events:', rep.events.length)
  // 有界断言：三条 turn 各恰一次收口；无重复消费
  assert.deepEqual(byTurn, { T1: 1, T2: 1, T3: 1 }, '每条 turn 恰一次收口（禁重复消费刷链）')
  assert.ok(rep.events.length <= 12, `链事件总量有界（实际 ${rep.events.length}）`)
})
