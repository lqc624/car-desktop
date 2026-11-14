/**
 * v0.9.0 · thinking 消费批（内核 1.22 / D-SD1~D-SD5）
 *
 * 覆盖（《v0.9.0-thinking消费批-迭代规划.md》§3）：
 *  - 组 1：applyStreamDelta 归并——thinkingDelta 追加/换道重建/与 textDelta 共存分流/老载荷（无键）零影响
 *  - 组 2：thinkingRowsFrom 纯函数——同 turn 一块一事件聚合（块数/字数/firstSeq）/跨 turn 分组/空 payload 跳过
 *  - 组 3：E2E openai 形（reasoning_content 假网关，生产 createChatModelFn → chatStep onDelta → service emit
 *    SessionDelta 推送）——thinkingDelta 推送到达、之和 ≡ 掩蔽(payload)（无密钥恒等）、先于 assistant 事件、
 *    与 textDelta 共存、增量不落链、chip 派生联动 audit
 *  - 组 4：E2E anthropic 形（thinking 块假网关）——掩蔽流推送 + thinking 落链事件 + 单块 meta 无 blockIndex
 *  - 组 5：E2E anthropic 多块假网关——两块两事件（blockIndex 0/1）→ chip 派生块数 2
 */
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createHostService, type HostService, type PushMessage } from '../src/host-core/service.ts'
import { applyStreamDelta, thinkingRowsFrom, type StreamBuf } from '../src/renderer/stream-thinking.ts'
import type { SessionDeltaPush, SessionEventPush, WorkspaceInfo } from '../src/shared/ipc-contract.ts'

// ───────────────────────── 组 1：applyStreamDelta 归并（纯函数） ─────────────────────────

const push = (turnId: string, extra: Partial<SessionDeltaPush>): SessionDeltaPush => ({
  workspaceId: 'ws', sessionId: 's', turnId, ts: 0, ...extra,
})

test('组1: applyStreamDelta——thinkingDelta 追加；与 textDelta 共存分流；换道重建；老载荷无键零影响', () => {
  let buf: StreamBuf | null = null
  buf = applyStreamDelta(buf, push('T1', { thinkingDelta: '想一想' }))
  assert.deepEqual(buf, { turnId: 'T1', text: '', toolName: null, thinking: '想一想' })
  // 共存（openai 形 reasoning+content 同 chunk 分流到达）
  buf = applyStreamDelta(buf, push('T1', { thinkingDelta: '第二步', textDelta: '正文' }))
  assert.equal(buf.thinking, '想一想第二步')
  assert.equal(buf.text, '正文')
  // 老内核载荷（无 thinkingDelta 键）——thinking 缓冲零影响
  buf = applyStreamDelta(buf, push('T1', { textDelta: '续' }))
  assert.equal(buf.thinking, '想一想第二步', '可选键向后兼容（老推送不碰 thinking 缓冲）')
  // 换道重建
  buf = applyStreamDelta(buf, push('T2', { thinkingDelta: '新轮' }))
  assert.deepEqual(buf, { turnId: 'T2', text: '', toolName: null, thinking: '新轮' })
})

// ───────────────────────── 组 2：thinkingRowsFrom 聚合（纯函数） ─────────────────────────

const ev = (seq: number, turnId: string, kind: string, payload: unknown, meta?: unknown) =>
  ({ seq, turnId, kind, payload, ...(meta !== undefined ? {} : {}) })

