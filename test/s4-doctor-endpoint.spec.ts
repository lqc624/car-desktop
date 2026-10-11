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
import type { SessionInfo, WorkspaceInfo } from '../src/shared/ipc-contract.ts'
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
      endpoint: { baseUrl: string; model: string; contextWindow: number | null } | null
    }
    assert.deepEqual(after.endpoint, { baseUrl: 'http://127.0.0.1:9', model: 'endpoint-model', contextWindow: 96_000 })
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
