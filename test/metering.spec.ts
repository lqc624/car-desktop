/**
 * S3-S5 计量聚合行为测试（计量设计 §4.6；VD4；S3 规划 WBS S3-S5 判据）
 *
 * 判据：聚合口径与 ctx-pop 同源（usage 事实四分量、authz:* 不计）；无价目金额 = null
 * **禁 0 禁估算**；部分缺价目禁混算；覆盖率/缺失显性化；turn 明细关联能力列不跨能力求和；
 * E2E metrics:summary（usage 事实由假模型复刻 chatStep 落链——流尾 usage chunk 口径）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createHostService, type HostService, type PushMessage } from '../src/host-core/service.ts'
import { factsFromEvents, summarizeFacts, tablePriceProvider, nullPriceProvider, type UsageFact } from '../src/host-core/metering.ts'
import type { SessionEventDTO, WorkspaceInfo } from '../src/shared/ipc-contract.ts'
import type { SessionHandle } from '../src/host-core/session-handle.ts'
import type { HostModelStep } from '../src/host-core/types.ts'

function tmpDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `car-mt-${label}-`))
}

// ==================== 纯函数单测 ====================

function ev(kind: string, turnId: string, ts: number, payload: unknown, meta?: Record<string, unknown>): { kind: string; turnId: string; ts: number; payload: unknown; meta?: Record<string, unknown> } {
  return meta === undefined ? { kind, turnId, ts, payload } : { kind, turnId, ts, payload, meta }
}
const usage = (turnId: string, ts: number, model: string, input: number, output: number, cacheRead = 0): { kind: string; turnId: string; ts: number; payload: unknown } =>
  ev('usage', turnId, ts, { model, adapterId: 'openai-compat', input, output, cacheRead, cacheCreation: 0, providerRaw: {} })

test('factsFromEvents：usage 事实抽取 + authz:* 审计事件不计 + turn 工具关联', () => {
  const events = [
    ev('system', 'session', 1, { type: 'session-start' }),
    ev('toolCall', 'T1', 2, { id: 'c1', tool: 'fs_write', args: {} }),
    usage('T1', 3, 'deepseek-chat', 100, 40, 60),
    ev('turnEnd', 'T1', 4, null),
    ev('toolCall', 'T2', 5, { id: 'c2', tool: 'fs_read', args: {} }),
    ev('toolCall', 'T2', 6, { id: 'c3', tool: 'fs_read', args: {} }),
    usage('T2', 7, 'deepseek-reasoner', 80, 20),
    ev('turnEnd', 'T2', 8, null),
    usage('authz:S:rule:fs_read:c9', 9, 'deepseek-chat', 999, 999), // 审计事件形态混淆面——不得计入
    ev('turnEnd', 'authz:S:policy:fs_write:c8', 10, { decision: 'APPROVED' }),
    ev('turnEnd', 'T3', 11, null), // 无 usage turn（缺失显性化）
  ]
  const r = factsFromEvents(events, 'S1')
  assert.equal(r.facts.length, 2, 'authz:* usage 不计入')
  assert.equal(r.turnEndCount, 3, 'authz:* turnEnd 不计入；T3 计入分母')
  assert.equal(r.usageMissingTurns, 0, '旧格式链（无 usageMissing 尾键）零计数——1.18.1 及以前会话兼容')
  assert.deepEqual(r.toolsByTurn.get('T1'), ['fs_write'])
  assert.deepEqual(r.toolsByTurn.get('T2'), ['fs_read', 'fs_read'].filter((v, i, a) => a.indexOf(v) === i), '同 turn 重复工具去重')
})

test('factsFromEvents + summarizeFacts：turnEnd.usageMissing 尾键细分（1.18.2 R-K7-2）——网关未回执计数', () => {
  const events = [
    ev('usage', 'T1', 1, { model: 'm', adapterId: 'anthropic', input: 100, output: 5, cacheRead: 0, cacheCreation: 0, providerRaw: {} }),
    ev('turnEnd', 'T1', 2, null),
    // 网关未回执形态：有模型输出但 usage 整条缺席 → 内核 1.18.2 落 usageMissing 尾键
    ev('assistant', 'T2', 3, 'ok'),
    ev('turnEnd', 'T2', 4, null, { reason: 'completed', usageMissing: true }),
    // 无模型请求的 turn（如授权收口）：无尾键 → 不计网关缺失
    ev('turnEnd', 'T3', 5, null, { reason: 'blocked' }),
  ]
  const r = factsFromEvents(events, 'S1')
  assert.equal(r.turnEndCount, 3)
  assert.equal(r.usageMissingTurns, 1, '仅 usageMissing 尾键的 turn 计数（T2）')
  const s = summarizeFacts(r.facts, r.toolsByTurn, r.turnEndCount, nullPriceProvider(), 0, r.usageMissingTurns)
  assert.equal(s.cards.turnsWithoutUsage, 2, 'T2+T3 均无 usage（缺失分母）')
  assert.equal(s.cards.usageMissingTurns, 1, '网关未回执 1 / 无模型请求 1 细分在卡面')
})

test('summarizeFacts：按模型聚合现算金额 + 今日卡 + 命中率 + 覆盖率（表价目注入）', () => {
  const now = new Date(2026, 9, 11, 15, 0, 0).getTime() // 本地 2026-10-11 15:00
  const todayTs = new Date(2026, 9, 11, 10, 0, 0).getTime()
  const yesterdayTs = new Date(2026, 9, 10, 10, 0, 0).getTime()
  const facts: UsageFact[] = [
    { sessionId: 'S1', ts: todayTs, turnId: 'T1', model: 'deepseek-chat', adapterId: null, input: 1_000_000, output: 100_000, cacheRead: 500_000, cacheCreation: 0 },
    { sessionId: 'S1', ts: yesterdayTs, turnId: 'T2', model: 'deepseek-reasoner', adapterId: null, input: 2_000_000, output: 200_000, cacheRead: 0, cacheCreation: 0 },
  ]
  const provider = tablePriceProvider({
    'deepseek-chat': { input: 0.27, output: 1.1, cacheRead: 0.027 },
    'deepseek-reasoner': { input: 0.55, output: 2.2, cacheRead: 0.055 },
  })
  const s = summarizeFacts(facts, new Map([['T1', ['fs_write']]]), 2, provider, now)
  assert.equal(s.priceSynced, true)
  // 按模型：金额 = (in*in + out*out + cacheRead*cacheRead)/1e6
  const chat = s.byModel.find((m) => m.model === 'deepseek-chat')!
  assert.equal(chat.requests, 1)
  assert.ok(Math.abs(chat.cost! - (1_000_000 * 0.27 + 100_000 * 1.1 + 500_000 * 0.027) / 1e6) < 1e-9)
  const reasoner = s.byModel.find((m) => m.model === 'deepseek-reasoner')!
  assert.ok(Math.abs(reasoner.cost! - (2_000_000 * 0.55 + 200_000 * 2.2) / 1e6) < 1e-9)
  // 今日卡：只含今日事实
  assert.equal(s.cards.today.input, 1_000_000)
  assert.ok(s.cards.today.cost! > 0)
  // 命中率 = cacheRead / (input + cacheRead)（§1.1 归一口径：input 已扣缓存读）
  assert.ok(Math.abs(s.cards.cacheHitRate! - 500_000 / 3_500_000) < 1e-9)
  // 覆盖率：2 turnEnd 全有 usage
  assert.equal(s.cards.usageCoverage, 1)
  assert.equal(s.cards.turnsWithoutUsage, 0)
  // 7 日柱：窗口含今日与昨日；零事实日 cost = null（无事实≠伪造 0 金额）
  assert.equal(s.dailyBars.length, 7)
  const todayBar = s.dailyBars[6]
  assert.equal(todayBar.day, '2026-10-11')
  assert.equal(todayBar.input, 1_000_000)
  const yesterdayBar = s.dailyBars[5]
  assert.equal(yesterdayBar.day, '2026-10-10')
  assert.equal(yesterdayBar.input, 2_000_000)
  assert.equal(s.dailyBars[0].cost, null, '零事实日金额 null')
  // turn 明细：关联能力列
  const turn1 = s.turns.find((t) => t.turnId === 'T1')!
  assert.deepEqual(turn1.tools, ['fs_write'])
})

test('summarizeFacts：无价目（R-D5 本地模式）——金额全部 null 禁 0 + priceSynced=false', () => {
  const now = Date.now()
  const facts: UsageFact[] = [
    { sessionId: 'S1', ts: now, turnId: 'T1', model: 'deepseek-chat', adapterId: null, input: 1000, output: 100, cacheRead: 0, cacheCreation: 0 },
  ]
  const s = summarizeFacts(facts, new Map(), 1, nullPriceProvider(), now)
  assert.equal(s.priceSynced, false)
  assert.equal(s.byModel[0].cost, null, '金额 null（禁 0 伪造）')
  assert.equal(s.cards.today.cost, null)
  assert.equal(s.turns[0].cost, null)
  assert.ok(s.byModel[0].input === 1000, 'token 事实照常聚合（tokens 是唯一事实）')
})

test('summarizeFacts：部分缺价目禁混算——缺价目模型 cost=null + 今日卡 null + priceSynced=false', () => {
  const now = Date.now()
  const facts: UsageFact[] = [
    { sessionId: 'S1', ts: now, turnId: 'T1', model: 'priced', adapterId: null, input: 1_000_000, output: 0, cacheRead: 0, cacheCreation: 0 },
    { sessionId: 'S1', ts: now, turnId: 'T2', model: 'mystery', adapterId: null, input: 1_000_000, output: 0, cacheRead: 0, cacheCreation: 0 },
  ]
  const s = summarizeFacts(facts, new Map(), 2, tablePriceProvider({ priced: { input: 1, output: 1, cacheRead: 0 } }), now)
  assert.equal(s.priceSynced, false, '有缺价目事实 = 未全量同步')
  assert.ok(s.byModel.find((m) => m.model === 'priced')!.cost! > 0)
  assert.equal(s.byModel.find((m) => m.model === 'mystery')!.cost, null)
  assert.equal(s.cards.today.cost, null, '今日含未价目事实 → 今日金额 null（禁部分现算混算）')
})

test('summarizeFacts：覆盖率缺失显性化 + 同 turn 多请求聚合 + model 缺失面（未采集模型）', () => {
  const now = Date.now()
  const facts: UsageFact[] = [
    { sessionId: 'S1', ts: now, turnId: 'T1', model: 'm1', adapterId: null, input: 100, output: 10, cacheRead: 0, cacheCreation: 0 },
    { sessionId: 'S1', ts: now + 1, turnId: 'T1', model: 'm1', adapterId: null, input: 200, output: 20, cacheRead: 0, cacheCreation: 0 }, // 同 turn 第二请求
    { sessionId: 'S1', ts: now + 2, turnId: 'T2', model: null, adapterId: null, input: 50, output: 5, cacheRead: 0, cacheCreation: 0 }, // provider 未回 model
  ]
  const s = summarizeFacts(facts, new Map(), 4, tablePriceProvider({ m1: { input: 1, output: 1, cacheRead: 0 } }), now)
  assert.equal(s.cards.usageCoverage, 2 / 4, '4 turn 中 2 turn 有 usage——缺失显性化')
  assert.equal(s.cards.turnsWithoutUsage, 2)
  const t1 = s.turns.find((t) => t.turnId === 'T1')!
  assert.equal(t1.requests, 2, '同 turn 多请求聚合')
  assert.equal(t1.input, 300)
  const t2 = s.turns.find((t) => t.turnId === 'T2')!
  assert.equal(t2.model, null)
  assert.equal(t2.cost, null, 'model 缺失 = 未采集模型 → 金额 null（禁按 0 价现算）')
  assert.ok(s.byModel.find((m) => m.model === '（未采集模型）'), '未采集模型独立呈现（不混入有价模型）')
})

// ==================== E2E（metrics:summary；usage 事实由假模型复刻 chatStep 流尾落链） ====================

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
  pushes: PushMessage[]
}

async function makeEnv(script: (h: SessionHandle) => HostModelFn, priceProvider?: Parameters<typeof createHostService>[0]['priceProvider']): Promise<Env> {
  const userData = tmpDir('ud')
  const root = tmpDir('ws')
  writeFileSync(join(root, 'car.config.ts'), "export default { llm: { baseUrl: 'http://127.0.0.1:9', model: 'test-model' } }\n", 'utf8')
  const svc = createHostService({ userDataDir: userData, modelFnOverride: script, ...(priceProvider ? { priceProvider } : {}) })
  const pushes: PushMessage[] = []
  svc.onPush((m) => pushes.push(m))
  const ws = (await svc.dispatch('workspace:register', { path: root })) as WorkspaceInfo
  const sess = (await svc.dispatch('session:create', { workspaceId: ws.id })) as { sessionId: string }
  return { svc, ws, sess, root, pushes }
}

function eventsOf(env: Env): SessionEventDTO[] {
  return env.pushes.filter((m) => m.topic === 'push:session-event').map((m) => (m.payload as SessionEventPush).event)
}
async function waitForTurnEnd(env: Env, turnId: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (eventsOf(env).some((x) => x.kind === 'turnEnd' && x.turnId === turnId)) return
    if (Date.now() > deadline) throw new Error(`waitForTurnEnd 超时（${turnId}）`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

test('E2E·metrics:summary：usage 事实落链（假模型复刻 chatStep 流尾口径）→ 工作区聚合 + 关联能力列', async () => {
  const env = await makeEnv((h) => {
    let lastTurn = ''
    return async () => {
      const t = h.currentTurnId()
      if (t !== lastTurn) {
        lastTurn = t
        return { stopReason: 'toolUse', toolCalls: [{ id: 'c-' + t, tool: 'fs_write', args: { path: 'out/m.txt', content: 'x' } }] }
      }
      // 流尾 usage 事实落链（chatStep.ts:113 口径复刻——provider 回了才有，禁补造）
      h.log.append('runtime', 'usage', t, {
        model: 'test-model',
        adapterId: 'openai-compat',
        input: 1200,
        output: 300,
        cacheRead: 800,
        cacheCreation: 0,
        providerRaw: { source: 'fake' },
      })
      return emitAssistant(h, { stopReason: 'stop', text: 'done' })
    }
  })
  const sent = (await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, text: '写' })) as { turnId: string }
  const p = (await (async () => { const dl = Date.now() + 3000; for (;;) { const ps = env.pushes.filter((m) => m.topic === 'push:authz-pending'); if (ps.length) return ps.at(-1)!.payload as Record<string, unknown>; if (Date.now() > dl) throw new Error('pending 未推送'); await new Promise((r) => setTimeout(r, 10)) } })())
  await env.svc.dispatch('authz:respond', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, requestId: p['requestId'], decision: 'once' })
  await waitForTurnEnd(env, sent.turnId)
  const summary = (await env.svc.dispatch('metrics:summary', { workspaceId: env.ws.id })) as {
    priceSynced: boolean
    cards: { today: { input: number; output: number; cacheRead: number; cost: number | null }; cacheHitRate: number | null; usageCoverage: number | null }
    byModel: Array<{ model: string; requests: number; cost: number | null }>
    turns: Array<{ turnId: string; tools: string[]; input: number; requests: number; cost: number | null }>
    warnings: string[]
  }
  assert.equal(summary.priceSynced, false, '本地模式 null Provider——价目未同步')
  assert.equal(summary.cards.today.input, 1200)
  assert.equal(summary.cards.today.output, 300)
  assert.equal(summary.cards.today.cost, null, '金额 null（禁 0 禁估算）')
  assert.ok(Math.abs(summary.cards.cacheHitRate! - 800 / 2000) < 1e-9, '命中率 = cacheRead/(input+cacheRead)')
  assert.equal(summary.cards.usageCoverage, 1, '唯一 turn 有 usage')
  const row = summary.byModel.find((m) => m.model === 'test-model')!
  assert.equal(row.requests, 1)
  assert.equal(row.cost, null)
  const turn = summary.turns.find((t) => t.turnId === sent.turnId)!
  assert.deepEqual(turn.tools, ['fs_write'], '关联能力列（turn 内工具集合）')
  assert.equal(turn.input, 1200)
  assert.deepEqual(summary.warnings, [], '无解析告警')
})

test('E2E·价目表注入：金额现算（接口面可用性证明——平台同步后即插即用）', async () => {
  const env = await makeEnv((h) => {
    let lastTurn = ''
    return async () => {
      const t = h.currentTurnId()
      if (t !== lastTurn) {
        lastTurn = t
        return { stopReason: 'toolUse', toolCalls: [{ id: 'c-' + t, tool: 'fs_write', args: { path: 'out/p.txt', content: 'x' } }] }
      }
      h.log.append('runtime', 'usage', t, { model: 'test-model', adapterId: 'openai-compat', input: 1_000_000, output: 100_000, cacheRead: 0, cacheCreation: 0, providerRaw: {} })
      return emitAssistant(h, { stopReason: 'stop', text: 'done' })
    }
  }, tablePriceProvider({ 'test-model': { input: 0.27, output: 1.1, cacheRead: 0.027 } }))
  const sent = (await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, text: '写' })) as { turnId: string }
  const p = (await (async () => { const dl = Date.now() + 3000; for (;;) { const ps = env.pushes.filter((m) => m.topic === 'push:authz-pending'); if (ps.length) return ps.at(-1)!.payload as Record<string, unknown>; if (Date.now() > dl) throw new Error('pending 未推送'); await new Promise((r) => setTimeout(r, 10)) } })())
  await env.svc.dispatch('authz:respond', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, requestId: p['requestId'], decision: 'once' })
  await waitForTurnEnd(env, sent.turnId)
  const summary = (await env.svc.dispatch('metrics:summary', { workspaceId: env.ws.id })) as {
    priceSynced: boolean
    turns: Array<{ turnId: string; cost: number | null }>
  }
  assert.equal(summary.priceSynced, true)
  const turn = summary.turns.find((t) => t.turnId === sent.turnId)!
  assert.ok(Math.abs(turn.cost! - (1_000_000 * 0.27 + 100_000 * 1.1) / 1e6) < 1e-9, '金额按表价目现算')
})

test('E2E·已删除会话计入计量（usage 事实本体不随索引删除态消失）+ 损坏会话告警显性化', async () => {
  const env = await makeEnv((h) => {
    let lastTurn = ''
    return async () => {
      const t = h.currentTurnId()
      if (t !== lastTurn) {
        lastTurn = t
        return { stopReason: 'toolUse', toolCalls: [{ id: 'c-' + t, tool: 'fs_write', args: { path: 'out/d.txt', content: 'x' } }] }
      }
      h.log.append('runtime', 'usage', t, { model: 'test-model', adapterId: null, input: 500, output: 50, cacheRead: 0, cacheCreation: 0, providerRaw: {} })
      return emitAssistant(h, { stopReason: 'stop', text: 'done' })
    }
  })
  const sent = (await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, text: '写' })) as { turnId: string }
  const p = (await (async () => { const dl = Date.now() + 3000; for (;;) { const ps = env.pushes.filter((m) => m.topic === 'push:authz-pending'); if (ps.length) return ps.at(-1)!.payload as Record<string, unknown>; if (Date.now() > dl) throw new Error('pending 未推送'); await new Promise((r) => setTimeout(r, 10)) } })())
  await env.svc.dispatch('authz:respond', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, requestId: p['requestId'], decision: 'once' })
  await waitForTurnEnd(env, sent.turnId)
  await env.svc.dispatch('session:delete', { workspaceId: env.ws.id, sessionId: env.sess.sessionId })
  const summary = (await env.svc.dispatch('metrics:summary', { workspaceId: env.ws.id })) as {
    cards: { today: { input: number } }
    warnings: string[]
  }
  assert.equal(summary.cards.today.input, 500, '已删除会话的 usage 事实仍计入（JSONL 不可变——审计红线）')
  assert.deepEqual(summary.warnings, [])
  // 损坏会话：完整非法行（撕裂尾会被 format 层丢弃——需完整行才触发解析错）→ 跳过 + 告警
  writeFileSync(join(env.root, '.car', 'sessions', 'S-broken.jsonl'), '{corrupted-line\n{"ok":1}\n', 'utf8')
  const summary2 = (await env.svc.dispatch('metrics:summary', { workspaceId: env.ws.id })) as {
    cards: { today: { input: number } }
    warnings: string[]
  }
  assert.equal(summary2.cards.today.input, 500, '损坏会话跳过后其余事实照常聚合')
  assert.equal(summary2.warnings.length, 1, '告警显性化（fail-visible）')
  assert.match(summary2.warnings[0], /S-broken/)
})
