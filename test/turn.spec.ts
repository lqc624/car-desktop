/**
 * S2 会话主旅程 E2E 行为测试（宿主核心公共 API 驱动；内核 runTurn/AuthzService 真跑，
 * 仅模型回调注入假脚本——「桥 E2E 为行为证明：旧语义下必红」纪律平移）
 *
 * 假模型纪律：忠实复刻 chatStep 的落链行为（assistant 文本非空即 append，
 * chatStep.ts:129 口径；空文本不产事件）——否则事件流与生产路径不等价。
 * 前提纪律（lesson-deterministic-test-premises）：全部注入临时目录；authzTimeoutMs
 * 注入短超时测内核 timeout-default-deny 真值（桌面不重实现——D-S2-5）。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createHostService, type HostService, type PushMessage } from '../src/host-core/service.ts'
import { sessionsDirFor } from '../src/host-core/sessions.ts'
import { usageOver, type SessionHandle } from '../src/host-core/session-handle.ts'
import type { AuthzPendingPush, AuthzResolvedPush, HostProbeResult, SessionEventDTO, SessionEventPush, WorkspaceInfo } from '../src/shared/ipc-contract.ts'
import type { HostModelFn, HostModelStep } from '../src/host-core/types.ts'

function tmpDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `car-desk2-${label}-`))
}

/** 复刻 chatStep 落链行为：assistant 文本非空即 append（工具调用事件由 runTurn 落，不在回调层） */
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

