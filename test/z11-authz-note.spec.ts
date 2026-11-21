/**
 * z11 · 0.12.0 同意面结构化（Z-11 / D-V12-3 + 内核 1.25.1 D-V12-1）
 *
 * 判据：
 *  - 附注随决策落链（单事件完整审计面）：authz:respond +note → 内核 1.25.1 decideByUser 对象形态
 *    → 决策事件（turnId authz:*）payload +note——批准/拒绝两档皆可带；
 *  - 无附注字节兼容：payload 恰四键（authorizationId/decision/decidedBy/degraded）；
 *  - 批量多选扇出语义：多 pending 逐卡 respond（链上恒逐卡决策事件——UI 批量不合并链面）；
 *  - 预算/超时形态不在本 spec（内核 s83 覆盖）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createHostService, type HostService, type PushMessage } from '../src/host-core/service.ts'
import type { SessionEventDTO, SessionEventPush, WorkspaceInfo } from '../src/shared/ipc-contract.ts'
import type { SessionHandle } from '../src/host-core/session-handle.ts'
import type { HostModelFn, HostModelStep } from '../src/host-core/types.ts'

function tmpDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `car-z11-${label}-`))
}

function emitAssistant(h: SessionHandle, s: HostModelStep): HostModelStep {
  if (typeof s.text === 'string' && s.text.length > 0) {
    h.log.append('model', 'assistant', h.currentTurnId(), s.text)
  }
  return s
}

interface Env {
  svc: HostService
  ws: WorkspaceInfo
  sess: { sessionId: string }
  root: string
  pushes: PushMessage[]
}

/** 工具调用参数按回合内序号递增（callsPerTurn = 每 turn 门数——ask 档路径 → 人审门可达） */
async function makeEnv(paths: string[], callsPerTurn = 1): Promise<Env> {
  const userData = tmpDir('ud')
  const root = tmpDir('ws')
  writeFileSync(join(root, 'car.config.ts'), "export default { llm: { baseUrl: 'http://127.0.0.1:9', model: 'test-model' } }\n", 'utf8')
  const svc = createHostService({
    userDataDir: userData,
    modelFnOverride: (h: SessionHandle) => {
      let lastTurn = ''
      let callsInTurn = 0
      let pathIndex = 0
      return async (): Promise<HostModelStep> => {
        const t = h.currentTurnId()
        if (t !== lastTurn) {
          lastTurn = t
          callsInTurn = 0
        }
        if (callsInTurn < callsPerTurn && pathIndex < paths.length) {
          const p = paths[pathIndex++]
          callsInTurn++
          return { stopReason: 'toolUse', toolCalls: [{ id: 'c-' + t + ':' + callsInTurn, tool: 'fs_write', args: { path: p, content: 'x' } } as unknown as Record<string, unknown>] }
        }
        return emitAssistant(h, { stopReason: 'stop', text: 'done' })
      }
    },
  })
  const pushes: PushMessage[] = []
  svc.onPush((m) => pushes.push(m))
  const ws = (await svc.dispatch('workspace:register', { path: root })) as WorkspaceInfo
  const sess = (await svc.dispatch('session:create', { workspaceId: ws.id })) as { sessionId: string }
  return { svc, ws, sess, root, pushes }
}

function eventsOf(env: Env): SessionEventDTO[] {
  return env.pushes.filter((m) => m.topic === 'push:session-event').map((m) => (m.payload as SessionEventPush).event)
}
function pendingsOf(env: Env): Array<Record<string, unknown>> {
  return env.pushes.filter((m) => m.topic === 'push:authz-pending').map((m) => m.payload as Record<string, unknown>)
}
async function waitForPending(env: Env, count = 1): Promise<void> {
  const deadline = Date.now() + 3000
  for (;;) {
    if (pendingsOf(env).length >= count) return
    if (Date.now() > deadline) throw new Error(`pending 未推送（期望 ${count}，见 ${pendingsOf(env).length}）`)
    await new Promise((r) => setTimeout(r, 10))
  }
}
async function waitForTurnEnd(env: Env, turnId: string, timeoutMs = 5000): Promise<SessionEventDTO> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const e = eventsOf(env).find((x) => x.kind === 'turnEnd' && x.turnId === turnId)
    if (e) return e
    if (Date.now() > deadline) throw new Error(`waitForTurnEnd 超时（${turnId}）`)
    await new Promise((r) => setTimeout(r, 20))
  }
}
function authzDecisionEvents(env: Env): Array<{ turnId: string; payload: Record<string, unknown> }> {
  return eventsOf(env)
    .filter((e) => e.turnId.startsWith('authz:'))
    .map((e) => ({ turnId: e.turnId, payload: e.payload as Record<string, unknown> }))
}