test('组2: thinkingRowsFrom——同 turn 一块一事件聚合（块数/字数/firstSeq）；跨 turn 分组；空 payload 跳过', () => {
  const rows = thinkingRowsFrom([
    ev(0, 'T1', 'user', 'q'),
    ev(1, 'T1', 'thinking', '块一文本', { blockIndex: 0 }),
    ev(2, 'T1', 'thinking', '块二更长一点的文本', { blockIndex: 1 }),
    ev(3, 'T1', 'assistant', '答'),
    ev(4, 'T2', 'thinking', '独立轮思考'),
    ev(5, 'T2', 'assistant', '答2'),
    ev(6, 'T3', 'thinking', '', { redacted: true }), // 空 payload（redacted data 空——异常形态）跳过
  ])
  assert.equal(rows.length, 2, 'T3 空 payload 不产 chip')
  assert.deepEqual(rows[0], { turnId: 'T1', chars: '块一文本'.length + '块二更长一点的文本'.length, blocks: 2, firstSeq: 1 })
  assert.deepEqual(rows[1], { turnId: 'T2', chars: 5, blocks: 1, firstSeq: 4 })
})

// ───────────────────────── 组 3~5：E2E（生产路径挂具——stream-delta 同款） ─────────────────────────

function sseGateway(scripts: string[][], form: 'openai' | 'anthropic'): { server: Server; url: Promise<string>; requests: () => number } {
  let n = 0
  let resolveUrl: (u: string) => void
  const url = new Promise<string>((r) => (resolveUrl = r))
  const server = createServer((req, res) => {
    const script = scripts[Math.min(n, scripts.length - 1)]!
    n++
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const line of script) res.write(line)
    res.end()
  })
  server.listen(0, '127.0.0.1', () => resolveUrl(`http://127.0.0.1:${(server.address() as { port: number }).port}/v1`))
  void form
  return { server, url, requests: () => n }
}

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

async function setup(label: string, scripts: string[][], form: 'openai' | 'anthropic'): Promise<Env> {
  const gw = sseGateway(scripts, form)
  const baseUrl = await gw.url
  const userData = mkdtempSync(join(tmpdir(), `car-think-${label}-ud-`))
  const root = mkdtempSync(join(tmpdir(), `car-think-${label}-ws-`))
  const llm = form === 'anthropic' ? `{ baseUrl: '${baseUrl}', model: 'think-model', adapterId: 'anthropic' }` : `{ baseUrl: '${baseUrl}', model: 'think-model' }`
  writeFileSync(join(root, 'car.config.ts'), `export default { llm: ${llm} }\n`, 'utf8')
  // 凭据 env 兜底（值为假靶料非真实凭据）
  const prev = { key: process.env.OPENAI_API_KEY, ak: process.env.ANTHROPIC_API_KEY, allow: process.env.CAR_ALLOW_ENV_CREDENTIALS }
  process.env.OPENAI_API_KEY = 'sk-test-thinking-stream' // secrets-scan:allow（测试 fixture 假靶料，非真实凭据）
  process.env.ANTHROPIC_API_KEY = 'ak-test-thinking-stream' // secrets-scan:allow（测试 fixture 假靶料，非真实凭据）
  process.env.CAR_ALLOW_ENV_CREDENTIALS = '1'
  const svc = createHostService({ userDataDir: userData, authzTimeoutMs: 120_000 })
  const pushes: PushMessage[] = []
  svc.onPush((m) => pushes.push(m))
  const ws = (await svc.dispatch('workspace:register', { path: root })) as WorkspaceInfo
  const sess = (await svc.dispatch('session:create', { workspaceId: ws.id })) as { sessionId: string; modelError?: string | null }
  assert.equal(sess.modelError ?? null, null, '模型装配失败 = 前置失效（假网关/凭据未通）——先修前提再断言')
  return {
    svc, ws, sid: sess.sessionId, pushes,
    close: async () => {
      process.env.OPENAI_API_KEY = prev.key
      process.env.ANTHROPIC_API_KEY = prev.ak
      process.env.CAR_ALLOW_ENV_CREDENTIALS = prev.allow
      await new Promise<void>((r) => gw.server.close(() => r()))
    },
  }
}

const deltas = (pushes: PushMessage[]): SessionDeltaPush[] =>
  pushes.filter((m) => m.topic === 'push:session-delta').map((m) => m.payload as SessionDeltaPush)

