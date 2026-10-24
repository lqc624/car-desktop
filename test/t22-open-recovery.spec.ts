/**
 * T-22 打开即恢复 E2E（D-S6-7 / v0.3 D1；内核 recoverInterrupted / pendingSteerTurns 真跑）
 *
 * 判据：
 *  - session:open 历史会话（链完整）→ 即建可续写句柄：interrupted turn 补记 turnEnd
 *    （meta.recovered）+ 未配对 toolCall 合成 toolResult + pendingSteerTurns 扫描随
 *    recovery 报告返回（首屏即补记后状态，替代惰性形态）；
 *  - 恢复动作可见：session/recover 叙事落链（禁静默补记）+ 补记后链校验仍完整 +
 *    新 turn 不与历史撞号；
 *  - 只读回放保留面：断链（VD3 查看）/ 已删除（索引权威）→ 无句柄无追加、recovery null；
 *  - 干净打开零追加：无恢复动作时事件数不变、无 session/recover 叙事（禁噪声写链）。
 * 前提纪律：全注入临时目录；E2E 经宿主公共 API 驱动；内核真跑 + 假模型复刻落链口径。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createHostService, type HostService, type PushMessage } from '../src/host-core/service.ts'
import { sessionsDirFor } from '../src/host-core/sessions.ts'
import type { AuditReport, SessionEventDTO, SessionEventPush, SessionOpenResult, WorkspaceInfo } from '../src/shared/ipc-contract.ts'
import type { SessionHandle } from '../src/host-core/session-handle.ts'
import type { HostModelStep } from '../src/host-core/types.ts'

function tmpDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `car-t22-${label}-`))
}

interface Env {
  svc: HostService
  ws: WorkspaceInfo
  sess: { sessionId: string }
  root: string
  pushes: PushMessage[]
}

/** echo 模型（复刻 chatStep assistant 落链口径） */
function echoModel(delayMs = 0): (h: SessionHandle) => () => Promise<HostModelStep> {
  return (h: SessionHandle) => {
    let lastTurn = ''
    return async () => {
      if (delayMs && h.currentTurnId() !== lastTurn) {
        lastTurn = h.currentTurnId()
        await new Promise((r) => setTimeout(r, delayMs))
      }
      const text = `echo:${h.currentTurnId()}`
      h.log.append('model', 'assistant', h.currentTurnId(), text)
      return { stopReason: 'stop', text, secretsRedacted: 0 as const }
    }
  }
}

/** 工具调用模型：首步发起 fs_write（授权门挂起 = 「崩溃前未收口」等价态制造器） */
function toolCallModel(): (h: SessionHandle) => () => Promise<HostModelStep> {
  return (h: SessionHandle) => {
    let lastTurn = ''
    return async () => {
      const t = h.currentTurnId()
      if (t !== lastTurn) {
        lastTurn = t
        return { stopReason: 'toolUse', toolCalls: [{ id: 'c-' + t, tool: 'fs_write', args: { path: join(h.workspaceRoot, 'x.txt'), content: 'v' } }] }
      }
      const text = 'done'
      h.log.append('model', 'assistant', t, text)
      return { stopReason: 'stop', text, secretsRedacted: 0 as const }
    }
  }
}