test('Z11-1 附注随批准决策落链（单事件完整审计面——内核 1.25.1 payload +note）', async () => {
  const env = await makeEnv(['out-a.txt'])
  const t = (await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, text: '写 out-a.txt' })) as { turnId: string }
  await waitForPending(env)
  await env.svc.dispatch('authz:respond', {
    workspaceId: env.ws.id,
    sessionId: env.sess.sessionId,
    requestId: pendingsOf(env).at(-1)!['requestId'],
    decision: 'once',
    note: '仅限本次构建目录产物',
  })
  await waitForTurnEnd(env, t.turnId)
  const dec = authzDecisionEvents(env).filter((x) => x.turnId.includes('fs_write'))
  assert.equal(dec.length, 1, '恰一条人审决策事件')
  assert.equal(dec[0]!.payload['decision'], 'APPROVED')
  assert.equal(dec[0]!.payload['note'], '仅限本次构建目录产物', '附注落决策事件 payload（批准档）')
})

test('Z11-2 附注随拒绝决策落链 + 无附注字节兼容（payload 恰四键）', async () => {
  const env = await makeEnv(['out-deny.txt', 'out-plain.txt'])
  // 卡 1：拒绝 + 附注（拒绝理由可溯）
  const t1 = (await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, text: '写 out-deny.txt' })) as { turnId: string }
  await waitForPending(env)
  await env.svc.dispatch('authz:respond', {
    workspaceId: env.ws.id,
    sessionId: env.sess.sessionId,
    requestId: pendingsOf(env).at(-1)!['requestId'],
    decision: 'deny',
    note: '该路径未在白名单，先补规则',
  })
  await waitForTurnEnd(env, t1.turnId)
  const denyDec = authzDecisionEvents(env).at(-1)!
  assert.equal(denyDec.payload['decision'], 'EXPIRED', '拒绝档内核记 EXPIRED（既有语义——回调实答区分展示口径）')
  assert.equal(denyDec.payload['note'], '该路径未在白名单，先补规则', '附注落决策事件 payload（拒绝档）')
  // 卡 2：批准无附注 → payload 恰四键（1.25.1 前形态字节兼容）
  const t2 = (await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, text: '写 out-plain.txt' })) as { turnId: string }
  await waitForPending(env)
  await env.svc.dispatch('authz:respond', {
    workspaceId: env.ws.id,
    sessionId: env.sess.sessionId,
    requestId: pendingsOf(env).at(-1)!['requestId'],
    decision: 'once',
  })
  await waitForTurnEnd(env, t2.turnId)
  const plainDec = authzDecisionEvents(env).at(-1)!
  assert.equal(plainDec.payload['decision'], 'APPROVED')
  assert.equal('note' in plainDec.payload, false, '无附注 payload 无 note 键（字节兼容）')
  assert.deepEqual(
    new Set(Object.keys(plainDec.payload)),
    new Set(['authorizationId', 'decision', 'decidedBy', 'degraded']),
    'payload 恰四键（1.25.0 前形态）',
  )
})

test('Z11-3 批量扇出 = 链上逐卡决策事件（同附注逐卡应答——append-only 逐卡落链不合并）', async () => {
  // 单回合两连门（父回合门串行推进——卡逐张出现，批量语义 = 同附注逐卡应答；
  // 多卡并发共存形态 = 子代理并发门（k2 spec 覆盖），UI 批量条服务于两类队列）
  const env = await makeEnv(['out-b1.txt', 'out-b2.txt'], 2)
  const t = (await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, text: '批量写两个文件' })) as { turnId: string }
  await waitForPending(env, 1)
  // 卡 1 → 卡 2 串行推进（同附注逐卡应答——App respondBatch 循环体同构）
  await env.svc.dispatch('authz:respond', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, requestId: pendingsOf(env).at(-1)!['requestId'], decision: 'once', note: '批量附注（本批构建产物）' })
  await waitForPending(env, 2)
  await env.svc.dispatch('authz:respond', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, requestId: pendingsOf(env).at(-1)!['requestId'], decision: 'once', note: '批量附注（本批构建产物）' })
  await waitForTurnEnd(env, t.turnId)
  const dec = authzDecisionEvents(env).filter((x) => x.turnId.includes('fs_write'))
  assert.equal(dec.length, 2, '两卡 = 两条决策事件（链上恒逐卡，不合并）')
  for (const d of dec) assert.equal(d.payload['note'], '批量附注（本批构建产物）', '共享附注逐卡落链')
})
