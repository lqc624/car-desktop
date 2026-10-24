/**
 * S4-S2 doctor + 自定义模型端点行为测试（立项书 F-D5；S4 规划 WBS S4-S2 判据）
 *
 * 判据：端点覆盖装配（baseUrl/model/Key 注入——Authorization 实证命中端点）、doctor 三行
 * （值不打印——输出面无密钥原文）、上下文窗口流转（D-C5：元数据表/端点声明，无值 null）、
 * models:meta（Key 永不出面）。
 * safeStorage 落盘面（main 侧 credentials:save）不可在 node:test 运行——S4-GO 冒烟承载；
 * 本文件覆盖 host 侧全行为（key-push 内存推送后的装配/doctor/meta 面）。
 */
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createHostService, type HostService, type PushMessage } from '../src/host-core/service.ts'
import type { SessionInfo, SessionEventDTO, WorkspaceInfo } from '../src/shared/ipc-contract.ts'
import type { SessionHandle } from '../src/host-core/session-handle.ts'
import type { HostModelFn } from '../src/host-core/types.ts'

function tmpDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `car-ep-${label}-`))
}

function emitAssistant(h: SessionHandle, s: HostModelStep): HostModelStep {
  if (typeof s.text === 'string' && s.text.length > 0) {
    h.log.append('model', 'assistant', h.currentTurnId(), s.text)
  }
  return s
}

async function makeEnv(script?: (h: SessionHandle) => HostModelFn): Promise<Env> {
  const userData = tmpDir('ud')
  const root = tmpDir('ws')
  writeFileSync(join(root, 'car.config.ts'), "export default { llm: { baseUrl: 'http://127.0.0.1:9', model: 'test-model' } }\n", 'utf8')
  const svc = createHostService({
    userDataDir: userData,
    ...(script ? { modelFnOverride: (h: SessionHandle) => {
      let lastTurn = ''
      return async () => {
        const t = h.currentTurnId()
        if (t !== lastTurn) {
          lastTurn = t
          return { stopReason: 'toolUse', toolCalls: [{ id: 'c-' + t, tool: 'fs_write', args: { path: 'o.txt', content: 'x' } }] }
        }
        return emitAssistant(h, { stopReason: 'stop', text: 'done' })
      }
    } } : {}),
  })
  const pushes: PushMessage[] = []
  svc.onPush((m) => pushes.push(m))
  const ws = (await svc.dispatch('workspace:register', { path: root })) as WorkspaceInfo
  const sess = (await svc.dispatch('session:create', { workspaceId: ws.id })) as SessionInfo & { sessionId: string }
  return { svc, ws, sess, root, userData, pushes }
}

interface Env {
  svc: HostService
  ws: WorkspaceInfo
  sess: SessionInfo & { sessionId: string }
  root: string
  userData: string
  pushes: PushMessage[]
}

/** OpenAI 兼容 GET /models mock——doctor 连通性 + Authorization 捕获 */
function startModelsMock(): Promise<{ url: string; seen: Array<{ auth: string | undefined }>; close: () => Promise<void> }> {
  const seen: Array<{ auth: string | undefined }> = []
  const server: Server = createServer((req, res) => {
    if (req.method === 'GET' && (req.url ?? '').endsWith('/models')) {
      seen.push({ auth: req.headers.authorization })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [] }))
      return
    }
    res.writeHead(404).end()
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
      resolve({ url, seen, close: () => new Promise<void>((r) => server.close(() => r())) })
    })
  })
}

const ENDPOINT_KEY = 'endpoint-test-key-9876'

test('E2E·端点覆盖装配：key-push 后 session:create 走端点（doctor 连通性命中端点 + Authorization 实证）', async () => {
  const mock = await startModelsMock()
  const env = await makeEnv()
  try {
    await env.svc.dispatch('credentials:key-push', { baseUrl: mock.url, model: 'endpoint-model', key: ENDPOINT_KEY, contextWindow: 64_000 })
    const info = (await env.svc.dispatch('session:create', { workspaceId: env.ws.id })) as SessionInfo & { contextWindow?: number | null }
    assert.equal(info.contextWindow, 64_000, '端点声明窗口进会话面（D-C5）')
    // doctor：连通性探测目标 = 端点 baseUrl + Bearer 端点 Key（Authorization 实证）
    const doctor = (await env.svc.dispatch('doctor:run', { workspaceId: env.ws.id })) as { rows: Array<{ label: string; ok: boolean; detail: string }> }
    const conn = doctor.rows.find((r) => r.label === 'LLM 连通性')!
    assert.equal(conn.ok, true, '端点连通性 PASS')
    assert.match(conn.detail, /正常 · \d+ms/)
    assert.equal(mock.seen.length, 1)
    assert.equal(mock.seen[0].auth, `Bearer ${ENDPOINT_KEY}`, 'Key 进探测请求头（内存态——输出面无原文）')
    // 值不打印红线：doctor 输出面无 Key 原文
    assert.ok(!JSON.stringify(doctor.rows).includes(ENDPOINT_KEY), 'doctor 输出不含 Key 原文')
    // 凭据在位：端点 Key 已在册（值不打印）
    const cred = doctor.rows.find((r) => r.label === '凭据')!
    assert.equal(cred.ok, true)
  } finally {
    env.svc.dispose()
    await mock.close()
  }
})