async function makeEnv(modelFn: (h: SessionHandle) => (s: HostModelStep) => Promise<HostModelStep>): Promise<Env> {
  const userData = tmpDir('ud')
  const root = tmpDir('ws')
  writeFileSync(join(root, 'car.config.ts'), "export default { llm: { baseUrl: 'http://127.0.0.1:9', model: 'test-model' } }\n", 'utf8')
  const svc = createHostService({ userDataDir: userData, modelFnOverride: modelFn })
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

test('T22-1 打开即恢复：授权挂起态跨运行 open → 补记 interrupted + 合成 toolResult + session/recover 落链', async () => {
  // svc1：turn 发起 fs_write → 授权 pending 不应答 = 崩溃前未收口等价态（user/toolCall 在链、无 turnEnd）
  const env1 = await makeEnv(toolCallModel())
  try {
    await env1.svc.dispatch('turn:send', { workspaceId: env1.ws.id, sessionId: env1.sess.sessionId, text: '待收口的一轮' })
    await waitForCondition(() => env1.pushes.some((m) => m.topic === 'push:authz-pending'), '授权 pending 推送')
    const before = (await env1.svc.dispatch('audit:report', { workspaceId: env1.ws.id, sessionId: env1.sess.sessionId })) as AuditReport
    assert.equal(before.chain.intact, true)
    // svc2：「新进程」打开同一会话——open 即建句柄（T-22 语义）
    const svc2 = createHostService({ userDataDir: tmpDir('ud2'), modelFnOverride: echoModel(0) })
    const ws2 = (await svc2.dispatch('workspace:register', { path: env1.root })) as WorkspaceInfo
    const opened = (await svc2.dispatch('session:open', { workspaceId: ws2.id, sessionId: env1.sess.sessionId })) as SessionOpenResult
    assert.ok(opened.recovery, '打开即恢复：recovery 报告随 open 返回')
    assert.equal(opened.recovery.interruptedTurns, 1, '未闭合 turn 补记 ×1')
    assert.equal(opened.recovery.syntheticToolResults, 1, '未配对 toolCall 合成 toolResult ×1')
    assert.equal(opened.recovery.pendingSteers, 0)
    // 补记形态：turnEnd=interrupted（meta.recovered）+ session/recover 叙事在链
    const t1End = opened.events.find((e) => e.kind === 'turnEnd' && e.turnId === 'T1')!
    assert.ok(t1End, 'T1 turnEnd 已补记')
    assert.equal((t1End.meta as Record<string, unknown>)['reason'], 'interrupted')
    assert.equal((t1End.meta as Record<string, unknown>)['recovered'], true)
    const recEvent = opened.events.find((e) => e.kind === 'system' && (e.payload as Record<string, unknown> | null)?.['type'] === 'session/recover')
    assert.ok(recEvent, 'session/recover 叙事落链（禁静默补记）')
    const recPayload = recEvent!.payload as Record<string, unknown>
    assert.equal(recPayload['interruptedTurns'], 1)
    assert.equal(recPayload['pendingSteers'], 0)
    // 补记后链仍完整（只追加不改写红线）+ 打开即续写可用且不撞号
    const report = (await svc2.dispatch('audit:report', { workspaceId: ws2.id, sessionId: env1.sess.sessionId })) as AuditReport
    assert.equal(report.chain.intact, true, '补记后链完整')
    report.events.forEach((e, i) => assert.equal(e.seq, i, `seq 缺口 @${i}`))
    const sent = (await svc2.dispatch('turn:send', { workspaceId: ws2.id, sessionId: env1.sess.sessionId, text: '续写' })) as { turnId: string }
    assert.equal(sent.turnId, 'T2', '新 turn 序号 = 历史最大 +1（不撞号）')
    svc2.closeAll?.()
  } finally {
    env1.svc.closeAll?.()
  }
})

test('T22-2 打开即恢复·引导定性锁定（R-8/s56）：崩溃前排队引导按「已发未跑」补记终止——不重复消费', async () => {
  // svc1：T1 进行中引导 T2 → abort 停止续跑 = 「崩溃前引导已发未跑」等价态（T1/T2 均无 turnEnd）
  const env1 = await makeEnv(echoModel(400))
  try {
    await env1.svc.dispatch('turn:send', { workspaceId: env1.ws.id, sessionId: env1.sess.sessionId, text: '第一问' })
    await new Promise((r) => setTimeout(r, 150)) // delay 窗口（busy）
    await env1.svc.dispatch('turn:send', { workspaceId: env1.ws.id, sessionId: env1.sess.sessionId, text: '引导（崩溃前排队）' })
    await env1.svc.dispatch('turn:abort', { workspaceId: env1.ws.id, sessionId: env1.sess.sessionId })
    await waitForTurnEnd(env1, 'T1')
    await new Promise((r) => setTimeout(r, 300))
    assert.ok(eventsOf(env1).some((e) => e.kind === 'user' && e.turnId === 'T2'), '引导 user 事件在链')
    assert.ok(!eventsOf(env1).some((e) => e.kind === 'turnEnd' && e.turnId === 'T2'), 'T2 未消费（崩溃现场：user 无 turnEnd）')
    // svc2：open 即补记——T1（执行中崩溃）与 T2（排队未跑）一并 interrupted 定性终止；
    // pendingSteerTurns 扫描 = 0（已补记 interrupted 不算 pending——重启后不重复消费，内核 steer.ts:43 口径）
    const svc2 = createHostService({ userDataDir: tmpDir('ud2'), modelFnOverride: echoModel(0) })
    const ws2 = (await svc2.dispatch('workspace:register', { path: env1.root })) as WorkspaceInfo
    const opened = (await svc2.dispatch('session:open', { workspaceId: ws2.id, sessionId: env1.sess.sessionId })) as SessionOpenResult
    assert.ok(opened.recovery)
    assert.equal(opened.recovery.interruptedTurns, 1, '排队 T2 补记 ×1（「已发未跑」定性终止）')
    assert.equal(opened.recovery.pendingSteers, 0, '补记后无 pending（不重复消费）')
    const t2End = opened.events.find((e) => e.kind === 'turnEnd' && e.turnId === 'T2')!
    assert.ok(t2End, 'T2 turnEnd 已补记（打开即消隐惰性徽标）')
    assert.equal((t2End.meta as Record<string, unknown>)['reason'], 'interrupted')
    assert.equal((t2End.meta as Record<string, unknown>)['recovered'], true)
    const recEvent = opened.events.find((e) => e.kind === 'system' && (e.payload as Record<string, unknown> | null)?.['type'] === 'session/recover')
    assert.ok(recEvent, 'session/recover 叙事落链')
    assert.equal((recEvent!.payload as Record<string, unknown>)['pendingSteers'], 0)
    // 补记后链完整 + 续写不撞号 + 排队引导不被重新消费（其 turnEnd 已落，drainPending 扫描不到）
    const pushes2: PushMessage[] = []
    svc2.onPush((m) => pushes2.push(m))
    const env2: Env = { svc: svc2, ws: ws2, sess: env1.sess, root: env1.root, pushes: pushes2 }
    const sent = (await svc2.dispatch('turn:send', { workspaceId: ws2.id, sessionId: env1.sess.sessionId, text: '新消息' })) as { turnId: string }
    await waitForTurnEnd(env2, sent.turnId)
    assert.equal(sent.turnId, 'T3', '新 turn 序号 = 历史最大 +1（不撞号）')
    assert.ok(!eventsOf(env2).some((e) => e.kind === 'assistant' && e.turnId === 'T2'), '排队引导不被重新消费（已定性终止）')
    const report = (await svc2.dispatch('audit:report', { workspaceId: ws2.id, sessionId: env1.sess.sessionId })) as AuditReport
    assert.equal(report.chain.intact, true)
    svc2.closeAll?.()
  } finally {
    env1.svc.closeAll?.()
  }
})

test('T22-3 断链打开 = 只读回放保留面：recovery null + 无追加 + 续写 fail-visible（VD3）', async () => {
  const env = await makeEnv(echoModel(0))
  try {
    const t1 = (await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, text: '一' })) as { turnId: string }
    await waitForTurnEnd(env, t1.turnId)
    const file = join(sessionsDirFor(env.root), env.sess.sessionId + '.jsonl')
    const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim())
    const tampered = JSON.parse(lines[2]) as Record<string, unknown>
    tampered['payload'] = '被篡改'
    lines[2] = JSON.stringify(tampered)
    writeFileSync(file, lines.join('\n') + '\n', 'utf8')
    const before = (await env.svc.dispatch('audit:report', { workspaceId: env.ws.id, sessionId: env.sess.sessionId })) as AuditReport
    const svc2 = createHostService({ userDataDir: tmpDir('ud2'), modelFnOverride: echoModel(0) })
    const ws2 = (await svc2.dispatch('workspace:register', { path: env.root })) as WorkspaceInfo
    const opened = (await svc2.dispatch('session:open', { workspaceId: ws2.id, sessionId: env.sess.sessionId })) as SessionOpenResult
    assert.equal(opened.recovery ?? null, null, '断链 = 无恢复动作（只读回放保留）')
    assert.equal(opened.events.length, before.eventCount, '打开零追加')
    assert.ok(!opened.events.some((e) => (e.payload as Record<string, unknown> | null)?.['type'] === 'session/recover'), '无 session/recover 叙事')
    await assert.rejects(
      () => svc2.dispatch('turn:send', { workspaceId: ws2.id, sessionId: env.sess.sessionId, text: '续写' }),
      (err: Error) => /链断裂|拒绝续写/.test(err.message),
      '断链拒绝续写（先修审计面）',
    )
    svc2.closeAll?.()
  } finally {
    env.svc.closeAll?.()
  }
})

