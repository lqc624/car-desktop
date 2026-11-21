/**
 * z15 · 0.15.0 Z-1 延伸（D-Z15-1~6，谱系面板 + 分支对比）
 *
 * 判据：
 *  - buildLineage 纯函数：forkedFrom 构树（多层 + 同层时间序）/ R-1 孤儿提升为根如实标注；
 *  - pickComparePair：同父 ok / 异父 fail（确定性原因文案）/ 非分叉会话 fail；
 *  - alignBranches：公共前缀折叠（min(upTo) 内对话件）+ 同题不同答 aligned 并排 +
 *    改问法错位段如实标注不硬拼（R-4）；零 LLM 确定性；
 *  - forkPointFromEvents：fork-in 标记（payload.type='branch' 判别）提取 / 无标记 null /
 *    跨宿主形态（无 type 字段）跳过；
 *  - E2E（宿主 dispatch）：0.13 分叉构造 → session:list 透传 forkedFrom（D-Z15-2）→
 *    子链 open events 提取分叉点 = 所选边界 seq（D-Z15-3）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { SessionEventDTO, SessionInfo } from '../src/shared/ipc-contract.ts'
import { buildLineage, forkPointFromEvents, pickComparePair } from '../src/renderer/lineage.ts'
import { alignBranches } from '../src/renderer/branch-diff.ts'
import { createHostService, type HostService, type PushMessage } from '../src/host-core/service.ts'
import type { SessionHandle } from '../src/host-core/session-handle.ts'
import type { HostModelStep, WorkspaceInfo } from '../src/host-core/types.ts'

function tmpDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `car-z15-${label}-`))
}

function info(sid: string, opts?: { forkedFrom?: string | null; createdAt?: number; title?: string }): SessionInfo {
  return {
    sessionId: sid,
    workspaceId: 'ws',
    createdAt: opts?.createdAt ?? 1000,
    eventCount: 1,
    title: opts?.title ?? sid,
    ...(opts?.forkedFrom ? { forkedFrom: opts.forkedFrom } : {}),
  }
}

function ev(seq: number, kind: 'user' | 'assistant' | 'fork', payload: unknown): SessionEventDTO {
  return { seq, ts: 1000 + seq, actor: kind === 'fork' ? 'runtime' : kind === 'user' ? 'user' : 'model', kind, turnId: 'T1', payload, prevHash: 'p', hash: 'h' + seq }
}

test('L15-1 buildLineage：多层谱系构树 + 同层时间序 + 普通会话为根', () => {
  // 父 1000 → 子A 2000/子B 3000 → 孙 4000；根另有一条普通会话 1500
  const sessions = [
    info('S-父', { createdAt: 1000 }),
    info('S-子B', { createdAt: 3000, forkedFrom: 'S-父' }),
    info('S-子A', { createdAt: 2000, forkedFrom: 'S-父' }),
    info('S-孙', { createdAt: 4000, forkedFrom: 'S-子A' }),
    info('S-普通', { createdAt: 1500 }),
  ]
  const roots = buildLineage(sessions)
  const byId = new Map(roots.map((n) => [n.session.sessionId, n]))
  assert.equal(roots.length, 2, '两个根：S-父 与 S-普通（未分叉会话）')
  const father = byId.get('S-父')!
  assert.ok(father, 'S-父为根')
  assert.equal(father.children.length, 2, '两个子分支')
  assert.deepEqual(father.children.map((c) => c.session.sessionId), ['S-子A', 'S-子B'], '同层按创建时间升序')
  assert.equal(father.children[0]!.children[0]!.session.sessionId, 'S-孙', '孙节点挂子节点')
  assert.equal(byId.get('S-普通')!.children.length, 0)
  for (const n of roots) assert.equal(n.orphaned, false, '根节点非孤儿')
})

test('L15-2 buildLineage：forkedFrom 指向已删会话 → 孤儿提升为根（R-1）', () => {
  const sessions = [
    info('S-幸存', { createdAt: 1000 }),
    info('S-孤儿', { createdAt: 2000, forkedFrom: 'S-已删' }),
  ]
  const roots = buildLineage(sessions)
  assert.equal(roots.length, 2, '孤儿提升为根（索引 deletedWithParent 级联删除是既有行为——谱系如实呈现）')
  const orphan = roots.find((n) => n.session.sessionId === 'S-孤儿')!
  assert.ok(orphan, '孤儿节点在根层')
  assert.equal(orphan.orphaned, true, 'orphaned 标注')
})

test('L15-3 pickComparePair：同父 ok / 异父与普通会话 fail 带确定性原因', () => {
  const ok = pickComparePair(info('S-A', { forkedFrom: 'S-父' }), info('S-B', { forkedFrom: 'S-父' }))
  assert.deepEqual(ok, { ok: true, parentId: 'S-父' })
  const cross = pickComparePair(info('S-A', { forkedFrom: 'S-父1' }), info('S-B', { forkedFrom: 'S-父2' }))
  assert.equal(cross.ok, false)
  assert.ok(!cross.ok && cross.reason.includes('不同源'), '异父给确定性原因（跨层对比不做——负面清单）')
  const plain = pickComparePair(info('S-A', { forkedFrom: 'S-父' }), info('S-普通'))
  assert.equal(plain.ok, false)
  assert.ok(!plain.ok && plain.reason.includes('仅限分叉出的子会话'))
})

test('L15-4 alignBranches：公共前缀折叠 + 同题不同答 aligned 并排（零 LLM）', () => {
  // 公共前缀（分叉点前）：user「问题一」+ assistant「答一」；两支各自续「问题二」同锚点、答不同
  const mk = (a2: string, b2: string, seqBase: number) => ({
    events: [
      ev(0, 'user', '问题一'),
      ev(1, 'assistant', '答一'),
      ev(2, 'user', '问题二'),
      ev(3, 'assistant', a2),
      ev(4, 'fork', { type: 'branch', fromSessionId: 'S-父', upToSeq: seqBase, fromTailHash: 'x' }),
      ev(5, 'assistant', '尾件'),
    ],
    forkUpToSeq: seqBase,
  })
  const a = mk('方案A', 'x', 2)
  const b = { events: [ev(0, 'user', '问题一'), ev(1, 'assistant', '答一'), ev(2, 'user', '问题二'), ev(3, 'assistant', '方案B')], forkUpToSeq: 2 }
  const d = alignBranches(a, b)
  assert.equal(d.commonPrefixCount, 2, '公共前缀 = min(upTo) 内对话件（user+assistant）')
  assert.deepEqual(d.commonPrefixUsers, ['问题一'])
  assert.equal(d.segments.length, 1)
  const seg = d.segments[0]!
  assert.equal(seg.kind, 'aligned')
  assert.equal(seg.userText, '问题二')
  assert.deepEqual(seg.aItems.map((i) => i.text), ['方案A', '尾件'], '锚点后 assistant 归段（含边界外尾件）')
  assert.deepEqual(seg.bItems.map((i) => i.text), ['方案B'])
})

test('L15-5 alignBranches：改问法错位段如实标注不硬拼（R-4）', () => {
  // A 支改问法：user「问题二改」；B 支保持「问题二」——锚点不匹配 = 双独立段
  const a = {
    events: [ev(0, 'user', '问题一'), ev(1, 'user', '问题二改'), ev(2, 'assistant', '答改'), ev(3, 'user', '问题三'), ev(4, 'assistant', '答三')],
    forkUpToSeq: 1,
  }
  const b = {
    events: [ev(0, 'user', '问题一'), ev(1, 'user', '问题二'), ev(2, 'assistant', '答二'), ev(3, 'user', '问题三'), ev(4, 'assistant', '答三')],
    forkUpToSeq: 1,
  }
  const d = alignBranches(a, b)
  assert.equal(d.commonPrefixCount, 1)
  assert.equal(d.segments.length, 3, '错位段独立 + 后续同锚点段重新对齐（lookahead-1 贪心）')
  assert.equal(d.segments[0]!.kind, 'a-only')
  assert.equal(d.segments[0]!.userText, '问题二改')
  assert.equal(d.segments[1]!.kind, 'b-only')
  assert.equal(d.segments[1]!.userText, '问题二')
  assert.equal(d.segments[2]!.kind, 'aligned')
  assert.equal(d.segments[2]!.userText, '问题三')
  assert.deepEqual(d.segments[2]!.aItems.map((i) => i.text), ['答三'])
  assert.deepEqual(d.segments[2]!.bItems.map((i) => i.text), ['答三'])
})

test('L15-6 forkPointFromEvents：branch 标记提取 / 无标记 null / 跨宿主形态跳过', () => {
  const p = forkPointFromEvents([
    ev(0, 'user', 'x'),
    ev(1, 'fork', { type: 'branch', fromSessionId: 'S-父', upToSeq: 7, fromTailHash: 'h' }),
  ])
  assert.deepEqual(p, { upToSeq: 7, fromSessionId: 'S-父' })
  assert.equal(forkPointFromEvents([ev(0, 'user', 'x')]), null, '无标记 = 普通会话')
  assert.equal(forkPointFromEvents([ev(1, 'fork', { fromSessionId: 'S-父', upToSeq: 7 })]), null, '跨宿主 forkCrossHost 形态（无 type 字段）跳过')
})

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
          return { stopReason: 'stop', text: '答：' + h.currentTurnId() }
        }
        return { stopReason: 'stop', text: 'done' }
      }
    },
  })
  const pushes: PushMessage[] = []
  svc.onPush((m) => pushes.push(m))
  const ws = (await svc.dispatch('workspace:register', { path: root })) as WorkspaceInfo
  const sess = (await svc.dispatch('session:create', { workspaceId: ws.id })) as { sessionId: string }
  return { svc, ws, sess, root, pushes }
}

async function send(env: Env, text: string): Promise<string> {
  const r = (await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, text })) as { turnId: string }
  return r.turnId
}

async function waitForTurnEnd(env: Env, turnId: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const r = (await env.svc.dispatch('audit:report', { workspaceId: env.ws.id, sessionId: env.sess.sessionId })) as { events: SessionEventDTO[] }
    if (r.events.some((e) => e.kind === 'turnEnd' && e.turnId === turnId)) return
    if (Date.now() > deadline) throw new Error(`waitForTurnEnd 超时（${turnId}）`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

test('L15-7 E2E：分叉构造 → session:list 透传 forkedFrom（D-Z15-2）→ 子链分叉点提取（D-Z15-3）', async () => {
  const env = await makeEnv()
  const t1 = await send(env, '问题一')
  await waitForTurnEnd(env, t1)
  const t2 = await send(env, '问题二')
  await waitForTurnEnd(env, t2)
  // 边界 = 「问题二」user 事件 seq（0.13 消息行入口同款构造）
  const parent = (await env.svc.dispatch('session:open', { workspaceId: env.ws.id, sessionId: env.sess.sessionId })) as { events: SessionEventDTO[] }
  const t2User = parent.events.find((e) => e.kind === 'user' && e.payload === '问题二')
  assert.ok(t2User, '源链含问题二 user 事件')
  const r = (await env.svc.dispatch('session:fork', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, upToSeq: t2User!.seq })) as { childSessionId: string }
  // D-Z15-2：session:list 透传 forkedFrom（索引镜像）——谱系面板构树数据源
  const list = (await env.svc.dispatch('session:list', { workspaceId: env.ws.id })) as SessionInfo[]
  const parentInfo = list.find((s) => s.sessionId === env.sess.sessionId)
  const childInfo = list.find((s) => s.sessionId === r.childSessionId)
  assert.ok(parentInfo && childInfo, '列表含父与子')
  assert.equal(childInfo!.forkedFrom, env.sess.sessionId, '子会话 forkedFrom 透传')
  assert.ok(!parentInfo!.forkedFrom, '普通会话无 forkedFrom（缺省 = 无键）')
  assert.ok(childInfo!.title!.endsWith(' ⎇'), '谱系后缀在 title（0.13 既有）')
  // D-Z15-3：子链 open events → forkPointFromEvents 提取 = 所选边界 seq
  const child = (await env.svc.dispatch('session:open', { workspaceId: env.ws.id, sessionId: r.childSessionId })) as { events: SessionEventDTO[] }
  const fp = forkPointFromEvents(child.events)
  assert.deepEqual(fp, { upToSeq: t2User!.seq, fromSessionId: env.sess.sessionId }, '分叉点 = fork-in 标记真值')
  // D-Z15-4 输入面：同父两支构造（父链后续再分一叉）→ pickComparePair ok
  const t3 = await send(env, '父链新问题')
  await waitForTurnEnd(env, t3)
  const parent2 = (await env.svc.dispatch('session:open', { workspaceId: env.ws.id, sessionId: env.sess.sessionId })) as { events: SessionEventDTO[] }
  const t3User = parent2.events.find((e) => e.kind === 'user' && e.payload === '父链新问题')
  const r2 = (await env.svc.dispatch('session:fork', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, upToSeq: t3User!.seq })) as { childSessionId: string }
  const list2 = (await env.svc.dispatch('session:list', { workspaceId: env.ws.id })) as SessionInfo[]
  const pair = pickComparePair(
    list2.find((s) => s.sessionId === r.childSessionId)!,
    list2.find((s) => s.sessionId === r2.childSessionId)!,
  )
  assert.ok(pair.ok && pair.parentId === env.sess.sessionId, '同父两支校验通过——对比入口可用')
})