const events = (pushes: PushMessage[]): SessionEventPush[] =>
  pushes.filter((m) => m.topic === 'push:session-event').map((m) => m.payload as SessionEventPush)

const dataLine = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`

test('组3: E2E openai 形——reasoning_content 掩蔽流推送到达、之和≡payload、先于 assistant、与 textDelta 共存、增量不落链', async () => {
  const env = await setup('openai', [[
    dataLine({ choices: [{ delta: { reasoning_content: '先想一步，' } }] }),
    dataLine({ choices: [{ delta: { reasoning_content: '再想一步。' } }] }),
    dataLine({ choices: [{ delta: { content: '正文回答' } }] }),
    dataLine({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    'data: [DONE]\n\n',
  ]], 'openai')
  try {
    const sent = (await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: env.sid, text: '想一下' })) as { turnId: string }
    await waitFor(() => events(env.pushes).find((p) => p.event.kind === 'turnEnd' && p.event.turnId === sent.turnId), 'turnEnd')
    const ds = deltas(env.pushes).filter((d) => d.turnId === sent.turnId)
    const th = ds.filter((d) => d.thinkingDelta !== undefined)
    // 注：推送次数随掩蔽驻留窗粒度浮动（短 chunk 可合并为一推）——不变量 = 之和 ≡ 掩蔽(payload)，
    // 「多次推送」粒度面由既有 stream-delta.spec 长文本用例覆盖（1.19 面）
    assert.ok(th.length >= 1, 'thinkingDelta 推送到达（非零）')
    const joined = th.map((d) => d.thinkingDelta).join('')
    const thEvent = events(env.pushes).find((p) => p.event.kind === 'thinking' && p.event.turnId === sent.turnId)
    assert.ok(thEvent, 'thinking 事件落链（事实本体）')
    assert.equal(joined, typeof thEvent!.event.payload === 'string' ? thEvent!.event.payload : '', '掩蔽流之和 ≡ 落链 payload（无密钥掩蔽恒等——D-C1 两面临界）')
    assert.equal(thEvent!.event.meta?.signature, undefined, 'openai 形无签名 meta')
    const firstThinkIdx = env.pushes.findIndex((m) => m.topic === 'push:session-delta' && (m.payload as SessionDeltaPush).thinkingDelta !== undefined)
    const firstAssistantIdx = env.pushes.findIndex((m) => m.topic === 'push:session-event' && (m.payload as SessionEventPush).event.kind === 'assistant')
    assert.ok(firstThinkIdx >= 0 && firstThinkIdx < firstAssistantIdx, 'thinkingDelta 推送先于 assistant 事件（宿主 emit 序）')
    const textJoined = ds.filter((d) => d.textDelta !== undefined).map((d) => d.textDelta).join('')
    assert.equal(textJoined, '正文回答', 'textDelta 与 thinkingDelta 共存分流（D-SD2 放宽形态）')
    const audit = (await env.svc.dispatch('audit:report', { workspaceId: env.ws.id, sessionId: env.sid })) as { events: Array<{ kind: string; payload: unknown; turnId: string; seq: number }> }
    assert.ok(audit.events.every((e) => e.kind !== 'sessionDelta'), '增量不落链（事实本体在 JSONL 行）')
    // chip 派生联动 audit（渲染层叙事 chip 数据源同构）
    const rows = thinkingRowsFrom(audit.events)
    assert.deepEqual(rows, [{ turnId: sent.turnId, chars: '先想一步，再想一步。'.length, blocks: 1, firstSeq: rows[0]!.firstSeq }])
  } finally {
    await env.close()
  }
})

test('组4: E2E anthropic 形——thinking 块掩蔽流推送 + 落链（单块 meta 无 blockIndex）', async () => {
  const env = await setup('anthropic', [[
    dataLine({ type: 'message_start', message: { role: 'assistant' } }),
    dataLine({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
    dataLine({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '推理由：三只猫三分钟抓三只老鼠。' } }),
    dataLine({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sg-think=' } }),
    dataLine({ type: 'content_block_stop', index: 0 }),
    dataLine({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
    dataLine({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '九分钟。' } }),
    dataLine({ type: 'content_block_stop', index: 1 }),
    dataLine({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
    dataLine({ type: 'message_stop' }),
  ]], 'anthropic')
  try {
    const sent = (await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: env.sid, text: '谜题' })) as { turnId: string }
    await waitFor(() => events(env.pushes).find((p) => p.event.kind === 'turnEnd' && p.event.turnId === sent.turnId), 'turnEnd')
    const ds = deltas(env.pushes).filter((d) => d.turnId === sent.turnId && d.thinkingDelta !== undefined)
    assert.equal(ds.map((d) => d.thinkingDelta).join(''), '推理由：三只猫三分钟抓三只老鼠。', 'anthropic thinking_delta 掩蔽流推送')
    const thEvent = events(env.pushes).find((p) => p.event.kind === 'thinking' && p.event.turnId === sent.turnId)!
    assert.equal(thEvent.event.meta?.signature, 'sg-think=', 'signature 随 meta（1.21 形态）')
    assert.equal(thEvent.event.meta?.blockIndex, undefined, '单块链 meta 无 blockIndex（内核 1.22 兼容线）')
  } finally {
    await env.close()
  }
})

test('组5: E2E anthropic 多块假网关——两块两事件（blockIndex 0/1）→ chip 派生块数 2', async () => {
  const env = await setup('multiblock', [[
    dataLine({ type: 'message_start', message: { role: 'assistant' } }),
    dataLine({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
    dataLine({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '第一块推理。' } }),
    dataLine({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sg-1=' } }),
    dataLine({ type: 'content_block_stop', index: 0 }),
    dataLine({ type: 'content_block_start', index: 1, content_block: { type: 'thinking', thinking: '' } }),
    dataLine({ type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: '第二块继续推理。' } }),
    dataLine({ type: 'content_block_delta', index: 1, delta: { type: 'signature_delta', signature: 'sg-2=' } }),
    dataLine({ type: 'content_block_stop', index: 1 }),
    dataLine({ type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } }),
    dataLine({ type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: '结论。' } }),
    dataLine({ type: 'content_block_stop', index: 2 }),
    dataLine({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
    dataLine({ type: 'message_stop' }),
  ]], 'anthropic')
  try {
    const sent = (await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: env.sid, text: '谜题' })) as { turnId: string }
    await waitFor(() => events(env.pushes).find((p) => p.event.kind === 'turnEnd' && p.event.turnId === sent.turnId), 'turnEnd')
    const audit = (await env.svc.dispatch('audit:report', { workspaceId: env.ws.id, sessionId: env.sid })) as { events: Array<{ kind: string; payload: unknown; turnId: string; seq: number; meta?: Record<string, unknown> }> }
    const ths = audit.events.filter((e) => e.kind === 'thinking' && e.turnId === sent.turnId)
    assert.equal(ths.length, 2, '一块一事件落链')
    assert.deepEqual(ths.map((e) => e.meta?.blockIndex), [0, 1], '多块链 blockIndex 块序')
    assert.deepEqual(ths.map((e) => e.meta?.signature), ['sg-1=', 'sg-2='], '签名随块独立（不再拼接——内核缺陷修复的桌面可见面）')
    const rows = thinkingRowsFrom(audit.events)
    const row = rows.find((r) => r.turnId === sent.turnId)!
    assert.equal(row.blocks, 2, 'chip 派生块数 = 2（叙事 chip「2 块」）')
    assert.equal(row.chars, '第一块推理。'.length + '第二块继续推理。'.length, 'chip 字数 = 两块 payload 长度合计')
  } finally {
    await env.close()
  }
})