test('T22-4 已删除会话打开 = 只读回放（索引权威）：recovery null + 续写拒绝', async () => {
  const env = await makeEnv(echoModel(0))
  const sid = env.sess.sessionId
  try {
    const t1 = (await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: sid, text: '一' })) as { turnId: string }
    await waitForTurnEnd(env, t1.turnId)
    await env.svc.dispatch('session:delete', { workspaceId: env.ws.id, sessionId: sid })
    const svc2 = createHostService({ userDataDir: tmpDir('ud2'), modelFnOverride: echoModel(0) })
    const ws2 = (await svc2.dispatch('workspace:register', { path: env.root })) as WorkspaceInfo
    const opened = (await svc2.dispatch('session:open', { workspaceId: ws2.id, sessionId: sid })) as SessionOpenResult
    assert.equal(opened.exists, true, '已删除会话可查看（回放）')
    assert.equal(opened.recovery ?? null, null, '删除态不建句柄')
    await assert.rejects(
      () => svc2.dispatch('turn:send', { workspaceId: ws2.id, sessionId: sid, text: '续写' }),
      (err: Error) => /已删除/.test(err.message),
    )
    svc2.closeAll?.()
  } finally {
    env.svc.closeAll?.()
  }
})

test('T22-5 干净打开零追加：无恢复动作时事件数不变、无叙事、二次打开同态', async () => {
  const env = await makeEnv(echoModel(0))
  try {
    const t1 = (await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, text: '一' })) as { turnId: string }
    await waitForTurnEnd(env, t1.turnId)
    const before = (await env.svc.dispatch('audit:report', { workspaceId: env.ws.id, sessionId: env.sess.sessionId })) as AuditReport
    const svc2 = createHostService({ userDataDir: tmpDir('ud2'), modelFnOverride: echoModel(0) })
    const ws2 = (await svc2.dispatch('workspace:register', { path: env.root })) as WorkspaceInfo
    const opened = (await svc2.dispatch('session:open', { workspaceId: ws2.id, sessionId: env.sess.sessionId })) as SessionOpenResult
    assert.deepEqual(opened.recovery, { interruptedTurns: 0, syntheticToolResults: 0, pendingSteers: 0 }, '干净链 = 全零恢复报告')
    assert.equal(opened.events.length, before.eventCount, '干净打开零追加')
    assert.ok(!opened.events.some((e) => (e.payload as Record<string, unknown> | null)?.['type'] === 'session/recover'), '无恢复动作不写叙事（禁噪声写链）')
    const after = (await svc2.dispatch('audit:report', { workspaceId: ws2.id, sessionId: env.sess.sessionId })) as AuditReport
    assert.equal(after.eventCount, before.eventCount, '盘面零变化')
    assert.equal(after.chain.intact, true)
    // 二次打开（alive 快路径）同态
    const reopened = (await svc2.dispatch('session:open', { workspaceId: ws2.id, sessionId: env.sess.sessionId })) as SessionOpenResult
    assert.equal(reopened.events.length, opened.events.length)
    svc2.closeAll?.()
  } finally {
    env.svc.closeAll?.()
  }
})
