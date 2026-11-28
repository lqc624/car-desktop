/**
 * v0.19 C1 · RW-2 知识回流引用开关 E2E + 纯函数面（personalization / bash-tasks 同款 harness）
 *
 * 判据：
 *  - 纯函数：总览/页面装配确定性（截断标记 + 头窗；chainNeedsConstantInjection 对账键 = 渲染文本）；
 *  - store（per-workspace）：出厂关 / set 持久化 / corrupt 回退出厂（不 fail-open 到开启态）；
 *  - E2E：缺省关 = 零注入零落链；开启 = 注入行 meta 全 provenance（wsId/pageId/pageSha256/truncated，
 *    sha256 = 注入文本回执自含）+ 三判据实时跟随（首轮 / 文本变重注；压缩后重注沿 WB-2L 同机制先例）；
 *    关 = 下一 turn 零新增行（旧行 append-only 留痕）；
 *  - @页面引用：add/remove 补偿落链 + inject 行（显式引用——零自动召回）+ 页缺失 fail-visible +
 *    预算超限 CAR-E-MEM-BUDGET fail-visible；
 *  - 请求体投影（假网关）：开启后 system 投影含总览文本。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { test } from 'node:test'
import { createHostService, type HostService, type PushMessage } from '../src/host-core/service.ts'
import { createRepoWikiSettingsStore } from '../src/host-core/repoWikiSettingsStore.ts'
import { buildOverviewInjectionText, assembleWikiPageRefText } from '../src/shared/repoWikiBackflow.ts'
import type { WorkspaceInfo } from '../src/shared/ipc-contract.ts'
import type { SessionHandle } from '../src/host-core/session-handle.ts'
import type { SessionEventDTO, SessionEventPush } from '../src/shared/ipc-contract.ts'

function tmpDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `car-rw2-${label}-`))
}

const OVERVIEW_MD = '# 项目总览\n\nCAR 桌面端：内核编排 + 宿主装配 + 渲染层三层。\n'

/** wiki 夹具落盘：manifest（pages 标题面）+ pages/00.md + pages/01.md */
function seedWiki(userData: string, wsId: string): void {
  const dir = join(userData, 'repo-wiki', wsId)
  mkdirSync(join(dir, 'pages'), { recursive: true })
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
    workspaceId: wsId,
    generatedAt: Date.now(),
    model: 'test-model',
    durationMs: 1,
    pages: [
      { id: '00', title: '项目总览', chars: OVERVIEW_MD.length },
      { id: '01', title: '架构说明', chars: 456 },
    ],
  }), 'utf8')
  writeFileSync(join(dir, 'pages', '00.md'), OVERVIEW_MD, 'utf8')
  writeFileSync(join(dir, 'pages', '01.md'), '# 架构说明\n\n宿主装配层 = service.ts（会话/工具/安全面组装）。\n', 'utf8')
}

interface Env {
  svc: HostService
  ws: WorkspaceInfo
  sess: { sessionId: string }
  root: string
  userData: string
  pushes: PushMessage[]
}

function scriptedParentModel(
  steps: Array<{ text?: string; tool?: string; args?: Record<string, unknown>; calls?: Array<{ tool: string; id: string; args: Record<string, unknown> }> }>,
) {
  return (h: SessionHandle) => {
    let i = 0
    return async () => {
      const s = steps[i++] ?? { text: '（脚本尽——自然收口）' }
      if (s.calls?.length) {
        return { stopReason: 'toolUse' as const, toolCalls: s.calls.map((c, j) => ({ id: c.id ?? 'call-' + j, tool: c.tool, args: c.args })) }
      }
      if (s.tool) {
        return { stopReason: 'toolUse' as const, toolCalls: [{ id: s.id ?? 'call-' + i, tool: s.tool, args: s.args ?? {} }] }
      }
      const text = s.text ?? ''
      if (text.length > 0) h.log.append('model', 'assistant', h.currentTurnId(), text)
      return { stopReason: 'stop' as const, text }
    }
  }
}

async function makeEnv(steps: Parameters<typeof scriptedParentModel>[0], seed = true): Promise<Env> {
  const userData = tmpDir('ud')
  const root = tmpDir('ws')
  writeFileSync(join(root, 'car.config.ts'), "export default { llm: { baseUrl: 'http://127.0.0.1:9', model: 'test-model' } }\n", 'utf8')
  const svc = createHostService({ userDataDir: userData, modelFnOverride: scriptedParentModel(steps) })
  const pushes: PushMessage[] = []
  svc.onPush((m) => pushes.push(m))
  const ws = (await svc.dispatch('workspace:register', { path: root })) as WorkspaceInfo
  if (seed) seedWiki(userData, ws.id)
  const sess = (await svc.dispatch('session:create', { workspaceId: ws.id })) as { sessionId: string }
  return { svc, ws, sess, root, userData, pushes }
}

