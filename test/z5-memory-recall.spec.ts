/**
 * z5 · 0.12.0 记忆召回消费接线（Z-5 / D-V12-7 + D-V12-8，内核 1.25 召回层桌面消费）
 *
 * 判据：
 *  - 首轮索引常驻：turn:send memoryInject → system 行 meta injection='memory-index'（rendered 含
 *    记忆 id）+ 第二 turn 不重注（first-turn-once 判重）；
 *  - 双键判重防旧会话双注入：链上已有 legacy 'memory' 注入行 → 索引不注入（chainHasMemoryInjection
 *    扩展 'memory' | 'memory-index'）；
 *  - 每 turn 确定性召回：turn 文本命中 tags ∪ keywords → system 行 meta injection='memory-recall'
 *    + hits（matchedKeys 字面落链——「有据可查」取证形态）；零命中零事件；
 *  - driftRepaired 透传：索引盘面手改漂移 → 注入行 meta 携 driftRepaired='drift'（可见禁静默）；
 *  - MemoryView 三字段 round-trip：memoryWrite +type/description/keywords → memoryList 回读；
 *    edit meta 清空语义（type null → 无类型）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createHostService, type HostService, type PushMessage } from '../src/host-core/service.ts'
import type { MemoryEntryDTO, SessionEventDTO, SessionEventPush, WorkspaceInfo } from '../src/shared/ipc-contract.ts'
import type { SessionHandle } from '../src/host-core/session-handle.ts'
import type { HostModelFn, HostModelStep } from '../src/host-core/types.ts'

function tmpDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `car-z5-${label}-`))
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

async function makeEnv(scriptAppend?: (h: SessionHandle, turnIndex: number) => void): Promise<Env> {
  const userData = tmpDir('ud')
  const root = tmpDir('ws')
  writeFileSync(join(root, 'car.config.ts'), "export default { llm: { baseUrl: 'http://127.0.0.1:9', model: 'test-model' } }\n", 'utf8')
  const svc = createHostService({
    userDataDir: userData,
    modelFnOverride: (h: SessionHandle) => {
      let lastTurn = ''
      let turnIndex = 0
      return async (): Promise<HostModelStep> => {
        const t = h.currentTurnId()
        if (t !== lastTurn) {
          lastTurn = t
          scriptAppend?.(h, turnIndex++)
          return { stopReason: 'stop', text: 'done' }
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
function systemInjections(env: Env, kind: string): Array<{ meta: Record<string, unknown>; payload: unknown }> {
  return eventsOf(env)
    .filter((e) => e.kind === 'system' && (e.meta as Record<string, unknown> | null)?.['injection'] === kind)
    .map((e) => ({ meta: e.meta as Record<string, unknown>, payload: e.payload }))
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
async function send(env: Env, text: string, memoryInject = true): Promise<string> {
  const r = (await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, text, memoryInject })) as { turnId: string }
  return r.turnId
}

async function seedMemories(env: Env, sessionId: string): Promise<string[]> {
  const m1 = (await env.svc.dispatch('memory:write', { workspaceId: env.ws.id, sessionId, text: '部署视图 v0.10 已发版', tags: ['部署'], type: 'project', description: '浏览器簇发版记录', keywords: ['发版'] })) as MemoryEntryDTO
  const m2 = (await env.svc.dispatch('memory:write', { workspaceId: env.ws.id, sessionId, text: '回归测试偏好先跑 smoke', tags: [], type: 'feedback', keywords: ['回归'] })) as MemoryEntryDTO
  return [m1.id, m2.id]
}

test('Z5-1 首轮索引常驻 + 每 turn 召回命中 + 零命中零事件 + 二轮不重注', async () => {
  const env = await makeEnv()
  const ids = await seedMemories(env, env.sess.sessionId)
  // T1：命中（文本含「部署」tag + 「回归」keywords）
  const t1 = await send(env, '帮我看看部署和回归的安排')
  await waitForTurnEnd(env, t1)
  const idx = systemInjections(env, 'memory-index')
  assert.equal(idx.length, 1, '首轮索引恰一行（first-turn-once）')
  assert.equal(idx[0]!.meta['count'], 2)
  assert.ok(String(idx[0]!.payload).includes(ids[0]!), '索引行含记忆 id')
  assert.equal('driftRepaired' in idx[0]!.meta, false, '对拍命中零修复（无 driftRepaired 键）')
  const rec = systemInjections(env, 'memory-recall')
  assert.equal(rec.length, 1, 'T1 召回恰一行')
  const hits = rec[0]!.meta['hits'] as Array<{ id: string; matchedKeys: string[] }>
  assert.deepEqual(hits.map((h) => h.id), ids.slice().reverse(), '召回两条（updatedAt 降序——m2 后写在前）')
  assert.ok(hits.every((h) => h.matchedKeys.length > 0), 'matchedKeys 字面在场（有据可查）')
  // T2：零命中 → 零召回事件；索引不重注
  const t2 = await send(env, '完全无关的话题闲聊')
  await waitForTurnEnd(env, t2)
  assert.equal(systemInjections(env, 'memory-index').length, 1, '二轮索引不重注')
  assert.equal(systemInjections(env, 'memory-recall').length, 1, '零命中 = 零召回零落链（缺席无需取证）')
})

test('Z5-2 双键判重：链上 legacy memory 注入行在 → 索引不注入（旧会话升级防双注入）', async () => {
  // T1 memoryInject=false + 脚本注入 legacy 形态 system 行（模拟 1.25 前旧会话升级场景——判重前提 =
  // legacy 行先于首次 memoryInject sendTurn 落链）
  const env = await makeEnv((h) => {
    h.log.append('user', 'system', 'system', '[CAR 记忆注入] 共 1 条：\n- [legacy-m] 旧形态全量注入', { injection: 'memory', count: 1, chars: 30 })
  })
  await seedMemories(env, env.sess.sessionId)
  const t0 = await send(env, '预置旧会话注入', false)
  await waitForTurnEnd(env, t0)
  const t = await send(env, '部署相关的请求', true)
  await waitForTurnEnd(env, t)
  assert.equal(systemInjections(env, 'memory-index').length, 0, 'legacy 行在场 → 索引不注入（双键判重）')
  const rec = systemInjections(env, 'memory-recall')
  assert.equal(rec.length, 1, '召回面照常（召回不受索引判重门控——每 turn 独立）')
})

test('Z5-3 driftRepaired 透传：索引盘面漂移 → 注入行 meta 可见（禁静默）', async () => {
  const env = await makeEnv()
  const ids = await seedMemories(env, env.sess.sessionId)
  // memory:write 已同步重写索引（fresh）——手改盘面制造漂移（模拟外部编辑）
  const idxFile = join(env.root, '.car', 'memory', 'index.md')
  const good = readFileSync(idxFile, 'utf8')
  writeFileSync(idxFile, good.replace(ids[0]!, '手改漂移'), 'utf8')
  const t = await send(env, '部署和回归')
  await waitForTurnEnd(env, t)
  const idx = systemInjections(env, 'memory-index')
  assert.equal(idx.length, 1)
  assert.equal(idx[0]!.meta['driftRepaired'], 'drift', '漂移重建计数随注入行 meta 可见（宿主裁量叙事化）')
  assert.ok(String(idx[0]!.payload).includes(ids[0]!), '重建后索引行恢复真值')
})

test('Z5-4 MemoryView 三字段 round-trip + edit meta 清空语义（D-V12-8）', async () => {
  const env = await makeEnv()
  const ids = await seedMemories(env, env.sess.sessionId)
  let list = (await env.svc.dispatch('memory:list', { workspaceId: env.ws.id })) as MemoryEntryDTO[]
  const m1 = list.find((m) => m.id === ids[0])!
  assert.equal(m1.type, 'project')
  assert.equal(m1.description, '浏览器簇发版记录')
  assert.deepEqual(m1.keywords, ['发版'])
  // edit meta：type 清空（null）+ keywords 清空（[]）+ description 替换
  await env.svc.dispatch('memory:edit', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, id: ids[0]!, text: m1.text, meta: { type: null, description: '新钩子句', keywords: [] } })
  list = (await env.svc.dispatch('memory:list', { workspaceId: env.ws.id })) as MemoryEntryDTO[]
  const edited = list.find((m) => m.id === ids[0])!
  assert.equal(edited.type, undefined, 'meta.type null = 清空')
  assert.equal(edited.description, '新钩子句')
  assert.equal(edited.keywords, undefined, 'meta.keywords [] = 清空')
  // 非法类型 fail-visible（内核 MEMORY_TYPES 校验——错误回到渲染层红条）
  await assert.rejects(
    () => env.svc.dispatch('memory:write', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, text: 'x', type: 'team' }),
    /CAR-E-MEM-TYPE/,
  )
})
