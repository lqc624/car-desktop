/**
 * S6 白盒记忆面 E2E（宿主公共 API 驱动；内核 MemoryStore 真跑——D-S6-1/2）
 *
 * 覆盖：
 *  - CRUD 落链全链：write/edit/remove/rollback 经 IPC dispatch → 活跃会话链 memory 事件
 *    （kind='memory'，actor='user'，turnId='memory'，payload.type 四态）+ 盘面 JSONL 文件
 *    （<workspaceRoot>/.car/memory/）+ memory:list 一致；
 *  - 落链承载 = 活跃会话（D-46 ②）：无活跃句柄的写操作显式拒绝（宿主 requireAliveHandle 前置）；
 *  - 注入装配（D-S6-2）：sendTurn memoryInject=true → 链上 system meta.injection==='memory'
 *    （count/chars 真值）+ 会话首轮一次（第二 turn 不重注——append-only 链）+ 开关 false 不注入；
 *  - 预算超限 = 内核 fail-visible 同步抛出（sendTurn throw——渲染层红条语义，禁静默截断）。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createHostService, type HostService, type PushMessage } from '../src/host-core/service.ts'
import type { SessionEventDTO, SessionEventPush, WorkspaceInfo } from '../src/shared/ipc-contract.ts'
import type { SessionHandle } from '../src/host-core/session-handle.ts'

function tmpDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `car-desk6-mem-${label}-`))
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
    authzTimeoutMs: 120_000,
    modelFnOverride: () => async () => {
      return { stopReason: 'stop' as const, secretsRedacted: 0 }
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

function memEvents(env: Env): SessionEventDTO[] {
  return eventsOf(env).filter((e) => e.kind === 'memory')
}

test('S6M-1 CRUD 落链全链：write/edit/remove/rollback 四态事件 + 盘面 JSONL + list 一致', async () => {
  const env = await makeEnv()
  try {
    // write
    const w = (await env.svc.dispatch('memory:write', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, text: '第一版', tags: ['t1'] })) as { id: string; text: string; tags?: string[] }
    assert.equal(w.text, '第一版')
    assert.ok(w.id, 'id 在册（显式或缺省派生）')
    // 盘面：.car/memory/<id>.json 白盒可见
    const file = join(env.root, '.car', 'memory', `${w.id}.json`)
    assert.equal(existsSync(file), true, '记忆文件落盘（工作区分片目录）')
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    assert.equal(raw['text'], '第一版')
    assert.equal(raw['sourceSession'], env.sess.sessionId, 'sourceSession = 落链承载会话')
    // 落链形态
    const memEv = memEvents(env)
    assert.equal(memEv.length, 1)
    assert.equal(memEv[0]!.actor, 'user')
    assert.equal(memEv[0]!.turnId, 'memory')
    assert.equal((memEv[0]!.payload as Record<string, unknown>)['type'], 'write')
    assert.equal((memEv[0]!.payload as Record<string, unknown>)['text'], '第一版')
    // list
    let list = (await env.svc.dispatch('memory:list', { workspaceId: env.ws.id })) as Array<{ id: string; text: string }>
    assert.deepEqual(list.map((x) => x.id), [w.id])
    // edit
    const ed = (await env.svc.dispatch('memory:edit', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, id: w.id, text: '第二版' })) as { text: string }
    assert.equal(ed.text, '第二版')
    assert.equal((memEvents(env).at(-1)!.payload as Record<string, unknown>)['type'], 'edit')
    assert.equal((memEvents(env).at(-1)!.payload as Record<string, unknown>)['before'], '第一版', 'before 全文在链（rollback 数据源）')
    list = (await env.svc.dispatch('memory:list', { workspaceId: env.ws.id })) as Array<{ id: string; text: string }>
    assert.equal(list[0]!.text, '第二版')
    // remove（补偿事件 + 文件移除）
    await env.svc.dispatch('memory:remove', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, id: w.id })
    assert.equal(existsSync(file), false, '删除后文件移除')
    assert.equal(((memEvents(env).at(-1)!.payload as Record<string, unknown>)['type']), 'delete')
    assert.equal((memEvents(env).at(-1)!.payload as Record<string, unknown>)['before'], '第二版')
    list = (await env.svc.dispatch('memory:list', { workspaceId: env.ws.id })) as Array<{ id: string }>
    assert.equal(list.length, 0)
    // rollback = undelete（链即版本库）
    const rb = (await env.svc.dispatch('memory:rollback', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, id: w.id })) as { text: string } | null
    assert.equal(rb?.text, '第二版', 'delete 后 rollback = undelete 恢复被删正文')
    assert.equal(existsSync(file), true, 'rollback 后文件恢复')
    assert.equal(((memEvents(env).at(-1)!.payload as Record<string, unknown>)['type']), 'rollback')
    // 链完整（只追加红线）
    assert.equal(memEvents(env).length, 4)
    // list 一致性收尾
    list = (await env.svc.dispatch('memory:list', { workspaceId: env.ws.id })) as Array<{ id: string }>
    assert.equal(list.length, 1)
  } finally {
    env.svc.closeAll?.()
  }
})

test('S6M-2 落链承载 = 活跃会话：无活跃句柄的写操作显式拒绝（D-46 ②）', async () => {
  const env = await makeEnv()
  try {
    await assert.rejects(
      () => env.svc.dispatch('memory:write', { workspaceId: env.ws.id, sessionId: 'S-not-open', text: 'x' }),
      /不可续写|会话/,
      '未打开会话的 memory:write = 宿主侧显式拒绝（无旁路写入通道）',
    )
    await assert.rejects(
      () => env.svc.dispatch('memory:edit', { workspaceId: env.ws.id, sessionId: 'S-not-open', id: 'm1', text: 'x' }),
      /不可续写|会话/,
    )
  } finally {
    env.svc.closeAll?.()
  }
})

test('S6M-3 注入装配：首轮一次（count/chars 真值落 meta）+ 第二 turn 不重注 + 开关 false 不注入', async () => {
  const env = await makeEnv()
  try {
    await env.svc.dispatch('memory:write', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, id: 'mem-a', text: '记忆甲' })
    await env.svc.dispatch('memory:write', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, id: 'mem-b', text: '记忆乙' })
    // turn 1：memoryInject=true
    const r1 = (await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, text: '问 1', memoryInject: true })) as { turnId: string }
    await waitForTurnEnd(env, r1.turnId)
    const inj1 = eventsOf(env).filter((e) => e.kind === 'system' && (e.meta as Record<string, unknown> | null)?.['injection'] === 'memory')
    assert.equal(inj1.length, 1, '注入行恰一条（首轮）')
    assert.equal((inj1[0]!.meta as Record<string, unknown>)['count'], 2, 'count = 记忆条数')
    assert.ok(Number((inj1[0]!.meta as Record<string, unknown>)['chars']) > 0, 'chars = 拼装实长')
    assert.ok(String(inj1[0]!.payload).includes('记忆甲'), '注入正文含记忆内容（Model-visible means logged）')
    // turn 2：memoryInject=true 再发——不重注（append-only 链，注入行恒一）
    const r2 = (await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, text: '问 2', memoryInject: true })) as { turnId: string }
    await waitForTurnEnd(env, r2.turnId)
    const inj2 = eventsOf(env).filter((e) => e.kind === 'system' && (e.meta as Record<string, unknown> | null)?.['injection'] === 'memory')
    assert.equal(inj2.length, 1, '第二 turn 不重注（链上注入行恒一）')
    // turn 3：开关 false——无新注入（本就一条，断言恒一 + 无新增语义由 inject 行数锁定）
    const r3 = (await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, text: '问 3' })) as { turnId: string }
    await waitForTurnEnd(env, r3.turnId)
    assert.equal(eventsOf(env).filter((e) => e.kind === 'system' && (e.meta as Record<string, unknown> | null)?.['injection'] === 'memory').length, 1)
  } finally {
    env.svc.closeAll?.()
  }
})

test('S6M-4 预算超限 = fail-visible 同步抛出（禁静默截断，sendTurn 不开 turn）', async () => {
  const env = await makeEnv()
  try {
    // 预算 8000 字符（handle 缺省）——写入超预算正文
    await env.svc.dispatch('memory:write', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, id: 'mem-big', text: '长'.repeat(9000) })
    const before = eventsOf(env).filter((e) => e.kind === 'user' && /^T\d+$/.test(e.turnId)).length
    await assert.rejects(
      () => env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, text: '问', memoryInject: true }),
      /CAR-E-MEM-BUDGET/,
      '超预算 = CAR-E-MEM-BUDGET fail-visible（渲染层红条语义）',
    )
    const after = eventsOf(env).filter((e) => e.kind === 'user' && /^T\d+$/.test(e.turnId)).length
    assert.equal(after, before, 'throw 发生在 user append 前——turn 未开（无半包）')
    // 关开关后同文可发（注入跳过 = 不受预算约束）
    const r = (await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, text: '问（无注入）' })) as { turnId: string }
    await waitForTurnEnd(env, r.turnId)
  } finally {
    env.svc.closeAll?.()
  }
})

// 保持 SessionHandle 引用（类型侧使用防 noUnusedLocals 误报）
void (null as unknown as SessionHandle | null)