test('E2E·连通性失败 fail-visible：不可达端点 → doctor 行 ok=false（错误类别，非请求内容）', async () => {
  const env = await makeEnv()
  try {
    await env.svc.dispatch('credentials:key-push', { baseUrl: 'http://127.0.0.1:9', model: 'm', key: 'k' })
    const doctor = (await env.svc.dispatch('doctor:run', { workspaceId: env.ws.id })) as { rows: Array<{ label: string; ok: boolean; detail: string }> }
    const conn = doctor.rows.find((r) => r.label === 'LLM 连通性')!
    assert.equal(conn.ok, false)
    assert.match(conn.detail, /超时|网络错误/)
  } finally {
    env.svc.dispose()
  }
})

test('models:meta：内置静态表（DeepSeek 家族窗口/思考档位）+ 端点声明（Key 永不出面）', async () => {
  const env = await makeEnv()
  try {
    const before = (await env.svc.dispatch('models:meta', {})) as {
      meta: Record<string, { contextWindow: number; thinking: string; label: string }>
      endpoint: { baseUrl: string; model: string; contextWindow: number | null } | null
    }
    assert.equal(before.meta['deepseek-chat'].contextWindow, 128_000)
    assert.equal(before.meta['deepseek-chat'].thinking, 'none')
    assert.equal(before.meta['deepseek-reasoner'].thinking, 'model-level')
    assert.equal(before.endpoint, null, '无端点 = null')
    await env.svc.dispatch('credentials:key-push', { baseUrl: 'http://127.0.0.1:9', model: 'endpoint-model', key: ENDPOINT_KEY, contextWindow: 96_000 })
    const after = (await env.svc.dispatch('models:meta', {})) as {
      endpoint: { baseUrl: string; model: string; contextWindow: number | null; adapterId: 'openai-compat' | 'anthropic' } | null
    }
    // K5-D（V2）：端点面带 adapterId（key-push 缺省 = openai-compat——存量语义）
    assert.deepEqual(after.endpoint, { baseUrl: 'http://127.0.0.1:9', model: 'endpoint-model', contextWindow: 96_000, adapterId: 'openai-compat' })
    assert.ok(!JSON.stringify(after).includes(ENDPOINT_KEY), '端点 Key 永不出 meta 面（N-D1）')
    // 清除
    await env.svc.dispatch('credentials:key-push', { clear: true })
    const cleared = (await env.svc.dispatch('models:meta', {})) as { endpoint: unknown }
    assert.equal(cleared.endpoint, null)
  } finally {
    env.svc.dispose()
  }
})

test('E2E·contextWindow 流转（D-C5）：无端点 + 模型不在元数据表 → null（不显示百分比，禁估算）', async () => {
  const env = await makeEnv()
  assert.equal(env.sess.contextWindow ?? null, null, 'test-model 不在元数据表且无端点声明 → null')
  const opened = (await env.svc.dispatch('session:open', { workspaceId: env.ws.id, sessionId: env.sess.sessionId })) as { contextWindow?: number | null }
  assert.equal(opened.contextWindow ?? null, null)
})

/** OpenAI 兼容 chat 端点 mock：GET /models + POST /chat/completions（SSE 流 + usage 尾块） */
function startChatEndpointMock(): Promise<{
  url: string
  posts: Array<{ auth: string | undefined; body: Record<string, unknown> }>
  close: () => Promise<void>
}> {
  const posts: Array<{ auth: string | undefined; body: Record<string, unknown> }> = []
  const server: Server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const url = req.url ?? ''
      if (req.method === 'GET' && url.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [] }))
        return
      }
      if (req.method === 'POST' && url.endsWith('/chat/completions')) {
        let body: Record<string, unknown> = {}
        try {
          body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
        } catch {}
        posts.push({ auth: req.headers.authorization as string | undefined, body })
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
        res.write(
          'data: ' +
            JSON.stringify({
              id: 'ep-1',
              object: 'chat.completion.chunk',
              choices: [{ index: 0, delta: { role: 'assistant', content: 'endpoint-ok' }, finish_reason: null }],
            }) +
            '\n\n',
        )
        res.write(
          'data: ' +
            JSON.stringify({
              id: 'ep-1',
              object: 'chat.completion.chunk',
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
              usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
            }) +
            '\n\n',
        )
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }
      res.writeHead(404).end()
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
      resolve({ url, posts, close: () => new Promise<void>((r) => server.close(() => r())) })
    })
  })
}

