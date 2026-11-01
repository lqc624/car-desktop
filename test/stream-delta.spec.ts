/**
 * 1.19.0 流式增量推送面（D-S2-1 渲染提示面）E2E——发送后不空等的实时执行呈现
 *
 * 链路证明：turn:send → 生产 createChatModelFn → 内核 chatStep onDelta（真 SSE 流，
 * 本地 node:http 假网关——nodeHttpSseFetch 生产路径）→ service emit SessionDelta 推送。
 * 判据：
 *  - SessionDelta 推送先于 assistant 事件推送（宿主 emit 序 = delta → 落链事件）；
 *  - textDelta 之和 ≡ 落链 assistant 全文（屏幕无第二事实源）；
 *  - turnId 请求级锚定（全部 delta 与事件同 turn）；
 *  - toolName 首次可知即推送一次（工具流式期不空等）；
 *  - 增量不落链：JSONL/audit 事件面零 delta 痕迹（事实本体仍在落盘行）。
 */
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createHostService, type HostService, type PushMessage } from '../src/host-core/service.ts'
import type { SessionDeltaPush, SessionEventPush, WorkspaceInfo } from '../src/shared/ipc-contract.ts'

function tmpDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `car-stream-delta-${label}-`))
}

const dataLine = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`

/** 本地 SSE 假网关：按请求序播放脚本（每请求一段 chunk 列表——多步 turn 逐请求推进） */
function sseGateway(scripts: string[][]): { server: Server; url: Promise<string>; requests: number } {
  let requests = 0
  let resolveUrl: (u: string) => void
  const url = new Promise<string>((r) => (resolveUrl = r))
  const server = createServer((req, res) => {
    const script = scripts[Math.min(requests, scripts.length - 1)]!
    requests++
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const line of script) res.write(line)
    res.end()
  })
  server.listen(0, '127.0.0.1', () => resolveUrl(`http://127.0.0.1:${(server.address() as { port: number }).port}/v1`))
  return { server, url, get requests() { return requests } }
}

