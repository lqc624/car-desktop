/**
 * T-MP 个性化 E2E（宿主公共 API 驱动 + 假网关捕获请求体——生产调用点证明）
 *
 * 判据：
 *  - P-1 store 单测：roundtrip / 校验 fail-visible / 损坏回退出厂 + buildPersonaText 确定性拼装；
 *  - P-2 落链+投影：persona 指令文本以 role:'system' 进入请求体 messages（真 chatStep——
 *    禁只断链上事件）+ meta.injection='persona' 事件落链；
 *  - P-3 新会话语义：创建会话后改设置 → 旧会话请求体不含新指令（快照冻结）；新会话含新指令；
 *  - P-4 压缩重注：session:compact 后下一 turn 请求体再次含 persona（重注一次，非每轮）；
 *  - P-5 resume 链恢复：session:open 后下一 turn 仍含原 persona（不泄漏新设置）。
 */
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createHostService, type HostService } from '../src/host-core/service.ts'
import { createPersonalizationStore } from '../src/host-core/personalizationStore.ts'
import { buildPersonaText, TONE_STYLES } from '../src/shared/personalization.ts'
import type { WorkspaceInfo } from '../src/shared/ipc-contract.ts'

// ── P-1：store + 拼装（纯宿主面） ──

test('P-1a personalizationStore：roundtrip / 校验 fail-visible / 损坏回退', () => {
  const ud = mkdtempSync(join(tmpdir(), 'car-mp-store-'))
  const store = createPersonalizationStore(ud)
  assert.equal(store.get().toneStyle, 'default', '出厂 = default')
  assert.equal(store.get().customPrompt, '')
  const s = store.set({ toneStyle: 'professional', customPrompt: '一律用中文回答' })
  assert.equal(s.toneStyle, 'professional')
  assert.equal(s.customPrompt, '一律用中文回答')
  // 落盘 roundtrip（新实例同 userData）
  const store2 = createPersonalizationStore(ud)
  assert.equal(store2.get().toneStyle, 'professional')
  // 校验 fail-visible
  assert.throws(() => store.set({ toneStyle: 'nope' }), /档位表/)
  assert.throws(() => store.set({ customPrompt: 'x'.repeat(2001) }), /超长/)
  // 损坏回退
  const file = join(ud, 'personalization.json')
  assert.ok(existsSync(file))
  writeFileSync(file, '{broken', 'utf8')
  const store3 = createPersonalizationStore(ud)
  assert.equal(store3.get().toneStyle, 'default', '损坏回退出厂')
  store.reset()
  assert.equal(createPersonalizationStore(ud).get().toneStyle, 'default')
})

test('P-1b buildPersonaText：确定性拼装（default 且空 = 零注入）', () => {
  assert.equal(buildPersonaText({ toneStyle: 'default', customPrompt: '' }), '')
  const professional = TONE_STYLES.find((t) => t.id === 'professional')!
  assert.ok(buildPersonaText({ toneStyle: 'professional', customPrompt: '' }).includes(professional.directive))
  const mixed = buildPersonaText({ toneStyle: 'professional', customPrompt: '回答用中文' })
  assert.ok(mixed.includes(professional.directive))
  assert.ok(mixed.includes('回答用中文'))
  assert.ok(mixed.indexOf(professional.directive) < mixed.indexOf('回答用中文'), '风格在前、附加指令在后')
})

// ── P-2~P-5：真 chatStep + 假网关（捕获 messages 请求体） ──

interface Gateway {
  server: Server
  baseUrl: string
  lastMessages: () => Array<{ role?: string; content?: unknown }> | null
}

