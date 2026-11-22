/**
 * zb17 · C8（AD-3 长会话历史装载游标消费面）行为测试（宿主公共 API 驱动）
 *
 * 判据：
 *  - session:open 全量（缺省行为零破坏——afterSeq 缺省 = 全量）；
 *  - afterSeq 提供时：events = seq > afterSeq 增量段、eventCount 恒 = 链全长（alive 句柄路径）；
 *  - 合并一致性：前缀（seq ≤ k）+ 增量段 ≡ 全量重放（逐事件深等——投影逐字节一致判据）；
 *  - 游标尽头：afterSeq = 末 seq → events 空、eventCount 不变；
 *  - 只读回放路径（已删除会话）afterSeq 过滤同构 + model/set 元数据派生仍走全量。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createHostService, type HostService, type PushMessage } from '../src/host-core/service.ts'
import type { SessionEventDTO, SessionEventPush, SessionOpenResult, WorkspaceInfo } from '../src/shared/ipc-contract.ts'
import type { SessionHandle } from '../src/host-core/session-handle.ts'
import type { HostModelStep } from '../src/host-core/types.ts'

function tmpDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `car-zb17-ad3-`))
}

interface Env {
  svc: HostService
  ws: WorkspaceInfo
  root: string
  pushes: PushMessage[]
}

function makeEnv(): Env {
  const userData = tmpDir('ud')
  const root = tmpDir('ws')
  writeFileSync(join(root, 'car.config.ts'), "export default { llm: { baseUrl: 'http://127.0.0.1:9', model: 'test-model' } }\n", 'utf8')
  const svc = createHostService({
    userDataDir: userData,
    modelFnOverride: (h: SessionHandle) => async (): Promise<HostModelStep> => {
      h.log.append('model', 'assistant', h.currentTurnId(), 'ok')
      return { stopReason: 'stop', text: 'ok' }
    },
  })
  const pushes: PushMessage[] = []
  svc.onPush((m) => pushes.push(m))
  return { svc, ws: null!, root, pushes }
}

async function sendTurn(env: Env, sessionId: string, text: string): Promise<string> {
  const t = (await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId, text })) as { turnId: string }
  const deadline = Date.now() + 5000
  for (;;) {
    const hit = env.pushes
      .filter((m) => m.topic === 'push:session-event')
      .map((m) => (m.payload as SessionEventPush).event)
      .some((x) => x.kind === 'turnEnd' && x.turnId === t.turnId)
    if (hit) return t.turnId
    if (Date.now() > deadline) throw new Error(`waitForTurnEnd 超时（${t.turnId}）`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

test('C8·session:open 游标装载：缺省全量 + afterSeq 增量段 + 合并 ≡ 全量 + 尽头空段（alive 句柄路径）', async () => {
  const env = makeEnv()
  try {
    env.ws = (await env.svc.dispatch('workspace:register', { path: env.root })) as WorkspaceInfo
    const s = (await env.svc.dispatch('session:create', { workspaceId: env.ws.id })) as { sessionId: string }
    await sendTurn(env, s.sessionId, '一')
    await sendTurn(env, s.sessionId, '二')
    await sendTurn(env, s.sessionId, '三')

    // 缺省 = 全量（兼容零破坏）
    const full = (await env.svc.dispatch('session:open', { workspaceId: env.ws.id, sessionId: s.sessionId })) as SessionOpenResult
    assert.equal(full.eventCount, full.events.length, '缺省行为：eventCount = 事件数')
    assert.ok(full.events.length >= 6, '三回合链（user/assistant/turnEnd ×3 + 会话事件）')

    // afterSeq = 中点：events = 增量段、eventCount 恒 = 链全长
    const k = full.events[Math.floor(full.events.length / 2)]!.seq
    const tail = (await env.svc.dispatch('session:open', { workspaceId: env.ws.id, sessionId: s.sessionId, afterSeq: k })) as SessionOpenResult
    assert.equal(tail.eventCount, full.eventCount, 'eventCount 恒 = 链全长')
    assert.ok(tail.events.every((e) => e.seq > k), '增量段全部 seq > afterSeq')
    assert.ok(tail.events.length < full.events.length, '增量段短于全量')

    // 合并一致性：前缀 + 增量段 ≡ 全量重放（逐事件深等）
    const prefix = full.events.filter((e) => e.seq <= k)
    const merged: SessionEventDTO[] = [...prefix, ...tail.events]
    const fullAgain = (await env.svc.dispatch('session:open', { workspaceId: env.ws.id, sessionId: s.sessionId })) as SessionOpenResult
    assert.deepEqual(merged, fullAgain.events, '投影逐字节一致（合并 ≡ 全量重放）')

    // 游标尽头：afterSeq = 末 seq → 空段、eventCount 不变
    const lastSeq = full.events[full.events.length - 1]!.seq
    const empty = (await env.svc.dispatch('session:open', { workspaceId: env.ws.id, sessionId: s.sessionId, afterSeq: lastSeq })) as SessionOpenResult
    assert.deepEqual(empty.events, [], '尽头 = 空增量段')
    assert.equal(empty.eventCount, full.eventCount)
  } finally {
    env.svc.dispose()
  }
})

test('C8·只读回放路径（已删除会话）：afterSeq 过滤同构 + model/set 元数据派生仍走全量', async () => {
  const env = makeEnv()
  try {
    env.ws = (await env.svc.dispatch('workspace:register', { path: env.root })) as WorkspaceInfo
    const s = (await env.svc.dispatch('session:create', { workspaceId: env.ws.id })) as { sessionId: string }
    await sendTurn(env, s.sessionId, '问')
    // 显式设模型（model/set 落链——回放路径元数据派生源）
    await env.svc.dispatch('session:set-model', { workspaceId: env.ws.id, sessionId: s.sessionId, model: 'replay-model' })
    await env.svc.dispatch('session:delete', { workspaceId: env.ws.id, sessionId: s.sessionId })

    // 已删除 = 只读回放面（D-S2-6 保留）：缺省全量
    const full = (await env.svc.dispatch('session:open', { workspaceId: env.ws.id, sessionId: s.sessionId })) as SessionOpenResult
    assert.equal(full.model, 'replay-model', 'model/set 派生走全量扫描')
    const mid = full.events[Math.floor(full.events.length / 2)]!.seq
    const tail = (await env.svc.dispatch('session:open', { workspaceId: env.ws.id, sessionId: s.sessionId, afterSeq: mid })) as SessionOpenResult
    assert.equal(tail.eventCount, full.eventCount, 'eventCount 恒 = 链全长')
    assert.ok(tail.events.every((e) => e.seq > mid))
    assert.equal(tail.model, 'replay-model', '元数据派生不受增量段影响')
    const merged = [...full.events.filter((e) => e.seq <= mid), ...tail.events]
    assert.deepEqual(merged, full.events, '回放路径合并 ≡ 全量重放')
  } finally {
    env.svc.dispose()
  }
})
