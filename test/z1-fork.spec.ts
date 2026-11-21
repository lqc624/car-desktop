/**
 * z1 · 0.13.0 会话内分叉（Z-1 / Q-Z2 / D-Z13-1~4，内核 1.26.0 forkInSession 桌面消费）
 *
 * 判据：
 *  - session:fork E2E（消息行入口形态）：upToSeq = 所选 user 事件 seq → 子链 JSONL 落盘
 *    （SessionFileStore 同形态单文件）+ 索引谱系登记（标题 ⎇ 后缀 + forkedFrom）+ 双链 fork
 *    标记（child branch / parent branch-out——tailHash 对账键）；
 *  - 排除语义：所选 user 消息不在子链（回到该问题之前重新问）；子链 deriveMessages 前缀等值；
 *  - 会话头入口形态：upToSeq 缺省 = 整链分叉；
 *  - 分叉后父链继续可写（复制点快照非冻结）；
 *  - 边界语义：upToSeq 缺省整链 / 越界 fail-visible（内核 s84 覆盖算法面——本 spec 管宿主接线）。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createHostService, type HostService, type PushMessage } from '../src/host-core/service.ts'
import type { SessionEventDTO, SessionEventPush, WorkspaceInfo } from '../src/shared/ipc-contract.ts'
import type { SessionHandle } from '../src/host-core/session-handle.ts'
import type { HostModelFn, HostModelStep } from '../src/host-core/types.ts'

function tmpDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `car-z1-${label}-`))
}

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

async function makeEnv(): Promise<Env> {
  const userData = tmpDir('ud')
  const root = tmpDir('ws')
  writeFileSync(join(root, 'car.config.ts'), "export default { llm: { baseUrl: 'http://127.0.0.1:9', model: 'test-model' } }\n", 'utf8')
  const svc = createHostService({
    userDataDir: userData,
    modelFnOverride: (h: SessionHandle) => {
      let lastTurn = ''
      return async (): Promise<HostModelStep> => {
        const t = h.currentTurnId()
        if (t !== lastTurn) {
          lastTurn = t
          return emitAssistant(h, { stopReason: 'stop', text: '答：' + h.currentTurnId() })
        }
        return emitAssistant(h, { stopReason: 'stop', text: 'done' })
      }
    },
  })
  const pushes: PushMessage[] = []
  svc.onPush((m) => pushes.push(m))
  const ws = (await svc.dispatch('workspace:register', { path: root })) as WorkspaceInfo
  const sess = (await svc.dispatch('session:create', { workspaceId: ws.id })) as { sessionId: string }
  return { svc, ws, sess, root, pushes }
}

function eventsOf(env: Env): SessionEventDTO[] {
  return env.pushes.filter((m) => m.topic === 'push:session-event').map((m) => (m.payload as SessionEventPush).event)
}
async function waitForTurnEnd(env: Env, turnId: string, timeoutMs = 5000): Promise<SessionEventDTO> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const e = eventsOf(env).find((x) => x.kind === 'turnEnd' && x.turnId === turnId)
    if (e) return e
    if (Date.now() > deadline) throw new Error(`waitForTurnEnd 超时（${turnId}）`)
    await new Promise((r) => setTimeout(r, 20))
  }
}
async function send(env: Env, text: string): Promise<string> {
  const r = (await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, text })) as { turnId: string }
  return r.turnId
}

test('Z1-1 消息行入口：排除语义分叉 + 子链落盘 + 索引谱系 + 双链标记', async () => {
  const env = await makeEnv()
  const t1 = await send(env, '问题一')
  await waitForTurnEnd(env, t1)
  const t2 = await send(env, '问题二')
  await waitForTurnEnd(env, t2)
  // 边界 = 「问题二」user 事件 seq（消息行按钮绑定链 seq——排除语义：子链不含该条）
  const parentEvents = (await env.svc.dispatch('session:open', { workspaceId: env.ws.id, sessionId: env.sess.sessionId })) as { events: SessionEventDTO[] }
  const t2User = parentEvents.events.find((e) => e.kind === 'user' && e.payload === '问题二')
  assert.ok(t2User, '源链含问题二 user 事件')
  const r = (await env.svc.dispatch('session:fork', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, upToSeq: t2User!.seq })) as { childSessionId: string; migrated: number }
  assert.equal(r.migrated, t2User!.seq, '迁移数 = 边界 seq')
  // 子链落盘（SessionFileStore 同形态 JSONL 单文件）
  const childFile = join(env.root, '.car', 'sessions', r.childSessionId + '.jsonl')
  assert.ok(existsSync(childFile), '子链 JSONL 落盘')
  const childRaw = readFileSync(childFile, 'utf8')
  assert.ok(childRaw.includes('"type":"branch"'), '子链 fork-in 标记落盘（payload.type 判别）')
  assert.ok(!childRaw.includes('问题二'), '排除语义：所选消息不在子链')
  // 索引谱系（标题 ⎇ 后缀 + forkedFrom）
  const idx = JSON.parse(readFileSync(join(env.root, '.car', 'session-index.json'), 'utf8')) as { sessions: Record<string, { title?: string; forkedFrom?: string }> }
  assert.equal(idx.sessions[r.childSessionId]!.forkedFrom, env.sess.sessionId)
  assert.ok(idx.sessions[r.childSessionId]!.title!.endsWith(' ⎇'), '自动谱系命名（父标题 + ⎇ 后缀）')
  // 子链打开：前缀等值 + fork-in 标记在链
  const child = (await env.svc.dispatch('session:open', { workspaceId: env.ws.id, sessionId: r.childSessionId })) as { events: SessionEventDTO[] }
  const childTexts = child.events.map((e) => (typeof e.payload === 'string' ? e.payload : ''))
  assert.ok(childTexts.some((t) => t.includes('问题一')), 'T1 历史在子链')
  const inMarker = child.events.find((e) => e.kind === 'fork')
  assert.ok(inMarker, '子链 fork 标记')
  assert.equal((inMarker!.payload as Record<string, unknown>)['type'], 'branch')
  assert.equal((inMarker!.payload as Record<string, unknown>)['fromSessionId'], env.sess.sessionId)
  // 源链 fork-out 标记（重开父会话读链）
  const parentRe = (await env.svc.dispatch('session:open', { workspaceId: env.ws.id, sessionId: env.sess.sessionId })) as { events: SessionEventDTO[] }
  const outMarker = parentRe.events.find((e) => e.kind === 'fork')
  assert.ok(outMarker, '源链 fork-out 标记落链（双向留痕）')
  const op = outMarker!.payload as Record<string, unknown>
  assert.equal(op['type'], 'branch-out')
  assert.equal(op['toSessionId'], r.childSessionId)
  assert.equal(op['tailHash'], (inMarker!.payload as Record<string, unknown>)['fromTailHash'], '对账键同值')
})

test('Z1-2 会话头入口：upToSeq 缺省 = 整链分叉 + 分叉后父链继续可写', async () => {
  const env = await makeEnv()
  const t1 = await send(env, '唯一问题')
  await waitForTurnEnd(env, t1)
  const beforeParentLen = eventsOf(env).filter((e) => e.turnId === t1).length
  const r = (await env.svc.dispatch('session:fork', { workspaceId: env.ws.id, sessionId: env.sess.sessionId })) as { childSessionId: string; migrated: number }
  assert.ok(r.migrated > beforeParentLen, '缺省 = 整链迁移（含 turnEnd 等非对话件）')
  const child = (await env.svc.dispatch('session:open', { workspaceId: env.ws.id, sessionId: r.childSessionId })) as { events: SessionEventDTO[] }
  assert.ok(child.events.some((e) => e.kind === 'user' && e.payload === '唯一问题'), '整链分叉含全部历史')
  // 分叉后父链继续可写（复制点快照非冻结——fork-out 标记后新 turn 正常落链）
  const t2 = await send(env, '父链分叉后的新消息')
  await waitForTurnEnd(env, t2)
  const parent = (await env.svc.dispatch('session:open', { workspaceId: env.ws.id, sessionId: env.sess.sessionId })) as { events: SessionEventDTO[] }
  assert.ok(parent.events.some((e) => e.kind === 'user' && e.payload === '父链分叉后的新消息'), '父链分叉后继续可写')
  assert.ok(!child.events.some((e) => e.kind === 'user' && e.payload === '父链分叉后的新消息'), '子链与父链后续解耦（试不同方案不丢原链）')
})
