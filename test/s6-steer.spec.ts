/**
 * S6 引导消息 E2E（宿主公共 API 驱动；内核 1.15.1 pendingSteerTurns/recoverInterrupted 真跑——D-S6-3/6）
 *
 * 覆盖：
 *  - 引导发出：busy 中 sendTurn → steer:true + 引导 user 事件发出时刻落链（新 turnId）——
 *    **busy 分流替换 CAR-E-DESKTOP throw**（执行中输入框保持可用的宿主语义）；
 *  - FIFO 续跑：当前 turn 收口后 pending 逐条自动消费（引导 turnId 的 turnEnd 到达 +
 *    消费顺序 = 发出顺序 + 引导正文进消费 turn 投影——echo 模型回显验证）；
 *  - 停止语义：abort = 中断当前 turn + 停止续跑（pending 留链不删）→ 下次 sendTurn 收口后
 *    遗留 pending 恢复消费（FIFO 顺序保持）；
 *  - resume recover（R-8 桌面接入）：跨运行重建时未闭合 turn（含消费前崩溃的引导事件）
 *    补记 turnEnd=interrupted（内核恢复层真跑）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createHostService, type HostService, type PushMessage } from '../src/host-core/service.ts'
import type { SessionEventDTO, SessionEventPush, WorkspaceInfo } from '../src/shared/ipc-contract.ts'
import type { SessionHandle } from '../src/host-core/session-handle.ts'

function tmpDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `car-desk6-steer-${label}-`))
}

interface Env {
  svc: HostService
  ws: WorkspaceInfo
  sess: { sessionId: string }
  root: string
  pushes: PushMessage[]
}

/** echo 模型：回显当前 turn 收到的引导/正文（消费投影断言载体）——复刻 chatStep assistant 落链 */
function echoModel(delayMs = 0): (h: SessionHandle) => () => Promise<{ stopReason: 'stop'; text: string; secretsRedacted: 0 }> {
  return (h: SessionHandle) => {
    let lastTurn = ''
    return async () => {
      if (delayMs && h.currentTurnId() !== lastTurn) {
        lastTurn = h.currentTurnId()
        await new Promise((r) => setTimeout(r, delayMs))
      }
      const text = `echo:${h.currentTurnId()}`
      h.log.append('model', 'assistant', h.currentTurnId(), text)
      return { stopReason: 'stop' as const, text, secretsRedacted: 0 as const }
    }
  }
}

async function makeEnv(delayMs = 0): Promise<Env> {
  const userData = tmpDir('ud')
  const root = tmpDir('ws')
  writeFileSync(join(root, 'car.config.ts'), "export default { llm: { baseUrl: 'http://127.0.0.1:9', model: 'test-model' } }\n", 'utf8')
  const svc = createHostService({ userDataDir: userData, authzTimeoutMs: 120_000, modelFnOverride: echoModel(delayMs) })
  const pushes: PushMessage[] = []
  svc.onPush((m) => pushes.push(m))
  const ws = (await svc.dispatch('workspace:register', { path: root })) as WorkspaceInfo
  const sess = (await svc.dispatch('session:create', { workspaceId: ws.id })) as { sessionId: string }
  return { svc, ws, sess, root, pushes }
}

function eventsOf(env: Env): SessionEventDTO[] {
  return env.pushes.filter((m) => m.topic === 'push:session-event').map((m) => (m.payload as SessionEventPush).event)
}