/** 等待谓词成立（turn 收口为异步——禁 sleep 猜测） */
async function waitFor<T>(fn: () => T | null | undefined, label: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() > deadline) throw new Error(`waitFor 超时：${label}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

interface Env {
  svc: HostService
  ws: WorkspaceInfo
  sid: string
  pushes: PushMessage[]
  close: () => Promise<void>
}

async function setup(label: string, scripts: string[][]): Promise<Env> {
  const gw = sseGateway(scripts)
  const baseUrl = await gw.url
  const userData = tmpDir(label + '-ud')
  const root = tmpDir(label + '-ws')
  writeFileSync(join(root, 'car.config.ts'), `export default { llm: { baseUrl: '${baseUrl}', model: 'stream-model' } }\n`, 'utf8')
  // 凭据 env 兜底（loadHostRuntime 契约：CAR_ALLOW_ENV_CREDENTIALS=1——进程内封闭，测试后还原）；
  // 值为假靶料（凭据在位探测只需非空串）——secrets-scan:allow（测试 fixture，非真实凭据）
  const prevKey = process.env.OPENAI_API_KEY
  const prevAllow = process.env.CAR_ALLOW_ENV_CREDENTIALS
  process.env.OPENAI_API_KEY = 'sk-test-stream-delta' // secrets-scan:allow（测试 fixture 假靶料，非真实凭据）
  process.env.CAR_ALLOW_ENV_CREDENTIALS = '1'
  const svc = createHostService({ userDataDir: userData, authzTimeoutMs: 120_000 })
  const pushes: PushMessage[] = []
  svc.onPush((m) => pushes.push(m))
  const ws = (await svc.dispatch('workspace:register', { path: root })) as WorkspaceInfo
  const sess = (await svc.dispatch('session:create', { workspaceId: ws.id })) as { sessionId: string; modelError?: string | null }
  assert.equal(sess.modelError ?? null, null, '模型装配失败 = 前置失效（假网关/凭据未通）——先修前提再断言')
  return {
    svc,
    ws,
    sid: sess.sessionId,
    pushes,
    close: async () => {
      process.env.OPENAI_API_KEY = prevKey
      process.env.CAR_ALLOW_ENV_CREDENTIALS = prevAllow
      await new Promise<void>((r) => gw.server.close(() => r()))
    },
  }
}

const deltas = (pushes: PushMessage[]): SessionDeltaPush[] =>
  pushes.filter((m) => m.topic === 'push:session-delta').map((m) => m.payload as SessionDeltaPush)

const events = (pushes: PushMessage[]): SessionEventPush[] =>
  pushes.filter((m) => m.topic === 'push:session-event').map((m) => m.payload as SessionEventPush)

test('流式增量 E2E：textDelta 先于 assistant 事件、之和 ≡ 落链全文、turnId 同源', async () => {
  const env = await setup('text', [[
    dataLine({ choices: [{ delta: { content: '你好，这是一段比较长' } }] }),
    dataLine({ choices: [{ delta: { content: '的流式输出文本，用来确' } }] }),
    dataLine({ choices: [{ delta: { content: '保增量逐步放行不攒批。' } }] }),
    dataLine({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    'data: [DONE]\n\n',
  ]])
  try {
    const sent = (await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: env.sid, text: '打个招呼' })) as { turnId: string }
    await waitFor(() => events(env.pushes).find((p) => p.event.kind === 'turnEnd' && p.event.turnId === sent.turnId), 'turnEnd')
    const ds = deltas(env.pushes).filter((d) => d.turnId === sent.turnId && d.textDelta !== undefined)
    assert.ok(ds.length >= 2, '多 chunk 多次推送（非攒一次）')
    const joined = ds.map((d) => d.textDelta).join('')
    const assistant = events(env.pushes).find((p) => p.event.kind === 'assistant' && p.event.turnId === sent.turnId)
    assert.equal(assistant && typeof assistant.event.payload === 'string' ? assistant.event.payload : null, joined, '增量之和 ≡ 落链 assistant 全文')
    const firstAssistantIdx = env.pushes.findIndex((m) => m.topic === 'push:session-event' && (m.payload as SessionEventPush).event.kind === 'assistant')
    const lastDeltaIdx = env.pushes.map((m) => m.topic).lastIndexOf('push:session-delta')
    assert.ok(lastDeltaIdx < firstAssistantIdx, '推送序 = delta 全部先于 assistant 事件（宿主 emit 序）')
    assert.ok(ds.every((d) => d.workspaceId === env.ws.id && d.sessionId === env.sid), '归组键齐全（workspace/session/turn）')
    // 增量不落链：audit 事件面零 delta 痕迹
    const audit = (await env.svc.dispatch('audit:report', { workspaceId: env.ws.id, sessionId: env.sid })) as { events: Array<{ kind: string }> }
    assert.ok(audit.events.every((e) => e.kind !== 'sessionDelta'), '增量不落链（事实本体仍在 JSONL）')
  } finally {
    await env.close()
  }
})

test('流式增量 E2E：toolName 首次可知推送一次——工具名不空等，第二步文本续流', async () => {
  const env = await setup('tool', [
    [
      dataLine({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'fs_read', arguments: '{"path":"x.txt"}' } }] } }] }),
      dataLine({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      'data: [DONE]\n\n',
    ],
    [
      dataLine({ choices: [{ delta: { content: 'done' } }] }),
      dataLine({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      'data: [DONE]\n\n',
    ],
  ])
  try {
    const sent = (await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: env.sid, text: '读个文件' })) as { turnId: string }
    await waitFor(() => events(env.pushes).find((p) => p.event.kind === 'turnEnd' && p.event.turnId === sent.turnId), 'turnEnd')
    const ds = deltas(env.pushes).filter((d) => d.turnId === sent.turnId)
    const names = ds.filter((d) => d.toolName !== undefined)
    assert.deepEqual(names.map((d) => d.toolName), ['fs_read'], 'toolName 恰一次（args 流式期不重复推送）')
    const firstToolNameIdx = env.pushes.findIndex((m) => m.topic === 'push:session-delta' && (m.payload as SessionDeltaPush).toolName !== undefined)
    const toolCallIdx = env.pushes.findIndex((m) => m.topic === 'push:session-event' && (m.payload as SessionEventPush).event.kind === 'toolCall')
    assert.ok(firstToolNameIdx < toolCallIdx, 'toolName 推送先于 toolCall 事件落链（不空等）')
    const secondStep = ds.filter((d) => d.textDelta !== undefined).map((d) => d.textDelta).join('')
    assert.equal(secondStep, 'done', '第二步文本增量续流（每步独立缓冲）')
    const end = events(env.pushes).filter((p) => p.event.kind === 'turnEnd' && p.event.turnId === sent.turnId).at(-1)
    assert.equal(end && (end.event.meta as Record<string, unknown> | null)?.['reason'], 'completed', 'turn 正常收口')
  } finally {
    await env.close()
  }
})
