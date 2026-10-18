/**
 * S5 参数/模型池行为测试（v0.2-S5 规划 WBS S5-S1 判据；D-S5-1~3）
 *
 * 判据：模型池装配 E2E（car.config llm.modelPool → assembleModelPool 池适配器 → fallback
 * 落链 routing/decide）；思考程度会话链（SessionSetModel reasoningEffort → model/set payload
 * 加法）；立即压缩 IPC（append-only compact 事件 + NORANGE fail-visible）+ 自动压缩挂载点
 * （sendTurn 起点先压缩后 append user）；doctor 池健康行（逐端点 probe，值不打印）。
 * 前提纪律：全注入临时目录 + 回环 socket；E2E 经宿主公共 API 驱动。
 */
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createHostService, type HostService, type PushMessage } from '../src/host-core/service.ts'
import type { SessionEventDTO, SessionEventPush, WorkspaceInfo } from '../src/shared/ipc-contract.ts'
import type { SessionHandle } from '../src/host-core/session-handle.ts'
import type { HostModelStep } from '../src/host-core/types.ts'

function tmpDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `car-s5-${label}-`))
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

async function makeEnv(
  opts: { carConfigExtra?: string; carConfigFull?: string; modelFnOverride?: Parameters<typeof createHostService>[0]['modelFnOverride'] } = {},
): Promise<Env> {
  const userData = tmpDir('ud')
  const root = tmpDir('ws')
  writeFileSync(
    join(root, 'car.config.ts'),
    (opts.carConfigFull ?? 'export default { llm: { baseUrl: \'http://127.0.0.1:9\', model: \'test-model\' }' + (opts.carConfigExtra ?? '') + ' }') + '\n',
    'utf8',
  )
  const svc = createHostService({
    userDataDir: userData,
    ...(opts.modelFnOverride ? { modelFnOverride: opts.modelFnOverride } : {}),
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

async function waitForTurnEnd(env: Env, turnId: string, timeoutMs = 8000): Promise<SessionEventDTO> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const e = eventsOf(env).find((x) => x.kind === 'turnEnd' && x.turnId === turnId)
    if (e) return e
    if (Date.now() > deadline) throw new Error(`waitForTurnEnd 超时（${turnId}）——已见: ${eventsOf(env).map((x) => x.kind).join(',')}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

/** 回环 SSE 服务（OpenAI compat 形态——POST /chat/completions → 流式响应） */
async function startSseServer(text: string): Promise<{ server: Server; port: number }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(
      `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n` +
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n` +
        'data: [DONE]\n\n',
    )
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { server, port: (server.address() as { port: number }).port }
}

// ==================== 模型池装配 E2E（D-S5-1） ====================

test('s5-1 模型池 E2E：modelPool → 池适配器 → 首选拒绝 → fallback 落链 routing/decide', async () => {
  const { server, port } = await startSseServer('ok-from-live')
  const env = await makeEnv({
    carConfigExtra:
      `, modelPool: { endpoints: [` +
      `{ id: 'dead-ep', baseUrl: 'http://127.0.0.1:1', model: 'm-dead', keyEnv: 'CAR_S5_POOL_KEY' },` +
      `{ id: 'live-ep', baseUrl: 'http://127.0.0.1:${port}', model: 'm-live', keyEnv: 'CAR_S5_POOL_KEY' }` +
      `], probe: { enabled: false } }`,
  })
  const prevKey = process.env.CAR_S5_POOL_KEY
  process.env.CAR_S5_POOL_KEY = 'sk-s5-pool-test'
  try {
    // 真 chatStep 路径（无 modelFnOverride）——池适配器经 chatStep 消费
    const t = (await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, text: 'hi' })) as { turnId: string }
    await waitForTurnEnd(env, t.turnId)
    const evs = eventsOf(env)
    const routing = evs.filter((x) => x.kind === 'routing')
    assert.ok(routing.length >= 1, 'routing/decide 事件落链')
    const p = routing.at(-1)!.payload as Record<string, unknown>
    assert.equal(p['type'], 'decide')
    assert.equal(p['selected'], 'live-ep', '首选拒绝 → fallback 选中 live-ep（禁静默——决策显性化）')
    assert.equal(p['reason'], 'fallback')
    assert.equal(Number(p['retries'] ?? 0), 1)
    // 链完整 + 路由事件先于 assistant 回显
    const assistant = evs.find((x) => x.kind === 'assistant')
    assert.ok(assistant, 'assistant 回显在链')
    assert.ok(String(assistant!.payload).includes('ok-from-live'), 'fallback 成员的响应回显')
    assert.ok(routing.at(-1)!.seq < assistant!.seq, '路由决策先于 assistant 落链')
  } finally {
    if (prevKey === undefined) delete process.env.CAR_S5_POOL_KEY; else process.env.CAR_S5_POOL_KEY = prevKey
    await new Promise<void>((r) => server.close(() => r()))
    env.svc.dispose()
  }
})

