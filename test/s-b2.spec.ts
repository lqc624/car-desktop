/**
 * s-b2 · B-2 批消费面与授权编排（browserGrants consent 持久化 / settlement·browser 行构造 /
 * doctor 近期结算 / 高危确认门与域粒度 grant E2E）
 *
 * 判据（提案 §4.7 consent 五条硬化 + §4.3 第 2 条 + W-2 消费面 D-B2-9）：
 *  - grants 存储：出厂空表（文件缺失非失败）/ 授予持久化 / 损坏抛错（fail-visible 不降级）/
 *    revokeAll / domainOfUrl 域名身份；
 *  - settlementRow：hasUnknownOutcomes warn fail-visible / 其余 dim；browserRow 五型；
 *  - doctor summarizeRecentSettlements：空表绿行缺席事实 / unknown 红行；
 *  - authorize 编排：browser_act 高危子集恒走人审门（「会话内放行」策略不短路——authzId
 *    browser-act-risk 段）；browser_open 域粒度持久化 grant（同域免审、跨域再人审）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBrowserGrantsStore, domainOfUrl } from '../src/host-core/browserGrants.ts'
import { settlementRow, type SettlementLite } from '../src/shared/settlement-rows.ts'
import { browserRow } from '../src/shared/browser-rows.ts'
import { summarizeRecentSettlements } from '../src/host-core/doctor.ts'
import { createHostService, type HostService, type PushMessage } from '../src/host-core/service.ts'
import type { SessionEventDTO, SessionEventPush, WorkspaceInfo } from '../src/shared/ipc-contract.ts'
import type { SessionHandle } from '../src/host-core/session-handle.ts'
import type { HostModelStep } from '../src/host-core/types.ts'

const lite = (over: Partial<SettlementLite> = {}): SettlementLite => ({
  outcome: 'complete',
  requestSent: true,
  declaredToolUseIds: [],
  dispatchedToolUseIds: [],
  tool: { permissionDenialCount: 0, hasUnknownOutcomes: false, stopRequested: false, bounded: false },
  ...over,
})

// ==================== browserGrants consent 存储（§4.7） ====================

test('s-b2: grants 存储——出厂空表（缺失非失败）/ 授予持久化 / 重启存活', () => {
  const dir = mkdtempSync(join(tmpdir(), 's-b2-grants-'))
  try {
    const file = join(dir, 'browser-grants.json')
    const store = createBrowserGrantsStore(file)
    assert.equal(store.has('S-1', 'browser_open@example.com'), false, '出厂空表（文件缺失 = 非失败）')
    assert.equal(existsSync(file), false, '读操作不落盘（派发前重查零副作用）')
    store.grant('S-1', 'browser_open@example.com')
    assert.equal(store.has('S-1', 'browser_open@example.com'), true)
    assert.equal(createBrowserGrantsStore(file).has('S-1', 'browser_open@example.com'), true, '跨宿主重启存活（持久化）')
    assert.equal(store.has('S-2', 'browser_open@example.com'), false, '跨会话不共享（会话×域名分片）')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('s-b2: grants 存储——损坏 fail-visible 抛错（§4.7 第 4 条绝不降级临时授权）+ revokeAll', () => {
  const dir = mkdtempSync(join(tmpdir(), 's-b2-grants2-'))
  try {
    const file = join(dir, 'browser-grants.json')
    const store = createBrowserGrantsStore(file)
    store.grant('S-1', 'browser_open@a.com')
    assert.ok(existsSync(file), 'revoke 前文件在案')
    store.revokeAll()
    assert.equal(existsSync(file), false, 'revokeAll = 清空落盘（撤销立即生效）')
    assert.equal(store.has('S-1', 'browser_open@a.com'), false)
    // 损坏面：写坏文件 → 读抛 CAR-E（fail-visible——authorize 捕获 = deny）
    writeFileSync(file, '{broken', 'utf8')
    assert.throws(() => store.has('S-1', 'k'), /CAR-E-BROWSER-GRANTS/, '损坏读 = 抛错（不降级临时授权）')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('s-b2: domainOfUrl——http/https 取 host / 非 http 与畸形 = null（不授予）', () => {
  assert.equal(domainOfUrl('https://a.example.com/x'), 'a.example.com')
  assert.equal(domainOfUrl('http://localhost:9/x'), 'localhost:9')
  assert.equal(domainOfUrl('ftp://x'), null)
  assert.equal(domainOfUrl('not a url'), null)
})

// ==================== W-2 消费纯函数（settlementRow / browserRow / doctor） ====================

test('s-b2: settlementRow——hasUnknownOutcomes warn fail-visible + 其余 dim + 拒绝计数/护栏事实', () => {
  const warn = settlementRow(lite({
    declaredToolUseIds: ['t1', 't2'],
    dispatchedToolUseIds: ['t1'],
    tool: { permissionDenialCount: 1, hasUnknownOutcomes: true, unknownToolUseIds: ['t2'], stopRequested: false, bounded: false },
  }))
  assert.equal(warn.tone, 'warn')
  assert.match(warn.text, /1 个工具结果不明/)
  assert.match(warn.text, /授权拒 1/)
  const dim = settlementRow(lite({ tool: { permissionDenialCount: 0, hasUnknownOutcomes: false, stopRequested: true, bounded: true } }))
  assert.equal(dim.tone, 'dim')
  assert.match(dim.text, /工具主动收口/)
  assert.match(dim.text, /取消落派发边界/)
})

test('s-b2: browserRow 五型 + 未知 null（App 主面分支——B-1 仅审计可见缺口补齐）', () => {
  assert.match(browserRow('browser/start', { url: 'https://x' })!.text, /浏览器导航/)
  assert.match(browserRow('browser/exit', { reason: 'loaded', durationMs: 42 })!.text, /loaded/)
  assert.equal(browserRow('browser/exit', { reason: 'error', durationMs: 1 })!.tone, 'warn')
  assert.match(browserRow('browser/read', { chars: 100, truncated: false })!.text, /内容不进链/)
  assert.match(browserRow('browser/act', { action: 'click', target: '#b', status: 'done', hitl: true })!.text, /HITL 接管/)
  assert.match(browserRow('browser/hitl', { phase: 'timeout', reason: 'x' })!.text, /timeout/)
  assert.equal(browserRow('browser/hitl', { phase: 'timeout' })!.tone, 'warn')
  assert.equal(browserRow('other/type', {}), null)
})

test('s-b2: doctor summarizeRecentSettlements——空表绿行缺席事实 / unknown 红行 fail-visible', () => {
  const empty = summarizeRecentSettlements([])
  assert.equal(empty.ok, true)
  assert.match(empty.detail, /无 settlement 事件/)
  const bad = summarizeRecentSettlements([
    lite(),
    lite({ outcome: 'interrupted', tool: { permissionDenialCount: 0, hasUnknownOutcomes: true, unknownToolUseIds: ['t9'], stopRequested: false, bounded: false } }),
  ])
  assert.equal(bad.ok, false)
  assert.match(bad.detail, /2 turn/)
  assert.match(bad.detail, /1 非正常收口/)
  assert.match(bad.detail, /1 turn 存在结果不明工具/)
})

// ==================== authorize 编排 E2E（高危门 + 域粒度 grant） ====================

interface Env {
  svc: HostService
  ws: WorkspaceInfo
  sess: { sessionId: string }
  root: string
  userData: string
  pushes: PushMessage[]
}

function emitAssistant(h: SessionHandle, s: HostModelStep): HostModelStep {
  if (typeof s.text === 'string' && s.text.length > 0) {
    h.log.append('model', 'assistant', h.currentTurnId(), s.text)
  }
  return s
}

/** 浏览器启用态 env：settings 预写启用 + dead-target 快速失败（CDP 连接 ~instant ECONNREFUSED） */
async function makeBrowserEnv(
  toolCall: { tool: string; args: Record<string, unknown> } | ((h: SessionHandle, i: number) => { tool: string; args: Record<string, unknown> }),
): Promise<Env> {
  const userData = mkdtempSync(join(tmpdir(), 'car-sb2-ud-'))
  writeFileSync(join(userData, 'browser-settings.json'), JSON.stringify({ version: 1, updatedAt: 0, browserEnabled: true }), 'utf8')
  writeFileSync(join(userData, 'browser-target.json'), JSON.stringify({ targetId: 'DEAD', cdpPort: 9999 }), 'utf8')
  const root = mkdtempSync(join(tmpdir(), 'car-sb2-ws-'))
  writeFileSync(join(root, 'car.config.ts'), "export default { llm: { baseUrl: 'http://127.0.0.1:9', model: 'test-model' } }\n", 'utf8')
  const svc = createHostService({
    userDataDir: userData,
    modelFnOverride: (h: SessionHandle) => {
      let lastTurn = ''
      let turnIndex = 0
      return async () => {
        const t = h.currentTurnId()
        if (t !== lastTurn) {
          lastTurn = t
          const call = typeof toolCall === 'function' ? toolCall(h, turnIndex++) : toolCall
          return { stopReason: 'toolUse', toolCalls: [{ id: 'c-' + t, tool: call.tool, args: call.args }] }
        }
        return emitAssistant(h, { stopReason: 'stop', text: 'done' })
      }
    },
  })
  const pushes: PushMessage[] = []
  svc.onPush((m) => pushes.push(m))
  const ws = (await svc.dispatch('workspace:register', { path: root })) as WorkspaceInfo
  const sess = (await svc.dispatch('session:create', { workspaceId: ws.id })) as { sessionId: string }
  return { svc, ws, sess, root, userData, pushes }
}

