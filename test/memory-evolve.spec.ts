/**
 * T-ME 记忆进化 E2E（宿主公共 API 驱动；LLM 直调 = 真 chatStep 经 loopback SSE——s5 同款装配）
 *
 * 判据：
 *  - 全链：memory/evolution 落链（pressure 确定性派生 + candidates 已脱敏 + usage 无事实省键）
 *    + 批准落盘走内核 MemoryStore（kind='memory' 事件）+ memory/evolution-apply/reject 叙事；
 *  - 解析容错（code fence）与非法候选剔除（未知 targetId dropped；零有效 fail-visible）；
 *  - fail-visible：ghost 会话 / 空记忆；
 *  - auto：mode=auto 回合收口压力 ≥70% 自动发起（低于阈值不触发）；
 *  - 复核超时：auto 候选注入短超时 → 未决自动 reject（reason=review-timeout——timeout-default-deny 同语义）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { test } from 'node:test'
import { createHostService, type HostService, type PushMessage } from '../src/host-core/service.ts'
import type { MemoryEntryDTO, MemoryEvolveResultDTO, SessionEventDTO, SessionEventPush, WorkspaceInfo } from '../src/shared/ipc-contract.ts'

function tmpDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `car-me-${label}-`))
}

async function startSseServer(text: string): Promise<{ server: Server; port: number }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(
      `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n` +
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n` +
        'data: [DONE]\n\n',
    )
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { server, port: (server.address() as { port: number }).port }
}

interface Env {
  svc: HostService
  ws: WorkspaceInfo
  sess: { sessionId: string }
  root: string
  pushes: PushMessage[]
}

async function makeEnv(sseText: string, opts: { reviewTimeoutMs?: number } = {}): Promise<Env & { server: Server }> {
  const { server, port } = await startSseServer(sseText)
  const userData = tmpDir('ud')
  const root = tmpDir('ws')
  writeFileSync(
    join(root, 'car.config.ts'),
    `export default { llm: { baseUrl: 'http://127.0.0.1:9', model: 'test-model' }, ` +
      `modelPool: { endpoints: [{ id: 'live-ep', baseUrl: 'http://127.0.0.1:${port}', model: 'm-live', keyEnv: 'CAR_ME_KEY' }], probe: { enabled: false } } }\n`,
    'utf8',
  )
  const prevKey = process.env.CAR_ME_KEY
  process.env.CAR_ME_KEY = 'sk-me-loopback-test' // secrets-scan:allow dummy loopback endpoint credential (fixture, not a real key)
  const svc = createHostService({ userDataDir: userData, memoryEvolveReviewTimeoutMs: opts.reviewTimeoutMs })
  const pushes: PushMessage[] = []
  svc.onPush((m) => pushes.push(m))
  const ws = (await svc.dispatch('workspace:register', { path: root })) as WorkspaceInfo
  const sess = (await svc.dispatch('session:create', { workspaceId: ws.id })) as { sessionId: string }
  const env: Env & { server: Server } = { svc, ws, sess, root, pushes, server }
  ;(env as Env & { server: Server } & { __cleanup: () => Promise<void> }).__cleanup = async () => {
    if (prevKey === undefined) delete process.env.CAR_ME_KEY
    else process.env.CAR_ME_KEY = prevKey
    svc.dispose()
    await new Promise<void>((r) => server.close(() => r()))
  }
  return env
}

/** 统一收口（环境变量恢复 + 计时器/子进程收口 + SSE server 关闭） */
async function cleanup(env: Env & { server: Server }): Promise<void> {
  await (env as Env & { server: Server } & { __cleanup: () => Promise<void> }).__cleanup()
}

function eventsOf(env: Env): SessionEventDTO[] {
  return env.pushes.filter((m) => m.topic === 'push:session-event').map((m) => (m.payload as SessionEventPush).event)
}

function narr(env: Env, type: string): Array<Record<string, unknown>> {
  return eventsOf(env)
    .filter((e) => e.kind === 'system' && (e.payload as Record<string, unknown> | null)?.['type'] === type)
    .map((e) => e.payload as Record<string, unknown>)
}

async function writeMemory(env: Env, id: string, text: string): Promise<void> {
  await env.svc.dispatch('memory:write', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, id, text })
}

const CANDIDATES_OK = JSON.stringify([
  { op: 'update', targetId: 'm-1', text: 'm-1 更新后正文', reason: '表述过时' },
  { op: 'add', text: '新增条目正文', tags: ['琐碎'], reason: '补缺口' },
  { op: 'delete', targetId: 'm-2', reason: '与 m-1 重复' },
  { op: 'update', targetId: 'm-ghost', text: '非法目标', reason: 'targetId 不在册' },
])

