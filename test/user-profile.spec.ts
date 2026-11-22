/**
 * WB-2 用户级画像 E2E（宿主公共 API 驱动 + 假网关捕获请求体——生产调用点证明）
 *
 * 参考面：WorkBuddy 个性化设置（~/.workbuddy/USER.md 用户画像 + MEMORY.md 跨项目约定——
 * 用户级跨工作区常驻注入）。CAR 形态 = userData 级 store + 显式开关（出厂关）+ 预算
 * fail-visible + 落链（D-46 三件套）——挂 persona 常驻指令面家族（T-MP 同款三态语义）。
 *
 * 判据：
 *  - UP-1 store 单测：roundtrip / 校验 fail-visible（kind / 单条超长 / 条数超限 / 总量超预算 /
 *    enabled 非布尔）/ 损坏回退出厂 + buildUserProfileText 确定性拼装（关 = 零 / 空节省略）；
 *  - UP-2 落链+投影：enabled 后画像文本以 role:'system' 进入请求体 messages（真 chatStep——
 *    禁只断链上事件）+ meta.injection='user-profile' 事件落链（count/chars 真值，首轮恰一条）；
 *  - UP-3 出厂关（D-46）：不 set → 零注入零落链（请求体无画像行 + 链无 user-profile 事件）；
 *  - UP-4 实时跟随（WB-2P）：会话开启后改画像 → 已开会话下一 turn 追加新注入（旧注入仍在前缀）；新会话仅新条目；
 *  - UP-5 压缩重注：session:compact 后下一 turn 请求体再次含画像（重注一次）；
 *  - UP-6 resume 链恢复：新 userData（出厂 store）open 旧会话 → 画像从链恢复（不读 store）。
 */
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createHostService, type HostService, type PushMessage } from '../src/host-core/service.ts'
import { createUserProfileStore } from '../src/host-core/userProfileStore.ts'
import { buildUserProfileText } from '../src/shared/userProfile.ts'
import type { SessionEventDTO, SessionEventPush, WorkspaceInfo } from '../src/shared/ipc-contract.ts'

// ── UP-1：store + 拼装（纯宿主面） ──

test('UP-1a userProfileStore：roundtrip / 校验 fail-visible / 损坏回退', () => {
  const ud = mkdtempSync(join(tmpdir(), 'car-up-store-'))
  const store = createUserProfileStore(ud)
  assert.equal(store.get().enabled, false, '出厂 = 显式开关关（D-46）')
  assert.deepEqual(store.get().entries, [])
  const s = store.set({ enabled: true, entries: [{ kind: 'profile', text: '称呼「水生」' }, { kind: 'convention', text: 'GitHub 克隆走国内镜像' }] })
  assert.equal(s.enabled, true)
  assert.equal(s.entries.length, 2)
  assert.ok(s.entries[0]!.id, 'normalizeEntry 补发 id')
  // 落盘 roundtrip（新实例同 userData——id/text 保真）
  const store2 = createUserProfileStore(ud)
  assert.equal(store2.get().enabled, true)
  assert.equal(store2.get().entries[0]!.text, '称呼「水生」')
  assert.equal(store2.get().entries[0]!.id, s.entries[0]!.id, 'roundtrip id 稳定')
  // 校验 fail-visible（禁静默截断）
  assert.throws(() => store.set({ enabled: 'yes' }), /enabled/)
  assert.throws(() => store.set({ entries: [{ kind: 'other', text: 'x' }] }), /kind/)
  assert.throws(() => store.set({ entries: [{ kind: 'profile', text: 1 }] }), /必须为 string/)
  assert.throws(() => store.set({ entries: [{ kind: 'profile', text: 'x'.repeat(1001) }] }), /超长/)
  assert.throws(() => store.set({ entries: Array.from({ length: 17 }, (_, i) => ({ kind: 'profile' as const, text: '条' + i })) }), /条目数超限/)
  // 总量超预算（单条/条数均合法——渲染实长 >4000 仍拒，注入面所见即所校）
  assert.throws(
    () => store.set({ enabled: true, entries: Array.from({ length: 5 }, () => ({ kind: 'profile' as const, text: 'x'.repeat(1000) })) }),
    /总量超预算/,
  )
  // 损坏回退
  const file = join(ud, 'user-profile.json')
  assert.ok(existsSync(file))
  writeFileSync(file, '{broken', 'utf8')
  const store3 = createUserProfileStore(ud)
  assert.equal(store3.get().enabled, false, '损坏回退出厂')
  store.reset()
  assert.equal(createUserProfileStore(ud).get().enabled, false)
})