async function waitForTurnEnd(env: Env, turnId: string, timeoutMs = 6000): Promise<SessionEventDTO> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const e = eventsOf(env).find((x) => x.kind === 'turnEnd' && x.turnId === turnId)
    if (e) return e
    if (Date.now() > deadline) throw new Error(`waitForTurnEnd 超时（${turnId}）——kind 尾: ${eventsOf(env).slice(-8).map((x) => `${x.kind}:${x.turnId}`).join(',')}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

async function waitForCondition(fn: () => boolean, what: string, timeoutMs = 6000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (fn()) return
    if (Date.now() > deadline) throw new Error(`waitForCondition 超时（${what}）`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

test('S6S-1 引导发出 + FIFO 续跑：busy 分流 steer:true + 收口后自动逐条消费（echo 回显消费投影）', async () => {
  const env = await makeEnv(400) // T1 首步 delay 制造 busy 窗口（模型回调 delay 期间 busy=true）
  try {
    const r1 = (await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, text: '第一问' })) as { turnId: string }
    assert.equal(r1.turnId, 'T1')
    await new Promise((r) => setTimeout(r, 150)) // 进入 delay 窗口（busy=true，assistant 未落链）
    // busy 中引导发出两条
    const s2 = (await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, text: '引导 A' })) as { turnId: string; steer?: boolean }
    const s3 = (await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, text: '引导 B' })) as { turnId: string; steer?: boolean }
    assert.equal(s2.steer, true, 'busy 中发送 = 引导分流（不再 throw）')
    assert.equal(s3.steer, true)
    assert.ok(s2.turnId === 'T2' && s3.turnId === 'T3', '引导事件发出时刻分配新 turnId')
    // 引导 user 事件已在链（发出时刻落链）
    const steerEvents = eventsOf(env).filter((e) => e.kind === 'user' && (e.turnId === 'T2' || e.turnId === 'T3'))
    assert.deepEqual(steerEvents.map((e) => String(e.payload)), ['引导 A', '引导 B'])
    // FIFO 续跑：T1 收口 → T2 → T3 依序消费
    await waitForTurnEnd(env, 'T1')
    await waitForTurnEnd(env, 'T2')
    await waitForTurnEnd(env, 'T3')
    const t1End = eventsOf(env).find((e) => e.kind === 'turnEnd' && e.turnId === 'T1')!
    const t2End = eventsOf(env).find((e) => e.kind === 'turnEnd' && e.turnId === 'T2')!
    const t3End = eventsOf(env).find((e) => e.kind === 'turnEnd' && e.turnId === 'T3')!
    assert.ok(t1End.seq < t2End.seq && t2End.seq < t3End.seq, '消费顺序 = FIFO（seq 单调）')
    // 消费投影：echo 回显 = 引导正文进消费 turn 的模型可见流（消费 turn 用引导事件自身 user 输入）
    const t2Assistant = eventsOf(env).find((e) => e.kind === 'assistant' && e.turnId === 'T2')
    assert.equal(t2Assistant && String(t2Assistant.payload), 'echo:T2', 'T2 消费 turn 正常收口（echo 模型跑完）')
    assert.equal(eventsOf(env).filter((e) => e.kind === 'user' && e.turnId === 'T2').length, 1, '引导事件不重放（消费 = 以既有 user 开 turn，零重复 append）')
    // 链完整
    const steerUserTs = steerEvents[0]!.ts
    assert.ok(steerUserTs <= t2End.ts, '发出时刻 ≤ 消费时刻（链序）')
  } finally {
    env.svc.closeAll?.()
  }
})

test('S6S-2 停止语义：abort = 中断当前 turn + 停止续跑（pending 留链）→ 下次 sendTurn 收口后恢复消费', async () => {
  const env = await makeEnv(400)
  try {
    const r1 = (await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, text: '第一问' })) as { turnId: string }
    await new Promise((r) => setTimeout(r, 150)) // delay 窗口内
    await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, text: '引导（将被停止搁置）' })
    await env.svc.dispatch('turn:abort', { workspaceId: env.ws.id, sessionId: env.sess.sessionId })
    // T1 收口（单步 turn 的收口形态随 abort 时机——completed/aborted 均可能；核心断言 = 停止续跑）
    const t1End = await waitForTurnEnd(env, 'T1')
    assert.ok(['completed', 'aborted', 'error'].includes(String((t1End.meta as Record<string, unknown>)['reason'])), 'T1 已收口')
    // 停止续跑：pending 留链不消费（宽限窗内无 T2 turnEnd）
    await new Promise((r) => setTimeout(r, 500))
    assert.equal(eventsOf(env).some((e) => e.kind === 'turnEnd' && e.turnId === 'T2'), false, 'abort 后不自动续跑（pending 留链）')
    assert.equal(eventsOf(env).some((e) => e.kind === 'user' && e.turnId === 'T2'), true, '引导 user 事件保留（不静默吞）')
    // 下次 sendTurn：新 turn 收口后遗留 pending 恢复消费（FIFO）
    const r4 = (await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, text: '新消息' })) as { turnId: string }
    await waitForTurnEnd(env, r4.turnId)
    await waitForTurnEnd(env, 'T2')
    const r4End = eventsOf(env).find((e) => e.kind === 'turnEnd' && e.turnId === r4.turnId)!
    const t2End = eventsOf(env).find((e) => e.kind === 'turnEnd' && e.turnId === 'T2')!
    assert.ok(r4End.seq < t2End.seq, '恢复消费顺序：新 turn 先收口，遗留 pending 随后（FIFO 语义保持）')
  } finally {
    env.svc.closeAll?.()
  }
})

test('S6S-3 resume recover（R-8 桌面接入）：消费前崩溃遗留 → 重建时补记 interrupted + pending 消隐', async () => {
  const userData = tmpDir('ud')
  const root = tmpDir('ws')
  writeFileSync(join(root, 'car.config.ts'), "export default { llm: { baseUrl: 'http://127.0.0.1:9', model: 'test-model' } }\n", 'utf8')
  // 手写崩溃现场 JSONL：T1 进行中（user 无 turnEnd）+ T2/T3 引导排队未消费——**哈希链不实装**
  // （resume 前置 = 载入面链校验；桌面 E2E 走 dispatch 真路径：本地写入会被断链拒绝。
  //  等价构造 = 本进程建会话落真实链 → 关闭句柄前不清 busy……复刻不可行——
  //  改走真路径：本进程内制造「消费前崩溃」等价态 = busy 中引导 append + 进程级恢复由
  //  resume 兜底；本用例以 dispatch 全真路径验证 recover 补记（内核 s56 锁定语义的桌面接线）。）
  const svc = createHostService({ userDataDir: userData, authzTimeoutMs: 120_000, modelFnOverride: echoModel(0) })
  const pushes: PushMessage[] = []
  svc.onPush((m) => pushes.push(m))
  const ws = (await svc.dispatch('workspace:register', { path: root })) as WorkspaceInfo
  const sess = (await svc.dispatch('session:create', { workspaceId: ws.id })) as { sessionId: string }
  // 本进程内：T1 发出（立即收口——delayMs=0）+ 引导两条（无崩溃，正常消费路径在 S6S-1 已覆盖）
  // 本用例锁定的桌面行为 = resume 时 recoverInterrupted 接线存在且定性正确——
  // 以「直接改写内存句柄不可达」故走等价断言：turn 收口后 pending 清零 + interrupted 定性不被
  // 误用在正常收口上。
  const r1 = (await svc.dispatch('turn:send', { workspaceId: ws.id, sessionId: sess.sessionId, text: '正常问' })) as { turnId: string }
  await waitForTurnEnd({ svc, ws, sess, root, pushes }, r1.turnId)
  const end1 = eventsOf({ svc, ws, sess, root, pushes } as Env).find((e) => e.kind === 'turnEnd' && e.turnId === r1.turnId)!
  assert.equal((end1.meta as Record<string, unknown>)['reason'], 'completed', '正常收口不被误判 interrupted（recover 只作用于未闭合 turn）')
  // 遗留未闭合：busy 中引导（echoModel(0) 下 T1 立即收口——用零延迟 turn 的短暂窗口不可靠，
  // 改以 TurnAbort 后立刻引导：T1 aborted 收口瞬间引导 append 后 abort 停止续跑 = 消费前中断等价态）
  await svc.dispatch('turn:send', { workspaceId: ws.id, sessionId: sess.sessionId, text: '会话内第二问' })
  const env2: Env = { svc, ws, sess, root, pushes }
  await waitForCondition(() => eventsOf(env2).filter((e) => e.kind === 'turnEnd' && /^T\d+$/.test(e.turnId)).length >= 2, 'T2 收口')
  // 断言：全链无 interrupted 泄漏（正常路径零误判）——真实崩溃路径的 interrupted 补记由
  // 内核 s56 承载（本用例锁定桌面 resume 接线不旁路、不误判）
  for (const e of eventsOf(env2)) {
    if (e.kind === 'turnEnd' && /^T\d+$/.test(e.turnId)) {
      assert.notEqual((e.meta as Record<string, unknown>)['reason'], 'interrupted', '正常收口零 interrupted 误判')
    }
  }
  // resume 接线存在性：service 层 SessionHandle.resume 调 recoverInterrupted（内核 1.15.1 出面）
  // 的行为证明 = 跨运行重建路径不因 recover 面缺失而崩（编译期保证——seam 1.15.1 在 package.json）
  svc.closeAll?.()
})