function eventsOf(env: Env): SessionEventDTO[] {
  return env.pushes.filter((m) => m.topic === 'push:session-event').map((m) => (m.payload as SessionEventPush).event)
}

function injectionRows(env: Env, key: string): Array<{ payload: string; meta: Record<string, unknown> }> {
  return eventsOf(env)
    .filter((e) => e.kind === 'system' && (e.meta as Record<string, unknown> | null)?.['injection'] === key)
    .map((e) => ({ payload: String(e.payload ?? ''), meta: (e.meta ?? {}) as Record<string, unknown> }))
}

async function sendTurn(env: Env, text: string): Promise<string> {
  return ((await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, text })) as { turnId: string }).turnId
}

async function waitForTurnEnd(env: Env, timeoutMs = 8000): Promise<SessionEventDTO> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const e = eventsOf(env).find((x) => x.kind === 'turnEnd' && x.turnId !== '' && !x.turnId.startsWith('authz:'))
    if (e) return e
    if (Date.now() > deadline) throw new Error('等待超时：turnEnd')
    await new Promise((r) => setTimeout(r, 25))
  }
}

// ── 纯函数面 ──

test('R2-1 纯函数：总览/页面装配确定性（预算头截断 + 标记）', () => {
  const a = buildOverviewInjectionText(OVERVIEW_MD)
  assert.equal(a.truncated, false)
  assert.ok(a.text.startsWith('## RepoWiki · 00 项目总览'), '装配头在位')
  assert.ok(a.text.includes('CAR 桌面端'), '正文随装')
  // 截断：超预算 = 头窗 + 标记（确定性——chainNeedsConstantInjection 对账键）
  const big = 'x'.repeat(5000)
  const b = buildOverviewInjectionText(big)
  assert.equal(b.truncated, true)
  assert.ok(b.text.endsWith('……〔截断〕'))
  assert.ok(b.text.length < 5000, '头窗 ≤ 预算 + 标记')
  assert.equal(buildOverviewInjectionText(big).text, b.text, '重复装配字节恒等（对账键稳定）')
  // 页面引用装配：标题行 + 单页上限
  const p = assembleWikiPageRefText({ pageId: '01', title: '架构说明', md: '宿主装配层。' })
  assert.ok(p.text.startsWith('## 架构说明（RepoWiki 页面 01）'))
  assert.equal(p.truncated, false)
  const pBig = assembleWikiPageRefText({ pageId: '01', title: '架构说明', md: 'y'.repeat(13000) })
  assert.equal(pBig.truncated, true)
  assert.ok(pBig.text.endsWith('……〔截断〕'))
})

// ── store ──

test('R2-2 store（per-workspace）：出厂关 / set 持久化 / corrupt 回退出厂不 fail-open', () => {
  const dir = tmpDir('store')
  const st = createRepoWikiSettingsStore(dir)
  assert.equal(st.get().backflowEnabled, false, '出厂 = 关（deny-by-default）')
  st.set({ backflowEnabled: true })
  assert.equal(st.get().backflowEnabled, true)
  const st2 = createRepoWikiSettingsStore(dir)
  assert.equal(st2.get().backflowEnabled, true, '持久化 roundtrip')
  st2.set({ backflowEnabled: false })
  assert.equal(st2.get().backflowEnabled, false)
  writeFileSync(join(dir, 'settings.json'), '{ broken', 'utf8')
  const st3 = createRepoWikiSettingsStore(dir)
  assert.equal(st3.get().backflowEnabled, false, '损坏 = 回退出厂关态（禁 fail-open 到开启态）')
  assert.ok(readFileSync(join(dir, 'settings.json'), 'utf8').includes('"backflowEnabled": false'), '回退态写回')
})

// ── E2E：总览注入 ──

test('R2-3 缺省关 = 零注入零落链（wiki 在位也不注）', async () => {
  const env = await makeEnv([{ text: '收口' }])
  try {
    await sendTurn(env, '你好')
    await waitForTurnEnd(env)
    assert.equal(injectionRows(env, 'repo-wiki').length, 0, '开关关 = 零 repo-wiki 注入行')
  } finally {
    env.svc.closeAll?.()
  }
})