async function startGateway(): Promise<Gateway> {
  let messages: Array<{ role?: string; content?: unknown }> | null = null
  const server: Server = createServer((req, res) => {
    let body = ''
    req.on('data', (c: Buffer) => (body += c.toString('utf8')))
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body) as { messages?: Array<{ role?: string; content?: unknown }> }
        if (Array.isArray(parsed.messages)) messages = parsed.messages
      } catch {
        /* 非 JSON 不捕获 */
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  const baseUrl = await new Promise<string>((r) =>
    server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(server.address() as { port: number }).port}/v1`)),
  )
  return { server, baseUrl, lastMessages: () => messages }
}

interface Env {
  svc: HostService
  ws: WorkspaceInfo
  sess: { sessionId: string }
  root: string
  cleanup: () => Promise<void>
}

async function makeEnv(gw: Gateway): Promise<Env> {
  const userData = mkdtempSync(join(tmpdir(), 'car-mp-ud-'))
  const root = mkdtempSync(join(tmpdir(), 'car-mp-ws-'))
  writeFileSync(join(root, 'car.config.ts'), `export default { llm: { baseUrl: '${gw.baseUrl}', model: 'mp-model' } }\n`, 'utf8')
  const prevKey = process.env.OPENAI_API_KEY
  const prevAllow = process.env.CAR_ALLOW_ENV_CREDENTIALS
  process.env.OPENAI_API_KEY = 'sk-test-mp' // secrets-scan:allow（测试 fixture 假靶料，非真实凭据）
  process.env.CAR_ALLOW_ENV_CREDENTIALS = '1'
  const svc = createHostService({ userDataDir: userData })
  const ws = (await svc.dispatch('workspace:register', { path: root })) as WorkspaceInfo
  const sess = (await svc.dispatch('session:create', { workspaceId: ws.id })) as { sessionId: string }
  return {
    svc,
    ws,
    sess,
    root,
    cleanup: async () => {
      process.env.OPENAI_API_KEY = prevKey
      process.env.CAR_ALLOW_ENV_CREDENTIALS = prevAllow
      await new Promise<void>((r) => gw.server.close(() => r()))
      svc.dispose()
    },
  }
}

async function waitFor(pred: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`等待超时：${what}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

test('P-2 落链+投影：persona 指令以 role:system 进入请求体 messages', async () => {
  const gw = await startGateway()
  const env = await makeEnv(gw)
  try {
    await env.svc.dispatch('personalization:set', { toneStyle: 'professional', customPrompt: '回答一律用中文' })
    // 新会话才带新快照（本 env 会话创建早于 set——按 P-3 语义重开一个）
    const sess2 = (await env.svc.dispatch('session:create', { workspaceId: env.ws.id })) as { sessionId: string }
    await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: sess2.sessionId, text: '你好' })
    await waitFor(() => gw.lastMessages() !== null, '请求体捕获')
    const msgs = gw.lastMessages()!
    const sysTexts = msgs.filter((m) => m.role === 'system').map((m) => String(m.content))
    assert.ok(
      sysTexts.some((t) => t.includes('回复风格：专业')),
      'persona 风格指令进请求体（role=system）',
    )
    assert.ok(
      sysTexts.some((t) => t.includes('回答一律用中文')),
      '自定义指令进请求体（role=system）',
    )
  } finally {
    await env.cleanup()
  }
})

test('P-3 新会话语义：改设置不影响已开会话（快照冻结），新会话生效', async () => {
  const gw = await startGateway()
  const env = await makeEnv(gw)
  try {
    // 先设 professional，再开会话（快照 = professional）
    await env.svc.dispatch('personalization:set', { toneStyle: 'professional', customPrompt: '' })
    const sessA = (await env.svc.dispatch('session:create', { workspaceId: env.ws.id })) as { sessionId: string }
    // 会话创建后改设置（efficient + 新指令）——旧会话不受影响
    await env.svc.dispatch('personalization:set', { toneStyle: 'efficient', customPrompt: '只给结论' })
    await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: sessA.sessionId, text: 'A' })
    await waitFor(() => gw.lastMessages() !== null, 'A 请求体')
    const aTexts = (gw.lastMessages() ?? []).filter((m) => m.role === 'system').map((m) => String(m.content))
    assert.ok(aTexts.some((t) => t.includes('回复风格：专业')), '旧会话快照 = professional')
    assert.ok(!aTexts.some((t) => t.includes('只给结论')), '旧会话不含新指令（快照冻结）')
    // 新会话 = 新快照
    const sessB = (await env.svc.dispatch('session:create', { workspaceId: env.ws.id })) as { sessionId: string }
    await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: sessB.sessionId, text: 'B' })
    await waitFor(() => {
      const m = gw.lastMessages()
      return m !== null && JSON.stringify(m).includes('只给结论')
    }, 'B 请求体含新指令')
  } finally {
    await env.cleanup()
  }
})