test('E2E·端点真调（1018 终验回归）：car.config adapterId=anthropic + 端点激活 → 装配 openai-compat 真转 chatStep（无 NOADAPTER）', async () => {
  const mock = await startChatEndpointMock()
  const userData = tmpDir('ud')
  const root = tmpDir('ws')
  // 复刻 1018 终验现场：car.config 为 anthropic 形态（商汤网关），端点激活后 adapterId 必须被覆盖
  writeFileSync(join(root, 'car.config.ts'), "export default { llm: { adapterId: 'anthropic', baseUrl: 'http://127.0.0.1:9', model: 'cfg-model' } }\n", 'utf8')
  const svc = createHostService({ userDataDir: userData })
  const pushes: PushMessage[] = []
  svc.onPush((m) => pushes.push(m))
  const events = (): SessionEventDTO[] =>
    pushes.filter((m) => m.topic === 'push:session-event').map((m) => (m.payload as { event: SessionEventDTO }).event)
  try {
    const ws = (await svc.dispatch('workspace:register', { path: root })) as WorkspaceInfo
    await svc.dispatch('credentials:key-push', { baseUrl: mock.url, model: 'endpoint-model', key: ENDPOINT_KEY, contextWindow: 64_000 })
    const info = (await svc.dispatch('session:create', { workspaceId: ws.id })) as SessionInfo & { sessionId: string; modelError?: string | null }
    assert.equal(info.modelError ?? null, null, '端点装配无错（modelError null）')
    const sent = (await svc.dispatch('turn:send', { workspaceId: ws.id, sessionId: info.sessionId, text: 'hi' })) as { turnId: string }
    const deadline = Date.now() + 8000
    let end: SessionEventDTO | undefined
    while (Date.now() < deadline) {
      end = events().find((e) => e.kind === 'turnEnd' && e.turnId === sent.turnId)
      if (end) break
      await new Promise((r) => setTimeout(r, 20))
    }
    assert.ok(end, 'turnEnd 到达')
    assert.equal((end.meta as Record<string, unknown>)['reason'], 'completed', '端点真调 completed（1018 红条：此前 NOADAPTER error）')
    assert.ok(
      events().some((e) => e.kind === 'assistant' && String(e.payload).includes('endpoint-ok')),
      'assistant 内容来自端点',
    )
    assert.equal(mock.posts.length, 1, '端点收到 chat/completions')
    assert.equal(mock.posts[0].auth, `Bearer ${ENDPOINT_KEY}`, '端点 Key 进 Authorization')
    assert.equal(mock.posts[0].body['model'], 'endpoint-model', '端点 model 覆盖 car.config')
  } finally {
    svc.dispose()
    await mock.close()
  }
})

// ==================== K5-D（V2）：端点 adapterId = anthropic（商汤类网关端点路线） ====================

/** Anthropic Messages 端点 mock：GET /v1/models + POST /v1/messages（data-only SSE——内核解析器不依赖 event: 行） */
function startAnthropicEndpointMock(): Promise<{
  url: string
  posts: Array<{ apiKey: string | undefined; auth: string | undefined; body: Record<string, unknown> }>
  gets: number
  close: () => Promise<void>
}> {
  const posts: Array<{ apiKey: string | undefined; auth: string | undefined; body: Record<string, unknown> }> = []
  let gets = 0
  const server: Server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const url = req.url ?? ''
      if (req.method === 'GET' && url.endsWith('/v1/models')) {
        gets++
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [] }))
        return
      }
      if (req.method === 'POST' && url.endsWith('/v1/messages')) {
        let body: Record<string, unknown> = {}
        try {
          body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
        } catch {}
        posts.push({ apiKey: req.headers['x-api-key'] as string | undefined, auth: req.headers.authorization as string | undefined, body })
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
        res.write('data: ' + JSON.stringify({ type: 'message_start', message: { id: 'msg_k5d', usage: { input_tokens: 9 } } }) + '\n\n')
        res.write('data: ' + JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) + '\n\n')
        res.write('data: ' + JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'anthropic-endpoint-ok' } }) + '\n\n')
        res.write('data: ' + JSON.stringify({ type: 'content_block_stop', index: 0 }) + '\n\n')
        res.write('data: ' + JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }) + '\n\n')
        res.write('data: ' + JSON.stringify({ type: 'message_stop' }) + '\n\n')
        res.end()
        return
      }
      res.writeHead(404).end()
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
      resolve({ url, posts, get gets() { return gets }, close: () => new Promise<void>((r) => server.close(() => r())) })
    })
  })
}