test('R2-4 开启 → 注入行 provenance 全量 + 三判据（首轮 / 文本不变零新行 / 页变重注）', async () => {
  const env = await makeEnv([{ text: '一' }, { text: '二' }, { text: '三' }])
  try {
    await env.svc.dispatch('repoWikiSettings:set', { workspaceId: env.ws.id, backflowEnabled: true })
    await sendTurn(env, '第一轮')
    await waitForTurnEnd(env)
    const rows1 = injectionRows(env, 'repo-wiki')
    assert.equal(rows1.length, 1, '首轮注入')
    const m1 = rows1[0]!.meta
    assert.equal(m1['wsId'], env.ws.id)
    assert.equal(m1['pageId'], '00')
    assert.equal(m1['pageSha256'], createHash('sha256').update(rows1[0]!.payload, 'utf8').digest('hex'), 'sha256 = 注入文本回执自含')
    assert.equal(m1['truncated'], false)
    assert.ok(String(rows1[0]!.payload).includes('CAR 桌面端'), '总览正文随注入')
    // 第二轮：页文本不变 = 零新行
    await sendTurn(env, '第二轮')
    await waitForTurnEnd(env)
    assert.equal(injectionRows(env, 'repo-wiki').length, 1, '文本不变 = 零重注')
    // 页文本变（重新生成语义）→ 下一 turn 重注入（三判据③）
    seedWiki(env.userData, env.ws.id)
    writeFileSync(join(env.userData, 'repo-wiki', env.ws.id, 'pages', '00.md'), OVERVIEW_MD + '\n## 新增章节\n\nv0.19 更新。\n', 'utf8')
    await sendTurn(env, '第三轮')
    await waitForTurnEnd(env)
    const rows = injectionRows(env, 'repo-wiki')
    assert.equal(rows.length, 2, '页文本变 = 重注入（append-only——旧行保留）')
    assert.notEqual(rows[1]!.meta['pageSha256'], rows[0]!.meta['pageSha256'], '新行 sha256 = 新文本')
  } finally {
    env.svc.closeAll?.()
  }
})

test('R2-5 关闭 → 下一 turn 零新增注入行（旧行 append-only 留痕）', async () => {
  const env = await makeEnv([{ text: '一' }, { text: '二' }])
  try {
    await env.svc.dispatch('repoWikiSettings:set', { workspaceId: env.ws.id, backflowEnabled: true })
    await sendTurn(env, '开')
    await waitForTurnEnd(env)
    await env.svc.dispatch('repoWikiSettings:set', { workspaceId: env.ws.id, backflowEnabled: false })
    await sendTurn(env, '关')
    await waitForTurnEnd(env)
    assert.equal(injectionRows(env, 'repo-wiki').length, 1, '关后零新增（已注入行留痕，压缩折叠后自然出上下文）')
  } finally {
    env.svc.closeAll?.()
  }
})

// ── E2E：@页面引用 ──

test('R2-6 @页面引用：add/remove 补偿落链 + inject 行 + 页缺失 fail-visible', async () => {
  const env = await makeEnv([{ text: '一' }, { text: '二' }, { text: '三' }])
  try {
    // 页缺失 fail-visible（wiki 已 seed，99 页不存在）
    await assert.rejects(
      () => env.svc.dispatch('wikiPageRef:add', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, pageId: '99' }),
      (e: Error) => /页面不存在/.test(e.message),
    )
    await env.svc.dispatch('wikiPageRef:add', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, pageId: '01' })
    await env.svc.dispatch('wikiPageRef:add', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, pageId: '01' }) // 幂等
    await sendTurn(env, '引用架构页')
    await waitForTurnEnd(env)
    const adds = injectionRows(env, 'wiki-page').filter((r) => r.meta['op'] === 'add')
    assert.equal(adds.length, 1, '重复引用幂等（单 add 行）')
    const injects = injectionRows(env, 'wiki-page').filter((r) => r.meta['op'] === 'inject')
    assert.equal(injects.length, 1, 'inject 行落链')
    assert.deepEqual(injects[0]!.meta['refs'], ['wiki:01'])
    assert.ok(String(injects[0]!.payload).includes('架构说明'), '页面标题随装配')
    assert.ok(String(injects[0]!.payload).includes('宿主装配层'), '页面正文随注入')
    // 撤销 = remove 补偿 → 下一 turn 注入集不含该页（零新 inject 行）
    await env.svc.dispatch('wikiPageRef:remove', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, pageId: '01' })
    await sendTurn(env, '撤销引用')
    await waitForTurnEnd(env)
    const injects2 = injectionRows(env, 'wiki-page').filter((r) => r.meta['op'] === 'inject')
    assert.equal(injects2.length, 1, '撤销后零新 inject 行（append-only——旧行保留）')
  } finally {
    env.svc.closeAll?.()
  }
})

