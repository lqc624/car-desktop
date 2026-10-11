/**
 * S3-S4 审计可视化 + 取证包导出 + 跨运行续写行为测试（S3 规划 WBS S3-S4 判据）
 *
 * 判据：载入面→verifyChain 对拍；断链注入→定位 brokenAt + 导出中止；导出→读回重验
 * （verifyBundle + 载入面链校验 + manifest 事件数三重）；跨运行续写→链完整、seq 连续、
 * turn 不撞号（D-S2-6 退役——恢复面 fromEvents M5 已在产，桌面侧惰性消费）。
 * 前提纪律：全注入临时目录；E2E 经宿主公共 API 驱动；内核真跑 + 假模型复刻落链口径。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createHostService, type HostService, type PushMessage } from '../src/host-core/service.ts'
import { sessionsDirFor } from '../src/host-core/sessions.ts'
import type { AuditReport, SessionEventDTO, SessionEventPush, WorkspaceInfo } from '../src/shared/ipc-contract.ts'
import type { SessionHandle } from '../src/host-core/session-handle.ts'
import type { HostModelFn, HostModelStep } from '../src/host-core/types.ts'

function tmpDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `car-audit-${label}-`))
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
  userData: string
  pushes: PushMessage[]
}

async function makeEnv(callOf: (h: SessionHandle, turnIndex: number) => { tool: string; args: Record<string, unknown> } | null): Promise<Env> {
  const userData = tmpDir('ud')
  const root = tmpDir('ws')
  writeFileSync(join(root, 'car.config.ts'), "export default { llm: { baseUrl: 'http://127.0.0.1:9', model: 'test-model' } }\n", 'utf8')
  const svc = createHostService({
    userDataDir: userData,
    modelFnOverride: (h: SessionHandle) => {
      let lastTurn = ''
      let turnIndex = 0
      return async () => {
        const t = h.currentTurnId()
        if (t !== lastTurn) {
          lastTurn = t
          const call = callOf ? callOf(h, turnIndex++) : null
          if (call) return { stopReason: 'toolUse', toolCalls: [{ id: 'c-' + t, tool: call.tool, args: call.args }] }
        }
        return emitAssistant(h, { stopReason: 'stop', text: 'done' })
      }
    },
  })
  const pushes: PushMessage[] = []
  svc.onPush((m) => pushes.push(m))
  const ws = (await svc.dispatch('workspace:register', { path: root })) as WorkspaceInfo
  const sess = (await svc.dispatch('session:create', { workspaceId: ws.id })) as { sessionId: string }
  return { svc, ws, sess, root, userData, pushes }
}

function eventsOf(env: Env): SessionEventDTO[] {
  return env.pushes.filter((m) => m.topic === 'push:session-event').map((m) => (m.payload as SessionEventPush).event)
}
async function waitForTurnEnd(env: Env, turnId: string, sessionId = env.sess.sessionId, timeoutMs = 5000): Promise<SessionEventDTO> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const e = eventsOf(env).find((x) => x.kind === 'turnEnd' && x.turnId === turnId)
    if (e) return e
    if (Date.now() > deadline) throw new Error(`waitForTurnEnd 超时（${turnId}）——已见: ${eventsOf(env).map((x) => x.kind).join(',')}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}
async function sendTurn(env: Env, sessionId: string, text: string): Promise<string> {
  const r = (await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId, text })) as { turnId: string }
  return r.turnId
}
async function waitForPending(env: Env): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 3000
  for (;;) {
    const ps = env.pushes.filter((m) => m.topic === 'push:authz-pending')
    if (ps.length) return ps.at(-1)!.payload as Record<string, unknown>
    if (Date.now() > deadline) throw new Error('pending 未推送')
    await new Promise((r) => setTimeout(r, 10))
  }
}
async function respondOnce(env: Env, sessionId: string): Promise<void> {
  await env.svc.dispatch('authz:respond', {
    workspaceId: env.ws.id,
    sessionId,
    requestId: (await waitForPending(env))['requestId'],
    decision: 'once',
  })
}

/** 两 turn 造链（各一次授权 + 执行 + 收口） */
async function runTwoTurns(env: Env): Promise<void> {
  const t1 = await sendTurn(env, env.sess.sessionId, '第一轮')
  await waitForPending(env)
  await respondOnce(env, env.sess.sessionId)
  await waitForTurnEnd(env, t1)
  const t2 = await sendTurn(env, env.sess.sessionId, '第二轮')
  await waitForPending(env)
  await respondOnce(env, env.sess.sessionId)
  await waitForTurnEnd(env, t2)
}