// ==================== 思考程度会话链（D-S5-3） ====================

test('s5-2 思考程度：SessionSetModel reasoningEffort → model/set payload 加法；非法档 fail-visible', async () => {
  const env = await makeEnv({
    modelFnOverride: (h: SessionHandle) => async () => emitAssistant(h, { stopReason: 'stop', text: 'ok' }),
  })
  try {
    await env.svc.dispatch('session:set-model', {
      workspaceId: env.ws.id,
      sessionId: env.sess.sessionId,
      model: 'test-model',
      reasoningEffort: 'high',
    })
    const evs = eventsOf(env)
    const setEv = evs.filter((x) => x.kind === 'system' && (x.payload as Record<string, unknown>)['type'] === 'model/set').at(-1)!
    assert.equal((setEv.payload as Record<string, unknown>)['reasoning'], 'high', 'reasoning 键随 model/set 落链（EventKind 零新增）')
    // 非法档：宿主 dispatch 忽略非法值（re=null 不落链）——内核防线 = 未知档 fail-visible（1.14.1）
    await env.svc.dispatch('session:set-model', {
      workspaceId: env.ws.id,
      sessionId: env.sess.sessionId,
      model: 'test-model',
      reasoningEffort: 'ultra' as never,
    })
    const evs2 = eventsOf(env)
    const last = evs2.filter((x) => x.kind === 'system' && (x.payload as Record<string, unknown>)['type'] === 'model/set').at(-1)!
    assert.equal((last.payload as Record<string, unknown>)['reasoning'], undefined, '非法档不落链')
  } finally {
    env.svc.dispose()
  }
})

// ==================== 立即压缩 + 自动挂载点（D-S5-2） ====================

test('s5-3 立即压缩 IPC：append-only compact 事件；无区间 = NORANGE fail-visible', async () => {
  const env = await makeEnv({
    carConfigFull: 'export default { llm: { baseUrl: \'http://127.0.0.1:9\', model: \'test-model\', compaction: { enabled: true, thresholdEvents: 9999, protectLastTurns: 1 } } }',
    modelFnOverride: (h: SessionHandle) => async () => emitAssistant(h, { stopReason: 'stop', text: 'ok' }),
  })
  try {
    // 新会话无区间：fail-visible
    await assert.rejects(
      () => env.svc.dispatch('session:compact', { workspaceId: env.ws.id, sessionId: env.sess.sessionId }),
      /CAR-E-COMPACT-NORANGE/,
    )
    // 三个 turn 后：T1 可折叠
    for (const text of ['a', 'b', 'c']) {
      const t = (await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, text })) as { turnId: string }
      await waitForTurnEnd(env, t.turnId)
    }
    const r = (await env.svc.dispatch('session:compact', { workspaceId: env.ws.id, sessionId: env.sess.sessionId })) as { seq: number; compactedUpTo: number; compactedEvents: number }
    assert.ok(r.seq > 0 && r.compactedEvents > 0, '压缩事件落链（append-only）')
    const evs = eventsOf(env)
    const compactEv = evs.find((x) => x.kind === 'compact')
    assert.ok(compactEv, 'compact 事件在链')
    assert.equal(compactEv!.seq, r.seq)
  } finally {
    env.svc.dispose()
  }
})