test('ME-1 全链：evolve 直调 → 候选落链（非法剔除）→ 批准落盘（kind=memory）→ 拒绝 feedback 留痕', async () => {
  const env = await makeEnv(CANDIDATES_OK)
  try {
    await writeMemory(env, 'm-1', 'm-1 原始正文')
    await writeMemory(env, 'm-2', 'm-1 原始正文（重复）')
    await writeMemory(env, 'm-3', 'm-3 独立记忆')
    const r = (await env.svc.dispatch('memory:evolve', { workspaceId: env.ws.id, sessionId: env.sess.sessionId })) as MemoryEvolveResultDTO
    assert.match(r.runId, /^EV-/)
    assert.equal(r.auto, false)
    assert.equal(r.logged, true)
    assert.equal(r.candidates.length, 3, '未知 targetId 被剔除')
    assert.ok(r.candidates.every((c) => c.cid), 'cid 宿主分配（C1..Cn）')
    assert.ok(r.pressure.chars > 0 && r.pressure.pct > 0, '压力 = 确定性派生')
    assert.equal(r.usage, undefined, 'SSE 无 usage 帧 = 省键（禁估算）')
    // 落链：memory/evolution 叙事（candidates/pressure/dropped 随链）
    const run = narr(env, 'memory/evolution').at(-1)!
    assert.equal(run['runId'], r.runId)
    assert.equal(run['dropped'], 1)
    assert.deepEqual(run['pressure'], r.pressure)
    // 批准 update C1 → MemoryStore 落盘 + kind='memory' edit 事件 + apply 叙事
    const d1 = (await env.svc.dispatch('memory:evolve-decide', {
      workspaceId: env.ws.id, sessionId: env.sess.sessionId, runId: r.runId, cid: 'C1', approve: true,
    })) as { ok: boolean; op: string; memoryId?: string }
    assert.equal(d1.op, 'update')
    assert.equal(d1.memoryId, 'm-1')
    const list1 = (await env.svc.dispatch('memory:list', { workspaceId: env.ws.id })) as MemoryEntryDTO[]
    assert.ok(list1.find((m) => m.id === 'm-1')!.text.includes('更新后正文'))
    const editEv = eventsOf(env).find((e) => e.kind === 'memory' && (e.payload as Record<string, unknown>)['type'] === 'edit')
    assert.ok(editEv, '批准落盘 = kind=memory edit 事件（内核 MemoryStore 落链）')
    assert.equal(narr(env, 'memory/evolution-apply').at(-1)!['cid'], 'C1')
    // 批准 add C2 → 列表 +1
    await env.svc.dispatch('memory:evolve-decide', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, runId: r.runId, cid: 'C2', approve: true })
    const list2 = (await env.svc.dispatch('memory:list', { workspaceId: env.ws.id })) as MemoryEntryDTO[]
    assert.equal(list2.length, 4)
    // 拒绝 delete C3（feedback 留痕）→ store 不变
    await env.svc.dispatch('memory:evolve-decide', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, runId: r.runId, cid: 'C3', approve: false, feedback: '还有用，先留着' })
    const list3 = (await env.svc.dispatch('memory:list', { workspaceId: env.ws.id })) as MemoryEntryDTO[]
    assert.equal(list3.length, 4, '拒绝零落盘')
    const rej = narr(env, 'memory/evolution-reject').at(-1)!
    assert.equal(rej['cid'], 'C3')
    assert.equal(rej['feedback'], '还有用，先留着')
    // 已决幂等：重复裁决 fail-visible
    await assert.rejects(
      () => env.svc.dispatch('memory:evolve-decide', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, runId: r.runId, cid: 'C1', approve: true }),
      (e: Error) => /已决/.test(e.message),
    )
  } finally {
    await cleanup(env)
  }
})

test('ME-2 解析容错：code fence 包裹的 JSON 数组可解析', async () => {
  const fenced = '好的，以下是建议：\n```json\n' + JSON.stringify([{ op: 'add', text: '围栏内候选', reason: 'r' }]) + '\n```\n以上。'
  const env = await makeEnv(fenced)
  try {
    await writeMemory(env, 'm-1', '基线')
    const r = (await env.svc.dispatch('memory:evolve', { workspaceId: env.ws.id, sessionId: env.sess.sessionId })) as MemoryEvolveResultDTO
    assert.equal(r.candidates.length, 1)
    assert.equal(r.candidates[0]!.text, '围栏内候选')
  } finally {
    await cleanup(env)
  }
})