const eventsOf = (env: Env): SessionEventDTO[] =>
  env.pushes.filter((m) => m.topic === 'push:session-event').map((m) => (m.payload as SessionEventPush).event)

async function waitForTurnEnd(env: Env, turnId: string, timeoutMs = 15000): Promise<SessionEventDTO> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const e = eventsOf(env).find((x) => x.kind === 'turnEnd' && x.turnId === turnId)
    if (e) return e
    if (Date.now() > deadline) throw new Error(`waitForTurnEnd 超时（${turnId}）`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

async function sendTurn(env: Env, text: string): Promise<string> {
  const r = (await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, text })) as { turnId: string }
  return r.turnId
}

async function waitForPending(env: Env, timeoutMs = 5000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const ps = env.pushes.filter((m) => m.topic === 'push:authz-pending')
    if (ps.length) return ps.at(-1)!.payload as Record<string, unknown>
    if (Date.now() > deadline) throw new Error('pending 未推送')
    await new Promise((r) => setTimeout(r, 10))
  }
}

async function respond(env: Env, decision: 'once' | 'session' | 'deny'): Promise<void> {
  await env.svc.dispatch('authz:respond', {
    workspaceId: env.ws.id,
    sessionId: env.sess.sessionId,
    requestId: (await waitForPending(env))['requestId'],
    decision,
  })
}