test('E2E·审计报告（载入面对拍）：事件全集 + 链完整 + 授权审计行在链', async () => {
  const env = await makeEnv((h, i) => ({ tool: 'fs_write', args: { path: join(h.workspaceRoot, `f${i}.txt`), content: 'v' + i } }))
  await runTwoTurns(env)
  const report = (await env.svc.dispatch('audit:report', { workspaceId: env.ws.id, sessionId: env.sess.sessionId })) as AuditReport
  assert.equal(report.chain.intact, true)
  assert.equal(report.chain.brokenAt, null)
  assert.equal(report.encoding, 'plain')
  assert.equal(report.tornTail, false)
  // 载入面对拍：盘面事件数 = 推送流事件数（同源同序——D-S2-1 的审计面镜像）
  assert.equal(report.eventCount, eventsOf(env).length)
  assert.equal(report.events.length, report.eventCount)
  assert.equal(report.events[0].kind, 'system')
  assert.equal((report.events[0].payload as Record<string, unknown>)['type'], 'session-start')
  // 授权审计行（authz:* 形态）在链——审计页渲染数据源
  assert.ok(report.events.some((e) => e.turnId.startsWith('authz:')), '授权审计事件缺失')
  // seq 连续无缺口
  report.events.forEach((e, i) => assert.equal(e.seq, i, `seq 缺口 @${i}`))
})

test('E2E·断链注入：audit:report 定位 brokenAt + 导出中止（CAR-E-EXPORT，禁止带病包外流）', async () => {
  const env = await makeEnv((h, i) => ({ tool: 'fs_write', args: { path: join(h.workspaceRoot, `f${i}.txt`), content: 'v' + i } }))
  await runTwoTurns(env)
  // 篡改第 2 行（seq=1）载荷——不改 hash → 链校验失败定位 seq=1
  const file = join(sessionsDirFor(env.root), env.sess.sessionId + '.jsonl')
  const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim())
  const tampered = JSON.parse(lines[1]) as Record<string, unknown>
  tampered['payload'] = '篡改后的内容'
  lines[1] = JSON.stringify(tampered)
  writeFileSync(file, lines.join('\n') + '\n', 'utf8')
  const report = (await env.svc.dispatch('audit:report', { workspaceId: env.ws.id, sessionId: env.sess.sessionId })) as AuditReport
  assert.equal(report.chain.intact, false)
  assert.equal(report.chain.brokenAt, 1, '断链定位到被篡改 seq')
  await assert.rejects(
    () => env.svc.dispatch('audit:export', { workspaceId: env.ws.id, sessionId: env.sess.sessionId }),
    (err: Error) => /中止导出|CAR-E-EXPORT/.test(err.message),
    '断链中止导出',
  )
})

test('E2E·取证包导出：落盘 userData/exports + 读回重验三重 PASS', async () => {
  const env = await makeEnv((h, i) => ({ tool: 'fs_write', args: { path: join(h.workspaceRoot, `f${i}.txt`), content: 'v' + i } }))
  await runTwoTurns(env)
  const result = (await env.svc.dispatch('audit:export', { workspaceId: env.ws.id, sessionId: env.sess.sessionId })) as {
    ok: boolean
    dir: string
    files: string[]
    eventCount: number
    verify: { ok: boolean; brokenFile: string | null }
    chainIntact: boolean
  }
  assert.equal(result.ok, true)
  assert.equal(result.verify.ok, true, '读回重验①：逐文件 SHA-256 + manifest 对拍')
  assert.equal(result.chainIntact, true, '读回重验②：载入面链校验')
  assert.ok(existsSync(result.dir), '导出目录在位')
  assert.ok(result.files.some((f) => f.endsWith('manifest.json')), 'manifest 在列')
  const eventsFile = result.files.find((f) => f.endsWith('events.jsonl'))!
  const exportedLines = readFileSync(join(result.dir, eventsFile), 'utf8').split('\n').filter((l) => l.trim())
  assert.equal(exportedLines.length, result.eventCount, '读回重验③：事件数与 manifest 一致')
  assert.ok(result.dir.includes('exports'), '导出在 userData/exports 下')
})