test('s5-4 自动压缩挂载点：sendTurn 起点先压缩后 append user（threshold 命中时）', async () => {
  const env = await makeEnv({
    carConfigFull: 'export default { llm: { baseUrl: \'http://127.0.0.1:9\', model: \'test-model\', compaction: { enabled: true, thresholdEvents: 2, protectLastTurns: 1 } } }',
    modelFnOverride: (h: SessionHandle) => async () => emitAssistant(h, { stopReason: 'stop', text: 'ok' }),
  })
  try {
    for (const text of ['a', 'b', 'c']) {
      const t = (await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, text })) as { turnId: string }
      await waitForTurnEnd(env, t.turnId)
    }
    const evs = eventsOf(env)
    const compactEv = evs.find((x) => x.kind === 'compact')
    assert.ok(compactEv, '第三个 sendTurn 起点触发自动压缩（7 事件 ≥ 阈值 2）')
    // 压缩事件在第三个 user 事件之前（先压缩后 append）
    const user3 = evs.filter((x) => x.kind === 'user').at(-1)!
    assert.ok(compactEv!.seq < user3.seq, '先压缩后 append user（D-40 宿主装配层挂载点）')
    // turn 正常收口 + 链完整
    const turnEnds = evs.filter((x) => x.kind === 'turnEnd' && !x.turnId.startsWith('authz:'))
    assert.equal(turnEnds.length, 3)
  } finally {
    env.svc.dispose()
  }
})

// ==================== 模型菜单池数据面（D-S5-4） ====================

test('s5-6 models:meta 池成员数据面：workspaceId → pool 分组（模型菜单消费）；无 workspace = 空池；Key 不出面', async () => {
  const env = await makeEnv({
    carConfigExtra:
      `, modelPool: { endpoints: [` +
      `{ id: 'ep-a', baseUrl: 'http://127.0.0.1:9/v1', model: 'm-a', keyEnv: 'CAR_S5_MENU_KEY' },` +
      `{ baseUrl: 'http://127.0.0.1:10/v1', model: 'm-b' }` +
      `], probe: { enabled: false } }`,
    modelFnOverride: (h: SessionHandle) => async () => emitAssistant(h, { stopReason: 'stop', text: 'ok' }),
  })
  try {
    const withWs = (await env.svc.dispatch('models:meta', { workspaceId: env.ws.id })) as {
      pool: Array<{ id: string; baseUrl: string; model: string; adapterId: string }>
    }
    assert.equal(withWs.pool.length, 2)
    assert.equal(withWs.pool[0]!.id, 'ep-a')
    assert.equal(withWs.pool[0]!.model, 'm-a')
    assert.equal(withWs.pool[1]!.id, 'ep-2', '无 id 端点派生 ep-2')
    assert.equal(withWs.pool[1]!.adapterId, 'openai-compat')
    assert.ok(!JSON.stringify(withWs).includes('CAR_S5_MENU_KEY'), 'keyEnv 键名不携带明文（模型菜单数据面无凭据面）')
    const noWs = (await env.svc.dispatch('models:meta', {})) as { pool: unknown[] }
    assert.deepEqual(noWs.pool, [], '无 workspace = 空池（菜单只显内置表）')
  } finally {
    env.svc.dispose()
  }
})

// ==================== doctor 池健康行（D-S5-5） ====================

test('s5-5 doctor 池健康行：逐端点 probe（可达 ok / 不可达错误类别；值不打印）', async () => {
  const { server, port } = await startSseServer('x')
  const env = await makeEnv({
    carConfigExtra:
      `, modelPool: { endpoints: [` +
      `{ id: 'ok-ep', baseUrl: 'http://127.0.0.1:${port}', model: 'm-ok' },` +
      `{ id: 'bad-ep', baseUrl: 'http://127.0.0.1:1', model: 'm-bad' }` +
      `], probe: { enabled: false } }`,
  })
  try {
    const r = (await env.svc.dispatch('doctor:run', { workspaceId: env.ws.id })) as { rows: Array<{ label: string; ok: boolean; detail: string }> }
    const okRow = r.rows.find((x) => x.label === '池端点 ok-ep')
    const badRow = r.rows.find((x) => x.label === '池端点 bad-ep')
    assert.ok(okRow, '池健康行在位（ok-ep）')
    assert.equal(okRow!.ok, true)
    assert.match(okRow!.detail, /可达/)
    assert.ok(badRow, '池健康行在位（bad-ep）')
    assert.equal(badRow!.ok, false)
    assert.match(badRow!.detail, /不可达/)
    // 值不打印：明细无 Key 形态字符串
    for (const row of r.rows) assert.doesNotMatch(row.detail, /sk-[A-Za-z0-9]/)
  } finally {
    await new Promise<void>((r) => server.close(() => r()))
    env.svc.dispose()
  }
})
