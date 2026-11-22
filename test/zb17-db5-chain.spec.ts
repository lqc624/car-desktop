/**
 * zb17 · C5（DB-5 usage 按会话链细分）行为测试（纯函数 + 宿主 E2E）
 *
 * 判据：
 *  - 纯函数：summarizeFacts 带 lineageBySession → byChain 行（main/forked 谱系、models 并列、
 *    缺价目 = null 禁混算、按 input+output 排序）；不带 → 无 byChain 键（DTO 兼容）；
 *  - E2E：主链 turn + fork 子链 turn → metrics:summary.byChain 两行（main + forked），
 *    链级归属（session-index forkedFrom 同源）+ usage 事件对拍一致。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createHostService, type HostService, type PushMessage } from '../src/host-core/service.ts'
import { summarizeFacts, tablePriceProvider, nullPriceProvider, type UsageFact } from '../src/host-core/metering.ts'
import type { SessionHandle } from '../src/host-core/session-handle.ts'
import type { HostModelStep } from '../src/host-core/types.ts'
import type { MeteringSummary, SessionEventDTO, SessionEventPush, WorkspaceInfo } from '../src/shared/ipc-contract.ts'

function tmpDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `car-zb17-db5-`))
}

const fact = (sessionId: string, model: string, input: number, output: number, cacheRead = 0): UsageFact => ({
  sessionId,
  ts: 1700000000000,
  turnId: 'T1',
  model,
  adapterId: 'openai-compat',
  input,
  output,
  cacheRead,
  cacheCreation: 0,
})

// ==================== 纯函数单测 ====================

test('C5·summarizeFacts：lineageBySession 注入 → byChain 行（谱系/models 并列/排序）', () => {
  const facts = [fact('S1', 'm1', 100, 40, 60), fact('S1', 'm2', 50, 10), fact('S2', 'm1', 500, 100)]
  const lineage = new Map([
    ['S1', 'forked' as const],
    ['S2', 'main' as const],
  ])
  const s = summarizeFacts(facts, new Map(), 2, nullPriceProvider(), 1700000100000, 0, lineage)
  assert.ok(s.byChain, '注入谱系面 = byChain 携带')
  assert.equal(s.byChain!.length, 2)
  const s1 = s.byChain!.find((r) => r.sessionId === 'S1')!
  assert.equal(s1.lineage, 'forked')
  assert.deepEqual(s1.models, ['m1', 'm2'], 'multi-model 链如实并列')
  assert.equal(s1.input, 150)
  assert.equal(s1.requests, 2)
  const s2 = s.byChain!.find((r) => r.sessionId === 'S2')!
  assert.equal(s2.lineage, 'main')
  assert.equal(s2.input, 500)
  // 按 input+output 降序：S2(600) 在前
  assert.deepEqual(s.byChain!.map((r) => r.sessionId), ['S2', 'S1'])
})

test('C5·summarizeFacts：链内缺价目 = null 禁混算 + 有价目现算（byModel 同口径）', () => {
  const facts = [fact('S1', 'priced', 100, 40), fact('S2', 'unpriced', 10, 1)]
  const provider = tablePriceProvider({ priced: { input: 1, output: 2, cacheRead: 0 } })
  const s = summarizeFacts(facts, new Map(), 2, provider, 1700000100000, 0, new Map([['S1', 'main' as const], ['S2', 'forked' as const]]))
  const s1 = s.byChain!.find((r) => r.sessionId === 'S1')!
  assert.equal(s1.cost, (100 * 1 + 40 * 2) / 1e6, '有价目链现算')
  const s2 = s.byChain!.find((r) => r.sessionId === 'S2')!
  assert.equal(s2.cost, null, '缺价目链 = null（禁 0 禁部分混算）')
})

test('C5·summarizeFacts：不带 lineageBySession = 无 byChain 键（DTO 兼容——旧调用面零破坏）', () => {
  const s = summarizeFacts([fact('S1', 'm', 1, 1)], new Map(), 1, nullPriceProvider(), 1700000100000)
  assert.equal('byChain' in s, false)
})

// ==================== E2E（假模型同 metering.spec 形态） ====================

interface Env {
  svc: HostService
  ws: WorkspaceInfo
  sess: { sessionId: string }
  root: string
  pushes: PushMessage[]
}

function emitAssistant(h: SessionHandle, s: HostModelStep): HostModelStep {
  if (typeof s.text === 'string' && s.text.length > 0) {
    h.log.append('model', 'assistant', h.currentTurnId(), s.text)
  }
  return s
}

function makeEnv(): Env {
  const userData = tmpDir('ud')
  const root = tmpDir('ws')
  writeFileSync(join(root, 'car.config.ts'), "export default { llm: { baseUrl: 'http://127.0.0.1:9', model: 'test-model' } }\n", 'utf8')
  let turnSeq = 0
  const svc = createHostService({
    userDataDir: userData,
    modelFnOverride: (h: SessionHandle) => async (): Promise<HostModelStep> => {
      // 流尾 usage 事实落链（chatStep 流尾口径复刻——usage 事件本体无归属字段，归属在链级）；按回合分流对拍面
      turnSeq++
      const u = turnSeq === 1 ? { input: 1200, output: 300, cacheRead: 800 } : { input: 100, output: 50, cacheRead: 0 }
      h.log.append('runtime', 'usage', h.currentTurnId(), {
        model: 'test-model',
        adapterId: 'openai-compat',
        ...u,
        cacheCreation: 0,
        providerRaw: { source: 'fake' },
      })
      return emitAssistant(h, { stopReason: 'stop', text: 'done' })
    },
  })
  const pushes: PushMessage[] = []
  svc.onPush((m) => pushes.push(m))
  return { svc, ws: null!, sess: null!, root, pushes }
}

async function waitForTurnEnd(env: Env, turnId: string): Promise<void> {
  const deadline = Date.now() + 5000
  for (;;) {
    const hit = env.pushes
      .filter((m) => m.topic === 'push:session-event')
      .map((m) => (m.payload as SessionEventPush).event)
      .some((x) => x.kind === 'turnEnd' && x.turnId === turnId)
    if (hit) return
    if (Date.now() > deadline) throw new Error(`waitForTurnEnd 超时（${turnId}）`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

test('C5 E2E：主链 turn + fork 子链 turn → metrics:summary.byChain main/forked 两行 + usage 对拍', async () => {
  const env = makeEnv()
  try {
    env.ws = (await env.svc.dispatch('workspace:register', { path: env.root })) as WorkspaceInfo
    env.sess = (await env.svc.dispatch('session:create', { workspaceId: env.ws.id })) as { sessionId: string }
    // 主链一回合（usage 1200/300/800）
    const t1 = (await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, text: '主链问' })) as { turnId: string }
    await waitForTurnEnd(env, t1.turnId)
    // fork 子链 + 子链一回合（usage 100/50）
    const fork = (await env.svc.dispatch('session:fork', { workspaceId: env.ws.id, sessionId: env.sess.sessionId })) as { childSessionId: string }
    const t2 = (await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: fork.childSessionId, text: '子链问' })) as { turnId: string }
    await waitForTurnEnd(env, t2.turnId)

    const summary = (await env.svc.dispatch('metrics:summary', { workspaceId: env.ws.id })) as MeteringSummary & { warnings: string[] }
    assert.ok(summary.byChain, '谱系面注入 = byChain 携带')
    assert.equal(summary.byChain!.length, 2, '主链 + 子链两行')
    const main = summary.byChain!.find((r) => r.sessionId === env.sess.sessionId)!
    const child = summary.byChain!.find((r) => r.sessionId === fork.childSessionId)!
    assert.equal(main.lineage, 'main')
    assert.equal(child.lineage, 'forked', '链级归属 = session-index forkedFrom 同源')
    assert.equal(main.input, 1200)
    assert.equal(main.output, 300)
    // fork 迁移面：子链携带父链事件（Z-1 语义）——子链 usage = 迁移 1200 + 自有 100
    assert.equal(child.input, 1300, '子链 usage = 迁移(父链) + 自有')
    assert.equal(child.output, 350)
    assert.deepEqual(main.models, ['test-model'])
    assert.equal(main.cost, null, '本地模式无价目 = null 禁 0')
    assert.deepEqual(summary.warnings, [])
  } finally {
    env.svc.dispose()
  }
})
