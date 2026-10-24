/**
 * K5-C 桌面接线测试（内核 1.18.0 D-51 消费面 · V4 = 窗口 × 0.78）
 *
 * 判据：
 *  - token 维度缺省装配：compaction 开启 + 无显式 thresholdTokens + 会话窗口（model/set）
 *    或端点窗口在册 → 自动挂载点按 窗口×0.78 触发（事件阈值永不命中的场景下独走）
 *  - 无窗口不装配：sessionWindow/contextWindow 皆无 → token 维度不武装（禁估算，D-C5 同口径）
 *  - 显式 thresholdTokens 压过缺省：car.config 单一事实源
 * 前提纪律：全注入临时目录；E2E 经宿主公共 API（turn:send / session:set-model）驱动；
 * usage 事实由 modelFn 注入（chatStep 生产面同形态——payload 七键）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createHostService, type HostService, type PushMessage } from '../src/host-core/service.ts'
import type { SessionEventDTO, SessionEventPush, WorkspaceInfo } from '../src/shared/ipc-contract.ts'
import type { SessionHandle } from '../src/host-core/session-handle.ts'
import type { HostModelStep } from '../src/host-core/types.ts'

function tmpDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `car-k5-${label}-`))
}

/** 模型回调：先落 usage 事实（chatStep 生产形态）再回 assistant——token 维度的事实源 */
function emitAssistantWithUsage(h: SessionHandle, s: HostModelStep, input: number): HostModelStep {
  h.log.append('runtime', 'usage', h.currentTurnId(), {
    model: 'test-model', adapterId: 'openai-compat',
    input, output: 12, cacheRead: 0, cacheCreation: 0, providerRaw: {},
  })
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
  userData: string
  pushes: PushMessage[]
}

async function makeEnv(
  opts: { carConfigFull?: string; usageInput?: number } = {},
): Promise<Env> {
  const userData = tmpDir('ud')
  const root = tmpDir('ws')
  const usageInput = opts.usageInput ?? 90_000
  writeFileSync(
    join(root, 'car.config.ts'),
    (opts.carConfigFull ??
      `export default { llm: { baseUrl: 'http://127.0.0.1:9', model: 'test-model', compaction: { enabled: true, thresholdEvents: 9999, protectLastTurns: 1 } } }`) + '\n',
    'utf8',
  )
  const svc = createHostService({
    userDataDir: userData,
    modelFnOverride: (h: SessionHandle) => async () => emitAssistantWithUsage(h, { stopReason: 'stop', text: 'ok' }, usageInput),
  })
  const pushes: PushMessage[] = []
  svc.onPush((m) => pushes.push(m))
  const ws = (await svc.dispatch('workspace:register', { path: root })) as WorkspaceInfo
  const sess = (await svc.dispatch('session:create', { workspaceId: ws.id })) as { sessionId: string }
  return { svc, ws, sess, root, userData, pushes }
}

function eventsOf(env: Env): SessionEventDTO[] {
  return env.pushes.filter((m) => m.topic === 'push:session-event').map((m) => (m.payload as SessionEventPush).event)
}

async function sendTurn(env: Env, text: string): Promise<string> {
  const t = (await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, text })) as { turnId: string }
  const deadline = Date.now() + 8000
  for (;;) {
    if (eventsOf(env).some((x) => x.kind === 'turnEnd' && x.turnId === t.turnId)) return t.turnId
    if (Date.now() > deadline) throw new Error(`waitForTurnEnd 超时（${t.turnId}）`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

test('k5-1 token 维度缺省装配：会话窗口 100k → 78k 阈值，事件阈值 9999 永不命中下独走触发', async () => {
  const env = await makeEnv() // usage input 90000 ≥ 78000
  try {
    await sendTurn(env, 'a')
    assert.ok(!eventsOf(env).some((x) => x.kind === 'compact'), '首轮前无 usage 不触发')
    await env.svc.dispatch('session:set-model', {
      workspaceId: env.ws.id, sessionId: env.sess.sessionId, model: 'test-model', contextWindow: 100_000,
    })
    await sendTurn(env, 'b')
    assert.ok(!eventsOf(env).some((x) => x.kind === 'compact'), '第二个 sendTurn 仅 T1 一个 turn（protectLastTurns=1 全保护）——NORANGE 跳过（best-effort 语义）')
    await sendTurn(env, 'c')
    const evs = eventsOf(env)
    const compactEv = evs.find((x) => x.kind === 'compact')
    assert.ok(compactEv, '第三个 sendTurn 起点 token 命中（90000 ≥ 100000×0.78）触发自动压缩')
    const userC = evs.filter((x) => x.kind === 'user' && x.payload === 'c').at(-1)!
    assert.ok(compactEv!.seq < userC.seq, '先压缩后 append user（S5 挂载点语义不变）')
  } finally {
    env.svc.dispose()
  }
})

test('k5-2 无窗口不装配：sessionWindow/contextWindow 皆无 → usage 再大也不触发（禁估算）', async () => {
  const env = await makeEnv()
  try {
    await sendTurn(env, 'a')
    await sendTurn(env, 'b')
    await sendTurn(env, 'c')
    await sendTurn(env, 'd')
    assert.ok(!eventsOf(env).some((x) => x.kind === 'compact'), '无窗口真值 = token 维度不武装')
  } finally {
    env.svc.dispose()
  }
})

test('k5-3 显式 thresholdTokens 压过缺省：95000 > usage 90000 不触发；50000 无窗口也触发', async () => {
  const explicitHigh = await makeEnv({
    carConfigFull: `export default { llm: { baseUrl: 'http://127.0.0.1:9', model: 'test-model', compaction: { enabled: true, thresholdEvents: 9999, thresholdTokens: 95000, protectLastTurns: 1 } } }`,
  })
  try {
    for (const t of ['a', 'b', 'c', 'd']) await sendTurn(explicitHigh, t)
    assert.ok(!eventsOf(explicitHigh).some((x) => x.kind === 'compact'), '显式 95000 > 90000 → 不触发（显式值非缺省乘积）')
  } finally {
    explicitHigh.svc.dispose()
  }
  const explicitLow = await makeEnv({
    carConfigFull: `export default { llm: { baseUrl: 'http://127.0.0.1:9', model: 'test-model', compaction: { enabled: true, thresholdEvents: 9999, thresholdTokens: 50000, protectLastTurns: 1 } } }`,
  })
  try {
    await sendTurn(explicitLow, 'a')
    await sendTurn(explicitLow, 'b')
    await sendTurn(explicitLow, 'c')
    assert.ok(eventsOf(explicitLow).some((x) => x.kind === 'compact'), '显式 50000 ≤ 90000 → 第三个 sendTurn 触发（无需窗口真值）')
  } finally {
    explicitLow.svc.dispose()
  }
})