test('E2E·跨运行续写（D-S2-6 退役）：新进程重建可续写句柄——链完整、seq 连续、turn 不撞号', async () => {
  const env = await makeEnv((h, i) => ({ tool: 'fs_write', args: { path: join(h.workspaceRoot, `old${i}.txt`), content: 'v' + i } }))
  await runTwoTurns(env)
  const before = (await env.svc.dispatch('audit:report', { workspaceId: env.ws.id, sessionId: env.sess.sessionId })) as AuditReport
  // 「新进程」：新 service 实例 + 同一工作区根（跨运行只读回放面）
  const userData2 = tmpDir('ud2')
  const svc2 = createHostService({
    userDataDir: userData2,
    modelFnOverride: (h: SessionHandle) => async () => emitAssistant(h, { stopReason: 'stop', text: '续写内容' }),
  })
  const pushes2: PushMessage[] = []
  svc2.onPush((m) => pushes2.push(m))
  const ws2 = (await svc2.dispatch('workspace:register', { path: env.root })) as WorkspaceInfo
  const opened = (await svc2.dispatch('session:open', { workspaceId: ws2.id, sessionId: env.sess.sessionId })) as { exists: boolean; events: SessionEventDTO[] }
  assert.equal(opened.exists, true)
  assert.equal(opened.events.length, before.eventCount, '回放与旧进程事件数一致')
  // 续写：旧语义 fail-visible → S3-S4 解锁（惰性重建句柄）
  const sent = (await svc2.dispatch('turn:send', { workspaceId: ws2.id, sessionId: env.sess.sessionId, text: '续写' })) as { turnId: string }
  const deadline = Date.now() + 5000
  for (;;) {
    const evts = pushes2.filter((m) => m.topic === 'push:session-event').map((m) => (m.payload as SessionEventPush).event)
    if (evts.some((e) => e.kind === 'turnEnd' && e.turnId === sent.turnId)) break
    if (Date.now() > deadline) throw new Error('续写 turn 未收口')
    await new Promise((r) => setTimeout(r, 20))
  }
  // 链完整 + seq 连续 + turn 不撞号（旧 T1/T2 + 新 T3——usage 聚合不串账）
  const report = (await svc2.dispatch('audit:report', { workspaceId: ws2.id, sessionId: env.sess.sessionId })) as AuditReport
  assert.equal(report.chain.intact, true, '续写后链完整（恢复面 fromEvents 重建 #tail）')
  report.events.forEach((e, i) => assert.equal(e.seq, i, `seq 缺口 @${i}`))
  const turnIds = new Set(report.events.map((e) => e.turnId).filter((t) => /^T\d+$/.test(t)))
  assert.ok(turnIds.has('T1') && turnIds.has('T2') && turnIds.has(sent.turnId), '新旧 turn 共存且不撞号')
  assert.equal(Number(sent.turnId.slice(1)), 3, '新 turn 序号 = 历史最大 +1')
  assert.ok(report.events.some((e) => e.kind === 'assistant' && e.payload === '续写内容'), '续写 assistant 落链')
})

test('E2E·断链拒绝续写：篡改后跨运行 turn:send fail-visible（先修审计面）', async () => {
  const env = await makeEnv((h, i) => ({ tool: 'fs_write', args: { path: join(h.workspaceRoot, `f${i}.txt`), content: 'v' + i } }))
  await runTwoTurns(env)
  const file = join(sessionsDirFor(env.root), env.sess.sessionId + '.jsonl')
  const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim())
  const tampered = JSON.parse(lines[2]) as Record<string, unknown>
  tampered['payload'] = '被篡改'
  lines[2] = JSON.stringify(tampered)
  writeFileSync(file, lines.join('\n') + '\n', 'utf8')
  const svc2 = createHostService({ userDataDir: tmpDir('ud2'), modelFnOverride: (h) => async () => emitAssistant(h, { stopReason: 'stop', text: 'x' }) })
  const ws2 = (await svc2.dispatch('workspace:register', { path: env.root })) as WorkspaceInfo
  await assert.rejects(
    () => svc2.dispatch('turn:send', { workspaceId: ws2.id, sessionId: env.sess.sessionId, text: '续写' }),
    (err: Error) => /链断裂|拒绝续写/.test(err.message),
  )
})

test('E2E·已删除会话拒绝续写（索引面权威；JSONL 仍在）', async () => {
  const env = await makeEnv(null)
  const sid = env.sess.sessionId
  await env.svc.dispatch('session:delete', { workspaceId: env.ws.id, sessionId: sid })
  const svc2 = createHostService({ userDataDir: tmpDir('ud2'), modelFnOverride: (h) => async () => emitAssistant(h, { stopReason: 'stop', text: 'x' }) })
  const ws2 = (await svc2.dispatch('workspace:register', { path: env.root })) as WorkspaceInfo
  await assert.rejects(
    () => svc2.dispatch('turn:send', { workspaceId: ws2.id, sessionId: sid, text: '续写' }),
    (err: Error) => /已删除/.test(err.message),
  )
  assert.ok(existsSync(join(sessionsDirFor(env.root), sid + '.jsonl')), '删除后 JSONL 保留（审计红线）')
})