async function makeEnv(script: (h: SessionHandle) => HostModelFn, opts: { authzTimeoutMs?: number } = {}): Promise<Env> {
  const userData = tmpDir('ud')
  const root = tmpDir('ws')
  writeFileSync(
    join(root, 'car.config.ts'),
    "export default { llm: { baseUrl: 'http://127.0.0.1:9', model: 'test-model' } }\n",
    'utf8',
  )
  const svc = createHostService({
    userDataDir: userData,
    authzTimeoutMs: opts.authzTimeoutMs ?? 120_000,
    modelFnOverride: script,
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

function pendingsOf(env: Env): AuthzPendingPush[] {
  return env.pushes.filter((m) => m.topic === 'push:authz-pending').map((m) => m.payload as AuthzPendingPush)
}

function resolvedOf(env: Env): AuthzResolvedPush[] {
  return env.pushes.filter((m) => m.topic === 'push:authz-resolved').map((m) => m.payload as AuthzResolvedPush)
}

async function waitForTurnEnd(env: Env, turnId: string, timeoutMs = 5000): Promise<SessionEventDTO> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const e = eventsOf(env).find((x) => x.kind === 'turnEnd' && x.turnId === turnId)
    if (e) return e
    if (Date.now() > deadline) throw new Error(`waitForTurnEnd 超时（${turnId}）——已见 kind 序列: ${eventsOf(env).map((x) => x.kind).join(',')}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

async function waitForPending(env: Env, timeoutMs = 3000): Promise<AuthzPendingPush> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const p = pendingsOf(env).at(-1)
    if (p) return p
    if (Date.now() > deadline) throw new Error('waitForPending 超时——授权 pending 未推送')
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** 脚本模型工厂：每个 turn 首步 toolUse(fs_write) → 次步 stop('done')（assistant 落链复刻 chatStep） */
function toolThenStop(path = 'out/a.txt', content = 'hello'): (h: SessionHandle) => HostModelFn {
  return (h: SessionHandle) => {
    let lastTurn = ''
    return async () => {
      const t = h.currentTurnId()
      if (t !== lastTurn) {
        lastTurn = t
        return { stopReason: 'toolUse', toolCalls: [{ id: 'c-' + t, tool: 'fs_write', args: { path, content } }] }
      }
      return emitAssistant(h, { stopReason: 'stop', text: 'done' })
    }
  }
}

test('主旅程（无工具）：发送 → assistant 落链 → turnEnd completed（事件级推送与落链同序）', async () => {
  const env = await makeEnv((h) => async () => emitAssistant(h, { stopReason: 'stop', text: '你好，世界' }))
  const sent = (await env.svc.dispatch('turn:send', {
    workspaceId: env.ws.id,
    sessionId: env.sess.sessionId,
    text: '打个招呼',
  })) as { turnId: string }
  const end = await waitForTurnEnd(env, sent.turnId)
  assert.equal((end.meta as Record<string, unknown> | null)?.['reason'], 'completed')
  const evts = eventsOf(env).filter((e) => e.turnId === sent.turnId)
  assert.deepEqual(
    evts.map((e) => e.kind),
    ['user', 'assistant', 'turnEnd'],
  )
  assert.equal(evts[0].payload, '打个招呼')
  assert.equal(evts[1].payload, '你好，世界')
})

test('授权门·批准本次：pending 推送 → once 响应 → 工具放行落盘 → turnEnd completed', async () => {
  const env = await makeEnv(toolThenStop())
  const sent = (await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, text: '写文件' })) as { turnId: string }
  const pending = await waitForPending(env)
  assert.equal(pending.tool, 'fs_write')
  assert.equal(pending.timeoutMs, 120_000) // D-S2-5：默认超时与内核同源
  await env.svc.dispatch('authz:respond', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, requestId: pending.requestId, decision: 'once' })
  const end = await waitForTurnEnd(env, sent.turnId)
  assert.equal((end.meta as Record<string, unknown> | null)?.['reason'], 'completed')
  const written = join(env.root, 'out', 'a.txt')
  assert.ok(existsSync(written), 'fs_write 未落盘')
  assert.equal(readFileSync(written, 'utf8'), 'hello')
  // 内核「先落日志后放行」：授权决策先记一条 toolResult（error:'authorization-denied', granted:true），
  // 执行结果是第二条——按载荷区分断言（渲染层按 id 配对取最后一条展示）
  const toolResults = eventsOf(env).filter((e) => e.kind === 'toolResult')
  assert.ok(
    toolResults.some((e) => (e.payload as Record<string, unknown>)['granted'] === true),
    '授权决策留痕缺失（granted:true）',
  )
  assert.ok(
    toolResults.some((e) => (e.payload as Record<string, unknown>)['result'] !== undefined),
    '工具执行结果未交回',
  )
  assert.equal(resolvedOf(env).at(-1)?.outcome, 'approved')
})

test('授权门·会话内始终允许：session 响应写 grant → 同工具再发不再弹窗（policy 幂等落链）', async () => {
  const env = await makeEnv(toolThenStop('out/one.txt'))
  const t1 = (await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, text: 'T1' })) as { turnId: string }
  const p1 = await waitForPending(env)
  await env.svc.dispatch('authz:respond', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, requestId: p1.requestId, decision: 'session' })
  await waitForTurnEnd(env, t1.turnId)
  const pendingsAfterT1 = pendingsOf(env).length

  // 第二个 turn：同工具 grant 命中 → 无 pending，policy 事件在链
  const t2 = (await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, text: 'T2' })) as { turnId: string }
  const end2 = await waitForTurnEnd(env, t2.turnId)
  assert.equal((end2.meta as Record<string, unknown> | null)?.['reason'], 'completed')
  assert.equal(pendingsOf(env).length, pendingsAfterT1, 'grant 命中后不应再推 pending')
  assert.ok(existsSync(join(env.root, 'out', 'one.txt')), '第二个 turn 工具未执行')
  const policyEvents = eventsOf(env).filter(
    (e) => e.turnId.startsWith('authz:') && (e.payload as Record<string, unknown>)['decidedBy'] === 'policy',
  )
  assert.ok(policyEvents.length >= 1, '会话级 policy 决策未落链（审计不可解释）')
})

test('授权门·拒绝：deny → 工具拒绝落痕（authorization-denied）→ 模型继续调整 → completed', async () => {
  const env = await makeEnv(toolThenStop())
  const sent = (await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, text: '写文件' })) as { turnId: string }
  const pending = await waitForPending(env)
  await env.svc.dispatch('authz:respond', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, requestId: pending.requestId, decision: 'deny' })
  const end = await waitForTurnEnd(env, sent.turnId)
  assert.equal((end.meta as Record<string, unknown> | null)?.['reason'], 'completed')
  const toolResult = eventsOf(env).find((e) => e.kind === 'toolResult')
  assert.ok(toolResult && (toolResult.payload as Record<string, unknown>)['error'] === 'authorization-denied')
  assert.equal(resolvedOf(env).at(-1)?.outcome, 'denied')
})

test('授权门·超时：不响应 → 内核 timeout-default-deny（EXPIRED）→ resolved=timeout', async () => {
  const env = await makeEnv(toolThenStop(), { authzTimeoutMs: 200 })
  const sent = (await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, text: '写文件' })) as { turnId: string }
  await waitForPending(env)
  const end = await waitForTurnEnd(env, sent.turnId)
  assert.equal((end.meta as Record<string, unknown> | null)?.['reason'], 'completed')
  const toolResult = eventsOf(env).find((e) => e.kind === 'toolResult')
  assert.ok(toolResult && (toolResult.payload as Record<string, unknown>)['error'] === 'authorization-denied')
  assert.equal(resolvedOf(env).at(-1)?.outcome, 'timeout')
})

test('停止（abort）：pending 期间 abort+deny → turnEnd aborted、工具未执行', async () => {
  const env = await makeEnv(toolThenStop())
  const sent = (await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, text: '写文件' })) as { turnId: string }
  const pending = await waitForPending(env)
  await env.svc.dispatch('turn:abort', { workspaceId: env.ws.id, sessionId: env.sess.sessionId })
  await env.svc.dispatch('authz:respond', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, requestId: pending.requestId, decision: 'deny' })
  const end = await waitForTurnEnd(env, sent.turnId)
  assert.equal((end.meta as Record<string, unknown> | null)?.['reason'], 'aborted')
  assert.ok(!existsSync(join(env.root, 'out', 'a.txt')), 'abort 后工具不应执行')
})

test('fs_write 沙盒：路径穿越拒绝（工具错误成对交回模型，turn 正常收口）', async () => {
  const env = await makeEnv(toolThenStop('../escape.txt', 'x'))
  const sent = (await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, text: '越界写' })) as { turnId: string }
  const pending = await waitForPending(env)
  await env.svc.dispatch('authz:respond', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, requestId: pending.requestId, decision: 'once' })
  const end = await waitForTurnEnd(env, sent.turnId)
  assert.equal((end.meta as Record<string, unknown> | null)?.['reason'], 'completed')
  const toolError = eventsOf(env)
    .filter((e) => e.kind === 'toolResult')
    .map((e) => String((e.payload as Record<string, unknown>)['error'] ?? ''))
    .find((msg) => msg.includes('越界'))
  assert.ok(toolError, '越界错误未成对交回')
  assert.ok(!existsSync(join(env.root, '..', 'escape.txt')), '穿越文件不应存在')
})

test('model/set：会话级切换落链（system kind + payload.type——内核 EventKind 冻结面不新增）', async () => {
  const env = await makeEnv((h) => async () => emitAssistant(h, { stopReason: 'stop', text: 'ok' }))
  await env.svc.dispatch('session:set-model', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, model: 'test-model-2' })
  const opened = (await env.svc.dispatch('session:open', { workspaceId: env.ws.id, sessionId: env.sess.sessionId })) as { model: string | null; events: SessionEventDTO[] }
  assert.equal(opened.model, 'test-model-2')
  const setEvent = opened.events.find((e) => e.kind === 'system' && (e.payload as Record<string, unknown>)['type'] === 'model/set')
  assert.ok(setEvent, 'model/set 事件未落链')
  assert.equal((setEvent!.payload as Record<string, unknown>)['model'], 'test-model-2')
})

test('重命名/删除：索引面权威 + 链上留痕 + JSONL 保留（审计红线：日志不可变）', async () => {
  const env = await makeEnv((h) => async () => emitAssistant(h, { stopReason: 'stop', text: 'ok' }))
  const sid = env.sess.sessionId
  const renamed = (await env.svc.dispatch('session:rename', { workspaceId: env.ws.id, sessionId: sid, title: '发票周报' })) as { title: string }
  assert.equal(renamed.title, '发票周报')
  const list1 = (await env.svc.dispatch('session:list', { workspaceId: env.ws.id })) as Array<{ sessionId: string; title: string }>
  assert.equal(list1[0].title, '发票周报')

  await env.svc.dispatch('session:delete', { workspaceId: env.ws.id, sessionId: sid })
  const list2 = (await env.svc.dispatch('session:list', { workspaceId: env.ws.id })) as unknown[]
  assert.equal(list2.length, 0, '删除后仍在列表（索引未生效）')
  const file = join(sessionsDirFor(env.root), sid + '.jsonl')
  assert.ok(existsSync(file), '删除后 JSONL 被销毁（违反审计红线）')
  const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim())
  const payloadTypes = lines.map((l) => (JSON.parse(l) as SessionEventDTO).payload as Record<string, unknown>)
  assert.ok(payloadTypes.some((p) => p?.['type'] === 'session/delete'), 'session/delete 未落链')
})

test('多会话隔离：A 会话 grant 不泄漏到 B（B 独立弹窗）', async () => {
  const env = await makeEnv(toolThenStop())
  const b = (await env.svc.dispatch('session:create', { workspaceId: env.ws.id })) as { sessionId: string }
  const tA = (await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, text: 'A' })) as { turnId: string }
  const pA = await waitForPending(env)
  await env.svc.dispatch('authz:respond', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, requestId: pA.requestId, decision: 'session' })
  await waitForTurnEnd(env, tA.turnId)

  const pendingsBeforeB = pendingsOf(env).filter((p) => p.sessionId === b.sessionId).length
  const tB = (await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: b.sessionId, text: 'B' })) as { turnId: string }
  assert.equal(pendingsBeforeB, 0, '发送前 B 不应有 pending')
  const pB = await waitForPending(env)
  assert.equal(pB.sessionId, b.sessionId, 'B 应有自己的 pending（grant 不跨会话）')
  assert.equal(pendingsBeforeB, 0)
  await env.svc.dispatch('authz:respond', { workspaceId: env.ws.id, sessionId: b.sessionId, requestId: pB.requestId, decision: 'deny' })
  await waitForTurnEnd(env, tB.turnId)
})

test('跨运行只读语义（D-S2-6）：新进程打开旧会话可回放、续写 fail-visible（内核恢复面候选登记）', async () => {
  // 「先前运行」模拟：新 service 实例（新注册表/新句柄表）+ 同一工作区
  const env = await makeEnv((h) => async () => emitAssistant(h, { stopReason: 'stop', text: '旧会话内容' }))
  const sid = env.sess.sessionId
  const svc2 = createHostService({
    userDataDir: tmpDir('ud2'),
    modelFnOverride: (h) => async () => emitAssistant(h, { stopReason: 'stop', text: 'x' }),
  })
  const ws2 = (await svc2.dispatch('workspace:register', { path: env.root })) as WorkspaceInfo
  const opened = (await svc2.dispatch('session:open', { workspaceId: ws2.id, sessionId: sid })) as { events: SessionEventDTO[]; exists: boolean }
  assert.equal(opened.exists, true)
  assert.ok(opened.events.some((e) => e.kind === 'system' && (e.payload as Record<string, unknown>)['type'] === 'session-start'))
  await assert.rejects(
    () => svc2.dispatch('turn:send', { workspaceId: ws2.id, sessionId: sid, text: '续写' }),
    (err: Error) => /不可续写|只读回放/.test(err.message),
  )
})

test('usage 聚合（usageOver 纯函数）：四分量求和 + 覆盖率（缺失显性化，禁估算）', () => {
  const base = { actor: 'runtime' as const, kind: 'usage' as const, prevHash: 'x', hash: 'y', meta: null }
  const events: SessionEventDTO[] = [
    { ...base, seq: 0, ts: 1, turnId: 'T1', payload: { input: 100, output: 20, cacheRead: 50, cacheCreation: 0 } },
    { ...base, seq: 1, ts: 2, turnId: 'T1', payload: { input: 80, output: 30, cacheRead: 0, cacheCreation: 0 } },
    { ...base, seq: 2, ts: 3, kind: 'turnEnd', turnId: 'T1', payload: null, meta: { reason: 'completed' } },
    { ...base, seq: 3, ts: 4, kind: 'turnEnd', turnId: 'T2', payload: null, meta: { reason: 'completed' } },
    { ...base, seq: 4, ts: 5, turnId: 'authz:x', kind: 'turnEnd', payload: { decision: 'APPROVED' }, meta: null },
  ]
  const u = usageOver(events)
  assert.equal(u.turns, 2, 'authz:* 审计事件不得计入 turn 数')
  assert.equal(u.requests, 2)
  assert.equal(u.input, 180)
  assert.equal(u.output, 50)
  assert.equal(u.cacheRead, 50)
  assert.equal(u.lastInput, 80)
  assert.equal(u.coverage, 0.5) // 2 turn 中 1 turn 有 usage——缺失显性化
})

test('模型装配预热（S2 修补回归）：跨运行后建会话——loadHostRuntime 须自行 warm（未预热 = CAR-E-CONFIG 曾致装配失败被吞）', async () => {
  // 复刻用户实态：上次运行注册了工作区（svc1 + warm），本次运行（svc2，缓存为空）直接建会话
  const sharedUserData = tmpDir('ud-warm')
  const root = tmpDir('ws-warm')
  writeFileSync(join(root, 'car.config.ts'), "export default { llm: { baseUrl: 'http://127.0.0.1:9', model: 'test-model' } }\n", 'utf8')
  const svc1 = createHostService({ userDataDir: sharedUserData, modelFnOverride: (h) => async () => emitAssistant(h, { stopReason: 'stop', text: 'ok' }) })
  await svc1.dispatch('workspace:register', { path: root })
  const svc2 = createHostService({ userDataDir: sharedUserData, modelFnOverride: (h) => async () => emitAssistant(h, { stopReason: 'stop', text: 'ok' }) })
  const ws2 = (await svc2.dispatch('workspace:list')).find((w) => (w as WorkspaceInfo).path === root) as WorkspaceInfo
  const sess = (await svc2.dispatch('session:create', { workspaceId: ws2.id })) as { modelError?: string | null }
  assert.equal(sess.modelError ?? null, null, `模型装配失败（预热缺口回归）：${sess.modelError}`)
})

test('模型装配失败可见性（S2 修补回归）：无 llm 配置的工作区建会话 → modelError 带引导文案（禁吞 console）', async () => {
  const userData = tmpDir('ud-nollm')
  const root = tmpDir('ws-nollm') // 无 car.config
  const svc = createHostService({ userDataDir: userData, modelFnOverride: (h) => async () => emitAssistant(h, { stopReason: 'stop', text: 'ok' }) })
  const ws = (await svc.dispatch('workspace:register', { path: root })) as WorkspaceInfo
  const sess = (await svc.dispatch('session:create', { workspaceId: ws.id })) as { modelError?: string | null }
  assert.match(String(sess.modelError), /CAR-E-LLM-CONFIG/)
})

test('probe（S1 回归）：seam 版本形态 + 宿主消费符号在位', () => {
  const svc = createHostService({ userDataDir: tmpDir('probe') })
  return svc.dispatch('host:probe').then((p) => {
    const r = p as HostProbeResult
    assert.match(r.seamVersion, /^\d+\.\d+\.\d+/)
    for (const name of ['SessionLog', 'SessionFileStore', 'loadCarConfig', 'warmCarConfig', 'AuthzService']) {
      assert.ok(r.symbols.includes(name), `seam 缺少符号 ${name}`)
    }
  })
})