test('ME-3 fail-visible：ghost 会话 / 空记忆 / 零有效候选', async () => {
  const env = await makeEnv(CANDIDATES_OK)
  try {
    await assert.rejects(
      () => env.svc.dispatch('memory:evolve', { workspaceId: env.ws.id, sessionId: 'ghost' }),
      (e: Error) => /会话不可续写/.test(e.message),
    )
    await assert.rejects(
      () => env.svc.dispatch('memory:evolve', { workspaceId: env.ws.id, sessionId: env.sess.sessionId }),
      (e: Error) => /记忆为空/.test(e.message),
      '空记忆 fail-visible',
    )
  } finally {
    await cleanup(env)
  }
  // 零有效候选（全非法 → 剔除后为空 = fail-visible，禁静默半应用）
  const env2 = await makeEnv(JSON.stringify([{ op: 'update', targetId: 'nope', text: 'x', reason: 'r' }]))
  try {
    await env2.svc.dispatch('memory:write', { workspaceId: env2.ws.id, sessionId: env2.sess.sessionId, id: 'm-1', text: '基线' })
    await assert.rejects(
      () => env2.svc.dispatch('memory:evolve', { workspaceId: env2.ws.id, sessionId: env2.sess.sessionId }),
      (e: Error) => /候选解析为空/.test(e.message),
    )
  } finally {
    await cleanup(env2)
  }
})

const BIG_TEXT = 'x'.repeat(8000)

test('ME-4 auto：mode=auto 回合收口压力 ≥70% 自动发起（低于阈值不触发）', async () => {
  const env = await makeEnv(CANDIDATES_OK)
  try {
    await writeMemory(env, 'm-1', BIG_TEXT)
    await writeMemory(env, 'm-2', BIG_TEXT)
    await writeMemory(env, 'm-3', BIG_TEXT)
    await env.svc.dispatch('memory:evolve-mode', { workspaceId: env.ws.id, mode: 'auto' })
    const t = (await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, text: 'hi' })) as { turnId: string }
    const deadline = Date.now() + 8000
    for (;;) {
      const run = narr(env, 'memory/evolution').find((p) => p['auto'] === true)
      if (run) {
        assert.equal((run['candidates'] as unknown[]).length, 3)
        break
      }
      if (Date.now() > deadline) throw new Error('等待 auto 进化运行超时')
      await new Promise((r) => setTimeout(r, 25))
    }
    await env.svc.dispatch('turn:abort', { workspaceId: env.ws.id, sessionId: env.sess.sessionId }).catch(() => {})
    void t
  } finally {
    await cleanup(env)
  }
})

test('ME-5 auto 低于阈值不触发 + ME-6 复核超时自动放弃（review-timeout）', async () => {
  const env = await makeEnv(CANDIDATES_OK, { reviewTimeoutMs: 150 })
  try {
    // 低于阈值（1 条 8000 字符 = 25%）不触发
    await writeMemory(env, 'm-1', BIG_TEXT)
    await env.svc.dispatch('memory:evolve-mode', { workspaceId: env.ws.id, mode: 'auto' })
    await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, text: 'hi' })
    await new Promise((r) => setTimeout(r, 1200))
    assert.equal(narr(env, 'memory/evolution').filter((p) => p['auto'] === true).length, 0, '低于阈值零自动运行')
    // 补到 ≥70%（3 条 24k）→ 手动运行（立即触发，不等收口）→ 150ms 未复核 → 全部自动放弃
    await writeMemory(env, 'm-2', BIG_TEXT)
    await writeMemory(env, 'm-3', BIG_TEXT)
    // 手动运行无超时——改用 auto 触发（再收一轮 turn）
    await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, text: 'hi2' })
    const run = await (async () => {
      const deadline = Date.now() + 8000
      for (;;) {
        const r = narr(env, 'memory/evolution').filter((p) => p['auto'] === true).at(-1)
        if (r) return r
        if (Date.now() > deadline) throw new Error('等待第二次 auto 运行超时')
        await new Promise((r) => setTimeout(r, 25))
      }
    })()
    const runId = String(run['runId'])
    const deadline = Date.now() + 3000
    for (;;) {
      const rejects = narr(env, 'memory/evolution-reject').filter((p) => p['runId'] === runId)
      if (rejects.length >= 3) {
        assert.ok(rejects.every((p) => p['reason'] === 'review-timeout'), '未决候选全部 reason=review-timeout')
        break
      }
      if (Date.now() > deadline) throw new Error(`等待复核超时放弃（${rejects.length}/3）`)
      await new Promise((r) => setTimeout(r, 25))
    }
  } finally {
    await cleanup(env)
  }
})