test('UP-1b buildUserProfileText：确定性拼装（关 = 零注入 / 零条目 = 零注入 / 空节省略）', () => {
  assert.equal(buildUserProfileText({ enabled: false, entries: [{ id: '1', kind: 'profile', text: 'x', updatedAt: 0 }] }), '', '未启用 = 零注入')
  assert.equal(buildUserProfileText({ enabled: true, entries: [] }), '', '零条目 = 零注入')
  const text = buildUserProfileText({
    enabled: true,
    entries: [
      { id: '1', kind: 'profile', text: '称呼「水生」', updatedAt: 0 },
      { id: '2', kind: 'convention', text: '回答一律用中文', updatedAt: 0 },
    ],
  })
  assert.ok(text.startsWith('用户长期记忆（跨工作区 · 用户显式维护）'), '标题行在前')
  assert.ok(text.includes('## 用户画像') && text.includes('称呼「水生」'), '画像节')
  assert.ok(text.includes('## 跨工作区约定') && text.includes('回答一律用中文'), '约定节')
  assert.ok(text.indexOf('## 用户画像') < text.indexOf('## 跨工作区约定'), '画像节先于约定节')
  const onlyConvention = buildUserProfileText({ enabled: true, entries: [{ id: '1', kind: 'convention', text: 'y', updatedAt: 0 }] })
  assert.ok(!onlyConvention.includes('## 用户画像'), '空节省略')
})

// ── UP-2~UP-6：真 chatStep + 假网关（捕获 messages 请求体） ──

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
  pushes: PushMessage[]
  cleanup: () => Promise<void>
}

async function makeEnv(gw: Gateway): Promise<Env> {
  const userData = mkdtempSync(join(tmpdir(), 'car-up-ud-'))
  const root = mkdtempSync(join(tmpdir(), 'car-up-ws-'))
  writeFileSync(join(root, 'car.config.ts'), `export default { llm: { baseUrl: '${gw.baseUrl}', model: 'up-model' } }\n`, 'utf8')
  const prevKey = process.env.OPENAI_API_KEY
  const prevAllow = process.env.CAR_ALLOW_ENV_CREDENTIALS
  process.env.OPENAI_API_KEY = 'sk-test-up' // secrets-scan:allow（测试 fixture 假靶料，非真实凭据）
  process.env.CAR_ALLOW_ENV_CREDENTIALS = '1'
  const svc = createHostService({ userDataDir: userData })
  const pushes: PushMessage[] = []
  svc.onPush((m) => pushes.push(m))
  const ws = (await svc.dispatch('workspace:register', { path: root })) as WorkspaceInfo
  const sess = (await svc.dispatch('session:create', { workspaceId: ws.id })) as { sessionId: string }
  return {
    svc,
    ws,
    sess,
    root,
    pushes,
    cleanup: async () => {
      process.env.OPENAI_API_KEY = prevKey
      process.env.CAR_ALLOW_ENV_CREDENTIALS = prevAllow
      await new Promise<void>((r) => gw.server.close(() => r()))
      svc.dispose()
    },
  }
}

function userProfEvents(pushes: PushMessage[]): SessionEventDTO[] {
  return pushes
    .filter((m) => m.topic === 'push:session-event')
    .map((m) => (m.payload as SessionEventPush).event)
    .filter((e) => e.kind === 'system' && (e.meta as Record<string, unknown> | null)?.['injection'] === 'user-profile')
}

/** 按会话过滤的 user-profile 注入事件（UP-4/UP-7 多会话计数用） */
function userProfEventsFor(pushes: PushMessage[], sessionId: string): SessionEventDTO[] {
  return pushes
    .filter((m) => m.topic === 'push:session-event' && (m.payload as SessionEventPush).sessionId === sessionId)
    .map((m) => (m.payload as SessionEventPush).event)
    .filter((e) => e.kind === 'system' && (e.meta as Record<string, unknown> | null)?.['injection'] === 'user-profile')
}