test('E2E·K5-D 端点 anthropic 形态：adapterId=anthropic → /v1/messages 真调 + x-api-key + doctor /v1/models + meta 面声明', async () => {
  const mock = await startAnthropicEndpointMock()
  const userData = tmpDir('ud')
  const root = tmpDir('ws')
  // car.config 走 openai 形态占位——端点 adapterId=anthropic 必须压过（端点 > car.config 单向覆盖）
  writeFileSync(join(root, 'car.config.ts'), "export default { llm: { baseUrl: 'http://127.0.0.1:9', model: 'cfg-model' } }\n", 'utf8')
  const svc = createHostService({ userDataDir: userData })
  const pushes: PushMessage[] = []
  svc.onPush((m) => pushes.push(m))
  const events = (): SessionEventDTO[] =>
    pushes.filter((m) => m.topic === 'push:session-event').map((m) => (m.payload as { event: SessionEventDTO }).event)
  try {
    const ws = (await svc.dispatch('workspace:register', { path: root })) as WorkspaceInfo
    await svc.dispatch('credentials:key-push', {
      baseUrl: mock.url, model: 'anthropic-model', key: ENDPOINT_KEY, contextWindow: 128_000, adapterId: 'anthropic',
    })
    const meta = (await svc.dispatch('models:meta', {})) as {
      endpoint: { adapterId: 'openai-compat' | 'anthropic'; contextWindow: number | null } | null
    }
    assert.equal(meta.endpoint?.adapterId, 'anthropic', 'meta 面带端点 adapterId 声明')
    const info = (await svc.dispatch('session:create', { workspaceId: ws.id })) as SessionInfo & { sessionId: string; modelError?: string | null; contextWindow?: number | null }
    assert.equal(info.modelError ?? null, null, 'anthropic 端点装配无错')
    assert.equal(info.contextWindow, 128_000, '端点声明窗口进会话面（token 阈值窗口真值来源）')
    // doctor：anthropic 形态探 GET /v1/models + x-api-key（不是 /models + Bearer）
    const doctor = (await svc.dispatch('doctor:run', { workspaceId: ws.id })) as { rows: Array<{ label: string; ok: boolean; detail: string }> }
    const conn = doctor.rows.find((r) => r.label === 'LLM 连通性')!
    assert.equal(conn.ok, true, 'anthropic 端点连通性 PASS')
    assert.equal(mock.gets, 1, '探测命中 /v1/models（anthropic 路径）')
    // 真调：turn:send → POST /v1/messages（anthropic 适配器）+ x-api-key 头
    const sent = (await svc.dispatch('turn:send', { workspaceId: ws.id, sessionId: info.sessionId, text: 'hi' })) as { turnId: string }
    const deadline = Date.now() + 8000
    let end: SessionEventDTO | undefined
    while (Date.now() < deadline) {
      end = events().find((e) => e.kind === 'turnEnd' && e.turnId === sent.turnId)
      if (end) break
      await new Promise((r) => setTimeout(r, 20))
    }
    assert.ok(end, 'turnEnd 到达')
    assert.equal((end.meta as Record<string, unknown>)['reason'], 'completed', 'anthropic 端点真调 completed')
    assert.ok(events().some((e) => e.kind === 'assistant' && String(e.payload).includes('anthropic-endpoint-ok')), 'assistant 内容来自 anthropic 端点')
    assert.equal(mock.posts.length, 1, '端点收到 /v1/messages')
    assert.equal(mock.posts[0].apiKey, ENDPOINT_KEY, 'Key 进 x-api-key（anthropic 通道）')
    assert.equal(mock.posts[0].auth, undefined, '不走 Bearer（anthropic 形态）')
    assert.equal(mock.posts[0].body['model'], 'anthropic-model', '端点 model 覆盖 car.config')
    // usage 落链（anthropic 两包合并——input 9 / output 3）
    const usage = events().find((e) => e.kind === 'usage' && e.turnId === sent.turnId)
    assert.ok(usage, 'usage 事件落链（K5-D 窗口真值 + token 阈值的事实源）')
    assert.equal((usage!.payload as Record<string, unknown>)['input'], 9)
  } finally {
    svc.dispose()
    await mock.close()
  }
})