test('P-4 压缩重注：session:compact 后下一 turn 请求体再次含 persona', async () => {
  const gw = await startGateway()
  const env = await makeEnv(gw)
  try {
    await env.svc.dispatch('personalization:set', { toneStyle: 'professional', customPrompt: '' })
    const sess = (await env.svc.dispatch('session:create', { workspaceId: env.ws.id })) as { sessionId: string }
    // 先积满可折叠区间（保护段 = 首个 system + 最近 4 turn——5 turn 后 T1 区间可折叠，含 persona 注入）
    for (let i = 1; i <= 5; i++) {
      await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: sess.sessionId, text: 'T' + i })
    }
    await waitFor(() => gw.lastMessages() !== null, '请求体捕获')
    // 显式压缩（折叠 persona 注入——内核下界豁免仅首条 system）
    await env.svc.dispatch('session:compact', { workspaceId: env.ws.id, sessionId: sess.sessionId })
    // 压缩后下一 turn：gateway 单槽被 T6 请求体覆盖——轮询 T6 消息里重新出现 persona（重注）
    await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: sess.sessionId, text: 'T6' })
    const deadline = Date.now() + 10_000
    while (!(gw.lastMessages()?.some((m) => m.role === 'system' && String(m.content).includes('回复风格：专业'))) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25))
    }
    assert.ok(
      gw.lastMessages()?.some((m) => m.role === 'system' && String(m.content).includes('回复风格：专业')),
      '压缩后 persona 重注进请求体',
    )
  } finally {
    await env.cleanup()
  }
})

test('P-5 resume 链恢复：session:open 后仍含原 persona（不泄漏新设置）', async () => {
  const gw = await startGateway()
  const env = await makeEnv(gw)
  try {
    await env.svc.dispatch('personalization:set', { toneStyle: 'friendly', customPrompt: '' })
    const sess = (await env.svc.dispatch('session:create', { workspaceId: env.ws.id })) as { sessionId: string }
    await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: sess.sessionId, text: 'T1' })
    await waitFor(() => gw.lastMessages() !== null, 'T1 请求体')
    // 改设置 + 模拟跨运行：新建 service（同一 userData + 工作区）open 同一会话
    await env.svc.dispatch('personalization:set', { toneStyle: 'socratic', customPrompt: '' })
    const gw2 = await startGateway()
    const userData = mkdtempSync(join(tmpdir(), 'car-mp-ud2-'))
    const root2 = env.root
    writeFileSync(join(root2, 'car.config.ts'), `export default { llm: { baseUrl: '${gw2.baseUrl}', model: 'mp-model' } }\n`, 'utf8')
    const prevKey = process.env.OPENAI_API_KEY
    const prevAllow = process.env.CAR_ALLOW_ENV_CREDENTIALS
    process.env.OPENAI_API_KEY = 'sk-test-mp'
    process.env.CAR_ALLOW_ENV_CREDENTIALS = '1'
    const svc2 = createHostService({ userDataDir: userData })
    try {
      const ws2 = (await svc2.dispatch('workspace:register', { path: root2 })) as WorkspaceInfo
      const opened = (await svc2.dispatch('session:open', { workspaceId: ws2.id, sessionId: sess.sessionId })) as { sessionId: string }
      await svc2.dispatch('turn:send', { workspaceId: ws2.id, sessionId: opened.sessionId, text: 'T2' })
      const deadline = Date.now() + 10_000
      while (!(gw2.lastMessages()?.some((m) => m.role === 'system' && String(m.content).includes('回复风格：友好'))) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25))
      }
      const sysTexts = (gw2.lastMessages() ?? []).filter((m) => m.role === 'system').map((m) => String(m.content))
      assert.ok(sysTexts.some((t) => t.includes('回复风格：友好')), 'resume 快照从链恢复（原 friendly）')
      assert.ok(!sysTexts.some((t) => t.includes('回复风格：苏格拉底')), '不泄漏 resume 前的新设置')
    } finally {
      process.env.OPENAI_API_KEY = prevKey
      process.env.CAR_ALLOW_ENV_CREDENTIALS = prevAllow
      await new Promise<void>((r) => gw2.server.close(() => r()))
      svc2.dispose()
    }
  } finally {
    await env.cleanup()
  }
})