async function waitFor(pred: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`等待超时：${what}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

const UP_ENTRY = { kind: 'convention' as const, text: '回答一律用中文' }

test('UP-2 落链+投影：enabled 后画像以 role:system 进入请求体 + meta 事件落链（首轮恰一条）', async () => {
  const gw = await startGateway()
  const env = await makeEnv(gw)
  try {
    await env.svc.dispatch('user-profile:set', { enabled: true, entries: [UP_ENTRY] })
    // 新会话才带新快照（env.sess 创建早于 set——按 UP-4 语义重开一个）
    const sess2 = (await env.svc.dispatch('session:create', { workspaceId: env.ws.id })) as { sessionId: string }
    await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: sess2.sessionId, text: '你好' })
    await waitFor(() => gw.lastMessages() !== null, '请求体捕获')
    const sysTexts = (gw.lastMessages() ?? []).filter((m) => m.role === 'system').map((m) => String(m.content))
    assert.ok(sysTexts.some((t) => t.includes('用户长期记忆（跨工作区 · 用户显式维护）')), '画像标题行进请求体（role=system）')
    assert.ok(sysTexts.some((t) => t.includes('回答一律用中文')), '约定条目进请求体（role=system）')
    // 链上面：首轮恰一条 user-profile 注入事件（count/chars 真值）
    const events = userProfEvents(env.pushes)
    assert.equal(events.length, 1, '首轮恰一条 user-profile 落链事件')
    const meta = events[0]!.meta as Record<string, unknown>
    assert.equal(meta['count'], 1, 'count = 条目数')
    assert.ok(Number(meta['chars']) > 0, 'chars = 拼装实长')
  } finally {
    await env.cleanup()
  }
})

test('UP-3 出厂关（D-46）：不 set → 零注入零落链', async () => {
  const gw = await startGateway()
  const env = await makeEnv(gw)
  try {
    await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, text: '你好' })
    await waitFor(() => gw.lastMessages() !== null, '请求体捕获')
    const all = JSON.stringify(gw.lastMessages() ?? [])
    assert.ok(!all.includes('用户级画像'), '出厂关 = 请求体无记忆行')
    assert.equal(userProfEvents(env.pushes).length, 0, '出厂关 = 链无 user-profile 事件')
  } finally {
    await env.cleanup()
  }
})

test('UP-4 实时跟随：改画像后已开会话下一 turn 生效（追加注入），新会话同款', async () => {
  const gw = await startGateway()
  const env = await makeEnv(gw)
  try {
    // 先启用并开会话
    await env.svc.dispatch('user-profile:set', { enabled: true, entries: [UP_ENTRY] })
    const sessA = (await env.svc.dispatch('session:create', { workspaceId: env.ws.id })) as { sessionId: string }
    await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: sessA.sessionId, text: '预热' })
    await waitFor(() => gw.lastMessages() !== null, '预热请求体')
    const preCount = userProfEventsFor(env.pushes, sessA.sessionId).length
    assert.equal(preCount, 1, '开启后首轮恰一条注入')
    // 会话开启后改画像（换条目）——WB-2P 实时跟随：A 会话下一 turn 追加新注入
    await env.svc.dispatch('user-profile:set', { enabled: true, entries: [{ kind: 'profile' as const, text: '主力栈 TypeScript' }] })
    await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: sessA.sessionId, text: 'A' })
    await waitFor(() => {
      const m = gw.lastMessages()
      return m !== null && JSON.stringify(m).includes('主力栈 TypeScript')
    }, 'A 请求体含新条目')
    const aTexts = (gw.lastMessages() ?? []).filter((m) => m.role === 'system').map((m) => String(m.content))
    assert.ok(aTexts.some((t) => t.includes('回答一律用中文')), '旧注入仍在前缀（append-only 链）')
    assert.ok(aTexts.some((t) => t.includes('主力栈 TypeScript')), '新注入已追加（实时跟随）')
    assert.equal(userProfEventsFor(env.pushes, sessA.sessionId).length, 2, 'A 会话恰两条注入（旧+新）')
    // 新会话 = 仅新条目
    const sessB = (await env.svc.dispatch('session:create', { workspaceId: env.ws.id })) as { sessionId: string }
    await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: sessB.sessionId, text: 'B' })
    await waitFor(() => {
      const m = gw.lastMessages()
      return m !== null && JSON.stringify(m).includes('主力栈 TypeScript')
    }, 'B 请求体含新条目')
    assert.equal(userProfEventsFor(env.pushes, sessB.sessionId).length, 1, '新会话恰一条新注入')
  } finally {
    await env.cleanup()
  }
})

test('UP-7 关闭后停止新增：同会话下一 turn 零新注入（旧注入随前缀保留——append-only）', async () => {
  const gw = await startGateway()
  const env = await makeEnv(gw)
  try {
    await env.svc.dispatch('user-profile:set', { enabled: true, entries: [UP_ENTRY] })
    const sess = (await env.svc.dispatch('session:create', { workspaceId: env.ws.id })) as { sessionId: string }
    await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: sess.sessionId, text: 'T1' })
    await waitFor(() => gw.lastMessages() !== null, 'T1 请求体')
    assert.equal(userProfEventsFor(env.pushes, sess.sessionId).length, 1, 'T1 恰一条注入')
    // 关闭开关（条目保留）→ 同会话下一 turn：零新注入，旧文本仍在前缀
    await env.svc.dispatch('user-profile:set', { enabled: false })
    await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: sess.sessionId, text: 'T2' })
    await waitFor(() => {
      const m = gw.lastMessages()
      return m !== null && JSON.stringify(m).includes('T2')
    }, 'T2 请求体')
    assert.equal(userProfEventsFor(env.pushes, sess.sessionId).length, 1, '关闭后零新注入')
    assert.ok(
      (gw.lastMessages() ?? []).some((m) => m.role === 'system' && String(m.content).includes('回答一律用中文')),
      '旧注入仍在前缀（随压缩折叠退场——append-only 红线不回撤）',
    )
  } finally {
    await env.cleanup()
  }
})

test('UP-5 压缩重注：session:compact 后下一 turn 请求体再次含画像', async () => {
  const gw = await startGateway()
  const env = await makeEnv(gw)
  try {
    await env.svc.dispatch('user-profile:set', { enabled: true, entries: [UP_ENTRY] })
    const sess = (await env.svc.dispatch('session:create', { workspaceId: env.ws.id })) as { sessionId: string }
    // 先积满可折叠区间（保护段 = 首个 system + 最近 4 turn——5 turn 后 T1 区间可折叠，含画像注入）
    for (let i = 1; i <= 5; i++) {
      await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: sess.sessionId, text: 'T' + i })
    }
    await waitFor(() => gw.lastMessages() !== null, '请求体捕获')
    // 显式压缩（折叠画像注入——内核下界豁免仅首条 system）
    await env.svc.dispatch('session:compact', { workspaceId: env.ws.id, sessionId: sess.sessionId })
    // 压缩后下一 turn：gateway 单槽被 T6 请求体覆盖——轮询 T6 消息里重新出现画像（重注）
    await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: sess.sessionId, text: 'T6' })
    const deadline = Date.now() + 10_000
    while (
      !(gw.lastMessages()?.some((m) => m.role === 'system' && String(m.content).includes('回答一律用中文'))) &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 25))
    }
    assert.ok(
      gw.lastMessages()?.some((m) => m.role === 'system' && String(m.content).includes('回答一律用中文')),
      '压缩后画像重注进请求体',
    )
  } finally {
    await env.cleanup()
  }
})

test('UP-6 resume 链恢复：新 userData（出厂 store）open 旧会话 → 画像从链恢复不读 store', async () => {
  const gw = await startGateway()
  const env = await makeEnv(gw)
  try {
    await env.svc.dispatch('user-profile:set', { enabled: true, entries: [UP_ENTRY] })
    const sess = (await env.svc.dispatch('session:create', { workspaceId: env.ws.id })) as { sessionId: string }
    await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: sess.sessionId, text: 'T1' })
    await waitFor(() => gw.lastMessages() !== null, 'T1 请求体')
    // 模拟跨运行：新 service + 新 userData（store = 出厂关）open 同一会话——若 resume 读 store 则零注入
    const gw2 = await startGateway()
    const userData2 = mkdtempSync(join(tmpdir(), 'car-up-ud2-'))
    const root2 = env.root
    writeFileSync(join(root2, 'car.config.ts'), `export default { llm: { baseUrl: '${gw2.baseUrl}', model: 'up-model' } }\n`, 'utf8')
    const prevKey = process.env.OPENAI_API_KEY
    const prevAllow = process.env.CAR_ALLOW_ENV_CREDENTIALS
    process.env.OPENAI_API_KEY = 'sk-test-up' // secrets-scan:allow
    process.env.CAR_ALLOW_ENV_CREDENTIALS = '1'
    const svc2 = createHostService({ userDataDir: userData2 })
    const pushes2: PushMessage[] = []
    svc2.onPush((m) => pushes2.push(m))
    try {
      const ws2 = (await svc2.dispatch('workspace:register', { path: root2 })) as WorkspaceInfo
      const opened = (await svc2.dispatch('session:open', { workspaceId: ws2.id, sessionId: sess.sessionId })) as { sessionId: string }
      await svc2.dispatch('turn:send', { workspaceId: ws2.id, sessionId: opened.sessionId, text: 'T2' })
      const deadline = Date.now() + 10_000
      while (!(gw2.lastMessages()?.some((m) => m.role === 'system' && String(m.content).includes('回答一律用中文'))) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25))
      }
      const sysTexts = (gw2.lastMessages() ?? []).filter((m) => m.role === 'system').map((m) => String(m.content))
      assert.ok(sysTexts.some((t) => t.includes('回答一律用中文')), 'resume 快照从链恢复（原条目）')
      assert.ok(!sysTexts.some((t) => t.includes('回复风格：')), '顺带对账：新 userData 无个性化设置——persona 零注入')
      // resume 后首轮不重注（T1 时代注入已在链投影内——append-only 链恒稳定前缀）
      assert.equal(userProfEvents(pushes2).length, 0, 'resume 首轮零重注（链上已有）')
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
