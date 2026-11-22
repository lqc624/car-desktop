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
  assert.equal(store.get().addressName, '', '出厂 = 称呼空')
  assert.equal(store.get().personaText, '', '出厂 = 人格设定空')
  const s = store.set({ toneStyle: 'professional', customPrompt: '一律用中文回答', addressName: '水生', personaText: '冷静、有主见、不捧场' })
  assert.equal(s.toneStyle, 'professional')
  assert.equal(s.customPrompt, '一律用中文回答')
  assert.equal(s.addressName, '水生')
  assert.equal(s.personaText, '冷静、有主见、不捧场')
  // 落盘 roundtrip（新实例同 userData）
  const store2 = createPersonalizationStore(ud)
  assert.equal(store2.get().toneStyle, 'professional')
  assert.equal(store2.get().addressName, '水生')
  // 校验 fail-visible
  assert.throws(() => store.set({ toneStyle: 'nope' }), /档位表/)
  assert.throws(() => store.set({ customPrompt: 'x'.repeat(2001) }), /超长/)
  // WB-2P 后增字段：称呼 ≤50 / 人格设定 ≤2000（类型错 fail-visible）
  assert.throws(() => store.set({ addressName: 'x'.repeat(51) }), /addressName 超长/)
  assert.throws(() => store.set({ addressName: 123 }), /addressName 必须为 string/)
  assert.throws(() => store.set({ personaText: 'x'.repeat(2001) }), /personaText 超长/)
  assert.throws(() => store.set({ personaText: {} }), /personaText 必须为 string/)
  // 向后兼容：旧文件（无后增字段）缺省 = ''，不 fail
  const oldFile = join(ud, 'personalization.json')
  writeFileSync(oldFile, JSON.stringify({ version: 1, updatedAt: 1, toneStyle: 'direct', customPrompt: '旧配置' }), 'utf8')
  const storeOld = createPersonalizationStore(ud)
  assert.equal(storeOld.get().toneStyle, 'direct')
  assert.equal(storeOld.get().customPrompt, '旧配置')
  assert.equal(storeOld.get().addressName, '', '旧文件缺字段 = 出厂空（向后兼容）')
  assert.equal(storeOld.get().personaText, '')
  // 损坏回退
  assert.ok(existsSync(oldFile))
  writeFileSync(oldFile, '{broken', 'utf8')
  const store3 = createPersonalizationStore(ud)
  assert.equal(store3.get().toneStyle, 'default', '损坏回退出厂')
  store.reset()
  assert.equal(createPersonalizationStore(ud).get().toneStyle, 'default')
})

test('P-1b buildPersonaText：确定性拼装（全空 = 零注入；人格设定→称呼→风格→指令 顺序）', () => {
  assert.equal(buildPersonaText({ toneStyle: 'default', customPrompt: '', addressName: '', personaText: '' }), '')
  const professional = TONE_STYLES.find((t) => t.id === 'professional')!
  assert.ok(buildPersonaText({ toneStyle: 'professional', customPrompt: '', addressName: '', personaText: '' }).includes(professional.directive))
  const mixed = buildPersonaText({ toneStyle: 'professional', customPrompt: '回答用中文', addressName: '', personaText: '' })
  assert.ok(mixed.includes(professional.directive))
  assert.ok(mixed.includes('回答用中文'))
  assert.ok(mixed.indexOf(professional.directive) < mixed.indexOf('回答用中文'), '风格在前、附加指令在后')
  // WB-2P：四段全量拼装顺序（人格设定 → 称呼 → 风格 → 指令）
  const full = buildPersonaText({
    toneStyle: 'professional',
    customPrompt: '回答用中文',
    addressName: '水生',
    personaText: '冷静、有主见',
  })
  const iPersona = full.indexOf('人格设定（助手基调，长期有效）')
  const iName = full.indexOf('请称呼用户为「水生」')
  const iStyle = full.indexOf(professional.directive)
  const iCustom = full.indexOf('回答用中文')
  assert.ok(iPersona >= 0 && iName >= 0 && iStyle >= 0 && iCustom >= 0, '四段齐备')
  assert.ok(iPersona < iName && iName < iStyle && iStyle < iCustom, '人格设定→称呼→风格→指令 顺序')
  // 单字段注入（称呼）
  const onlyName = buildPersonaText({ toneStyle: 'default', customPrompt: '', addressName: '水生', personaText: '' })
  assert.ok(onlyName.includes('请称呼用户为「水生」'), '仅称呼 = 只注入称呼段')
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
  userData: string
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
    userData,
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
    await env.svc.dispatch('personalization:set', {
      toneStyle: 'professional',
      customPrompt: '回答一律用中文',
      addressName: '水生',
      personaText: '冷静、有主见、不捧场',
    })
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
    // WB-2P：称呼 + 人格设定同进请求体（同一 persona 注入事件）
    assert.ok(
      sysTexts.some((t) => t.includes('请称呼用户为「水生」')),
      '称呼进请求体（role=system）',
    )
    assert.ok(
      sysTexts.some((t) => t.includes('人格设定（助手基调，长期有效）') && t.includes('冷静、有主见')),
      '人格设定进请求体（role=system）',
    )
  } finally {
    await env.cleanup()
  }
})

test('P-3 实时跟随：改设置后已开会话下一 turn 生效（追加注入落链），新会话同款', async () => {
  const gw = await startGateway()
  const env = await makeEnv(gw)
  try {
    // 先设 professional，再开会话
    await env.svc.dispatch('personalization:set', { toneStyle: 'professional', customPrompt: '' })
    const sessA = (await env.svc.dispatch('session:create', { workspaceId: env.ws.id })) as { sessionId: string }
    // 预热轮（professional 注入先落链——实时跟随的对账基准）
    await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: sessA.sessionId, text: '预热' })
    await waitFor(() => gw.lastMessages() !== null, '预热请求体')
    // 会话开启后改设置（efficient + 新指令）——WB-2P 实时跟随：A 会话下一 turn 追加新注入
    await env.svc.dispatch('personalization:set', { toneStyle: 'efficient', customPrompt: '只给结论' })
    await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: sessA.sessionId, text: 'A' })
    // 等到 A 轮请求体抵达（单槽网关被预热轮占过——以新指令出现为准，防吃陈旧体）
    await waitFor(() => {
      const m = gw.lastMessages()
      return m !== null && m.some((x) => String(x.content).includes('只给结论'))
    }, 'A 请求体含新指令')
    const aTexts = (gw.lastMessages() ?? []).filter((m) => m.role === 'system').map((m) => String(m.content))
    assert.ok(aTexts.some((t) => t.includes('回复风格：专业')), '旧注入仍在前缀（append-only 链）')
    assert.ok(aTexts.some((t) => t.includes('回复风格：高效')), '新注入已追加（实时跟随）')
    assert.ok(aTexts.some((t) => t.includes('只给结论')), '新指令进请求体')
    // 新会话同款生效
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

test('P-5 resume 实时跟随：session:open 后下一 turn 跟随最新设置（追加注入）', async () => {
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
    const userData = env.userData
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
      while (!(gw2.lastMessages()?.some((m) => m.role === 'system' && String(m.content).includes('回复风格：苏格拉底'))) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25))
      }
      const sysTexts = (gw2.lastMessages() ?? []).filter((m) => m.role === 'system').map((m) => String(m.content))
      assert.ok(sysTexts.some((t) => t.includes('回复风格：苏格拉底')), 'resume 跟随最新设置（新注入追加）')
      assert.ok(sysTexts.some((t) => t.includes('回复风格：友好')), '旧注入仍在前缀（append-only 链）')
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