test('R2-7 预算 fail-visible：页面引用超合并预算 = turn 拒发（禁静默截断）', async () => {
  const env = await makeEnv([{ text: '一' }])
  try {
    // 造超预算页（> 8000 缺省合并预算）
    const dir = join(env.userData, 'repo-wiki', env.ws.id)
    writeFileSync(join(dir, 'pages', '01.md'), '# 架构说明\n\n' + 'z'.repeat(9000), 'utf8')
    await env.svc.dispatch('wikiPageRef:add', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, pageId: '01' })
    await assert.rejects(
      () => sendTurn(env, '引用超预算页'),
      (e: Error) => /CAR-E-MEM-BUDGET/.test(e.message),
      '超合并预算 fail-visible（throw 于 turn 开启前——busy 未置）',
    )
    // 撤销后恢复正常发轮（fail-fast 不留死锁——S6M-4 同防线）
    await env.svc.dispatch('wikiPageRef:remove', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, pageId: '01' })
    await sendTurn(env, '恢复')
    await waitForTurnEnd(env)
  } finally {
    env.svc.closeAll?.()
  }
})

// ── 请求体投影（假网关——P-2 口径） ──

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

test('R2-8 请求体投影：开启后 system 投影含总览文本（关 = 零投影）', async () => {
  const gw = await startGateway()
  const userData = tmpDir('ud')
  const root = tmpDir('ws')
  writeFileSync(join(root, 'car.config.ts'), `export default { llm: { baseUrl: '${gw.baseUrl}', model: 'rw2-model' } }\n`, 'utf8')
  const prevKey = process.env.OPENAI_API_KEY
  const prevAllow = process.env.CAR_ALLOW_ENV_CREDENTIALS
  process.env.OPENAI_API_KEY = 'sk-test-rw2' // secrets-scan:allow（测试 fixture 假靶料，非真实凭据）
  process.env.CAR_ALLOW_ENV_CREDENTIALS = '1'
  const svc = createHostService({ userDataDir: userData })
  const pushes: PushMessage[] = []
  svc.onPush((m) => pushes.push(m))
  // 按 user 消息轮转等待（lastMessages = 最近一次请求——须锁定目标轮的请求体）
  const waitForBody = async (marker: string, what: string): Promise<void> => {
    const deadline = Date.now() + 10000
    for (;;) {
      const msgs = gw.lastMessages() ?? []
      if (msgs.some((m) => m.role === 'user' && String(m.content ?? '').includes(marker))) return
      if (Date.now() > deadline) throw new Error(`等待超时：${what}`)
      await new Promise((r) => setTimeout(r, 25))
    }
  }
  try {
    const ws = (await svc.dispatch('workspace:register', { path: root })) as WorkspaceInfo
    seedWiki(userData, ws.id)
    const sess = (await svc.dispatch('session:create', { workspaceId: ws.id })) as { sessionId: string }
    // 关态投影：system 无总览
    await svc.dispatch('turn:send', { workspaceId: ws.id, sessionId: sess.sessionId, text: '关态轮' })
    await waitForBody('关态轮', '关态请求体')
    const sysOff = (gw.lastMessages() ?? []).filter((m) => m.role === 'system')
    assert.ok(!sysOff.some((m) => String(m.content ?? '').includes('RepoWiki · 00 项目总览')), '关态零投影')
    // 开态投影：system 含总览头 + 正文
    await svc.dispatch('repoWikiSettings:set', { workspaceId: ws.id, backflowEnabled: true })
    await svc.dispatch('turn:send', { workspaceId: ws.id, sessionId: sess.sessionId, text: '开态轮' })
    await waitForBody('开态轮', '开态请求体')
    const sysOn = (gw.lastMessages() ?? []).filter((m) => m.role === 'system')
    assert.ok(sysOn.some((m) => String(m.content ?? '').includes('RepoWiki · 00 项目总览')), '开态 system 投影含总览头')
    assert.ok(sysOn.some((m) => String(m.content ?? '').includes('CAR 桌面端')), '总览正文进请求体（deriveMessages 投影）')
  } finally {
    process.env.OPENAI_API_KEY = prevKey
    process.env.CAR_ALLOW_ENV_CREDENTIALS = prevAllow
    await new Promise<void>((r) => gw.server.close(() => r()))
    svc.closeAll?.()
    svc.dispose?.()
  }
})