test('s-b2 E2E: browser_act 高危子集恒走人审门——「会话内放行」策略不短路（§4.3 第 2 条）', async () => {
  const env = await makeBrowserEnv({ tool: 'browser_act', args: { action: 'click', text: '提交订单' } })
  try {
    // 策略切「会话内放行」（完全放行档）——高危仍须人审
    await env.svc.dispatch('session:set-policy', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, policy: 'session' })
    const t1 = await sendTurn(env, '下单')
    const pending = await waitForPending(env)
    assert.match(String(pending['requestId']), /:browser-act-risk:/, '高危门 authzId 形态')
    assert.match(String(pending['resource']), /高危动作/, '高危动作资源描述')
    assert.match(String(pending['resource']), /提交订单/, '目标描述随卡')
    await respond(env, 'deny')
    await waitForTurnEnd(env, t1)
  } finally {
    rmSync(env.userData, { recursive: true, force: true })
    rmSync(env.root, { recursive: true, force: true })
  }
})

test('s-b2 E2E: browser_open 域粒度持久化 grant——同域免审（不弹卡）/ 跨域再人审（§4.7）', async () => {
  let i = 0
  const env = await makeBrowserEnv((h, idx) => {
    i = idx
    return idx === 0
      ? { tool: 'browser_open', args: { url: 'https://grant-domain.example/a' } }
      : idx === 1
        ? { tool: 'browser_open', args: { url: 'https://grant-domain.example/b' } }
        : { tool: 'browser_open', args: { url: 'https://other-domain.example/' } }
  })
  try {
    // turn1：首次该域 → 人审 → session 三档 = 域名粒度持久化授予
    const t1 = await sendTurn(env, '打开站点')
    const p1 = await waitForPending(env)
    assert.match(String(p1['requestId']), /:browser_open:/, '首次该域走人审门')
    assert.match(String(p1['resource']), /grant-domain\.example\/a/, '资源描述随卡（describeResource JSON 形态）')
    await respond(env, 'session')
    await waitForTurnEnd(env, t1)
    const grantsFile = join(env.userData, 'browser-grants.json')
    assert.ok(existsSync(grantsFile), '域 grant 已落盘（§4.7 持久化）')
    assert.match(readFileSync(grantsFile, 'utf8'), /browser_open@grant-domain\.example/)
    // turn2：同域（不同路径）→ 持久化 grant 命中 = 不弹卡
    env.pushes.length = 0
    const t2 = await sendTurn(env, '再开一页')
    await waitForTurnEnd(env, t2)
    assert.equal(env.pushes.filter((m) => m.topic === 'push:authz-pending').length, 0, '同域免审（派发前现读盘）')
    // turn3：跨域 → 再人审（域名粒度——B-1 工具粒度 grant 的 §4.7 硬化修正）
    const t3 = await sendTurn(env, '开别的站')
    await waitForPending(env)
    await respond(env, 'deny')
    await waitForTurnEnd(env, t3)
    assert.ok(i >= 2, '三 turn 序号推进')
  } finally {
    rmSync(env.userData, { recursive: true, force: true })
    rmSync(env.root, { recursive: true, force: true })
  }
})
