/**
 * T-24 能力库 E2E（D2-S1 / PRD C-1/C-2/C-5；宿主公共 API 驱动，链真跑）
 *
 * 判据：
 *  - 条目 CRUD：.car/capabilities/<id>.json 白盒落盘 + capability/write·edit·delete 叙事落链
 *    （memory CRUD 同款链同源）；id 正则/spec 超限/重复新建 fail-visible；
 *  - 引用/撤销：add/remove 事件落链（meta.injection:'capability'，EventKind 零新增）；撤销 = 补偿
 *    事件（已 add 零改写）；
 *  - turn 装配注入：活跃引用集 → op:'inject' system 事件（spec 文本进 payload，meta.chars =
 *    实际字符数——ctx 行位真值）；注入集不变不重注（dedup）；维护中/已退役条目 meta.warnings 明示；
 *  - 合并预算（C-5）：spec 超 8000 字符 → sendTurn fail-visible（CAR-E-MEM-BUDGET），busy 不残留。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createHostService, type HostService, type PushMessage } from '../src/host-core/service.ts'
import type { CapabilityEntryDTO, SessionEventDTO, SessionEventPush, WorkspaceInfo } from '../src/shared/ipc-contract.ts'
import type { SessionHandle } from '../src/host-core/session-handle.ts'
import type { HostModelStep } from '../src/host-core/types.ts'

function tmpDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `car-t24-${label}-`))
}

interface Env {
  svc: HostService
  ws: WorkspaceInfo
  sess: { sessionId: string }
  root: string
  pushes: PushMessage[]
}

function echoModel(): (h: SessionHandle) => () => Promise<HostModelStep> {
  return (h: SessionHandle) => async () => {
    const text = `echo:${h.currentTurnId()}`
    h.log.append('model', 'assistant', h.currentTurnId(), text)
    return { stopReason: 'stop', text, secretsRedacted: 0 as const }
  }
}

async function makeEnv(): Promise<Env> {
  const userData = tmpDir('ud')
  const root = tmpDir('ws')
  writeFileSync(join(root, 'car.config.ts'), "export default { llm: { baseUrl: 'http://127.0.0.1:9', model: 'test-model' } }\n", 'utf8')
  const svc = createHostService({ userDataDir: userData, modelFnOverride: echoModel() })
  const pushes: PushMessage[] = []
  svc.onPush((m) => pushes.push(m))
  const ws = (await svc.dispatch('workspace:register', { path: root })) as WorkspaceInfo
  const sess = (await svc.dispatch('session:create', { workspaceId: ws.id })) as { sessionId: string }
  return { svc, ws, sess, root, pushes }
}

function eventsOf(env: Env): SessionEventDTO[] {
  return env.pushes.filter((m) => m.topic === 'push:session-event').map((m) => (m.payload as SessionEventPush).event)
}

async function waitForTurnEnd(env: Env, turnId: string, timeoutMs = 6000): Promise<SessionEventDTO> {
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

async function writeEntry(env: Env, spec: string, status = 'active', id = 'code-review'): Promise<CapabilityEntryDTO> {
  return (await env.svc.dispatch('capability:write', {
    workspaceId: env.ws.id,
    sessionId: env.sess.sessionId,
    entry: { id, kind: 'skill', name: '代码评审规范', spec, status },
  })) as CapabilityEntryDTO
}

const SPEC = '# 评审规范\n\n提交前必须跑测试；禁止 any。'

test('T24-1 条目 CRUD：白盒落盘 + 叙事落链 + id/超限/重复 fail-visible', async () => {
  const env = await makeEnv()
  try {
    const entry = await writeEntry(env, SPEC)
    assert.equal(entry.id, 'code-review')
    assert.equal(entry.status, 'active')
    const file = join(env.root, '.car', 'capabilities', 'code-review.json')
    assert.ok(existsSync(file), '白盒文件在位（.car/capabilities/）')
    // 链上叙事（memory CRUD 同款 payload.type 四态先例）
    const writeEv = eventsOf(env).find((e) => e.kind === 'system' && (e.payload as Record<string, unknown> | null)?.['type'] === 'capability/write')
    assert.ok(writeEv, 'capability/write 叙事落链')
    assert.equal((writeEv!.payload as Record<string, unknown>)['id'], 'code-review')
    // 重复新建 fail-visible
    await assert.rejects(() => writeEntry(env, SPEC), (err: Error) => /已存在/.test(err.message))
    // 非法 id fail-visible
    await assert.rejects(
      () => env.svc.dispatch('capability:write', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, entry: { id: '../evil', kind: 'skill', name: 'x', spec: 'y' } }),
      (err: Error) => /id 非法|路径/.test(err.message),
    )
    // spec 超限 fail-visible（> 20,000）
    await assert.rejects(
      () => env.svc.dispatch('capability:write', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, entry: { id: 'big', kind: 'kb', name: 'x', spec: 'a'.repeat(20_001) } }),
      (err: Error) => /超限/.test(err.message),
    )
    // 编辑（patch 合并 + updatedAt 收敛）
    const edited = (await env.svc.dispatch('capability:edit', {
      workspaceId: env.ws.id,
      sessionId: env.sess.sessionId,
      id: 'code-review',
      patch: { status: 'maintain' },
    })) as CapabilityEntryDTO
    assert.equal(edited.status, 'maintain')
    assert.ok(eventsOf(env).some((e) => (e.payload as Record<string, unknown> | null)?.['type'] === 'capability/edit'), 'capability/edit 叙事落链')
    // 删除（文件移除 + 叙事；JSONL 审计面不改写）
    await env.svc.dispatch('capability:delete', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, id: 'code-review' })
    assert.ok(!existsSync(file), '条目文件已移除')
    assert.ok(eventsOf(env).some((e) => (e.payload as Record<string, unknown> | null)?.['type'] === 'capability/delete'), 'capability/delete 叙事落链')
  } finally {
    env.svc.closeAll?.()
  }
})

test('T24-2 引用→注入→ctx 真值三点一致 + dedup + 维护中明示', async () => {
  const env = await makeEnv()
  try {
    await writeEntry(env, SPEC, 'maintain')
    await env.svc.dispatch('capability:ref-add', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, refId: 'code-review' })
    // add 事件落链（EventKind 零新增——system kind + meta.injection）
    const addEv = eventsOf(env).find((e) => e.kind === 'system' && (e.meta as Record<string, unknown> | null)?.['injection'] === 'capability')
    assert.ok(addEv)
    assert.equal((addEv!.meta as Record<string, unknown>)['op'], 'add')
    assert.equal((addEv!.meta as Record<string, unknown>)['refId'], 'code-review')
    // turn 装配注入：inject 事件 + spec 文本进 payload + 维护中 warnings 明示
    const t1 = await sendTurn(env, '第一问')
    await waitForTurnEnd(env, t1)
    const inject = eventsOf(env).find((e) => e.kind === 'system' && (e.meta as Record<string, unknown> | null)?.['injection'] === 'capability' && (e.meta as Record<string, unknown>)['op'] === 'inject')
    assert.ok(inject, 'inject 事件落链（turn 装配）')
    assert.ok(String(inject!.payload).includes('评审规范'), 'spec 文本进注入物')
    assert.ok(String(inject!.payload).includes('维护中'), '维护中标签明示（禁静默注入）')
    const meta = inject!.meta as Record<string, unknown>
    assert.equal(meta['chars'], String(inject!.payload).length, 'meta.chars = 实际字符数（ctx 行位真值）')
    assert.ok(Array.isArray(meta['warnings']) && (meta['warnings'] as string[]).length === 1, 'warnings 随注入行出面')
    // dedup：注入集不变 → 第二 turn 不重注
    const injectCount = eventsOf(env).filter((e) => (e.meta as Record<string, unknown> | null)?.['op'] === 'inject').length
    const t2 = await sendTurn(env, '第二问')
    await waitForTurnEnd(env, t2)
    assert.equal(eventsOf(env).filter((e) => (e.meta as Record<string, unknown> | null)?.['op'] === 'inject').length, injectCount, '注入集不变不重注')
    // 撤销 = remove 补偿事件（add 不改写）+ 下一 turn 无新注入
    await env.svc.dispatch('capability:ref-remove', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, refId: 'code-review' })
    const removeEv = eventsOf(env).filter((e) => (e.meta as Record<string, unknown> | null)?.['injection'] === 'capability').at(-1)!
    assert.equal((removeEv.meta as Record<string, unknown>)['op'], 'remove')
    assert.equal((removeEv.meta as Record<string, unknown>)['refId'], 'code-review')
    const t3 = await sendTurn(env, '第三问')
    await waitForTurnEnd(env, t3)
    const lastInject = eventsOf(env).filter((e) => (e.meta as Record<string, unknown> | null)?.['op'] === 'inject').at(-1)!
    assert.ok(lastInject.seq < removeEv.seq, '撤销后下一 turn 无新注入（不再注入）')
    // 链完整
    const report = (await env.svc.dispatch('audit:report', { workspaceId: env.ws.id, sessionId: env.sess.sessionId })) as { chain: { intact: boolean } }
    assert.equal(report.chain.intact, true, '引用/撤销/注入后链完整（只追加不改写）')
  } finally {
    env.svc.closeAll?.()
  }
})

test('T24-3 合并预算（C-5）：spec 超 8000 → sendTurn fail-visible 且 busy 不残留', async () => {
  const env = await makeEnv()
  try {
    await writeEntry(env, 'a'.repeat(8_001), 'active', 'huge-spec')
    await env.svc.dispatch('capability:ref-add', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, refId: 'huge-spec' })
    await assert.rejects(
      () => sendTurn(env, '超预算的一轮'),
      (err: Error) => /CAR-E-MEM-BUDGET|合并预算/.test(err.message),
      '超合并预算 fail-visible（禁静默截断）',
    )
    // busy 不残留：撤销引用后可正常发送（throw 时 turn 未开——S6M-4 死锁形态回归）
    await env.svc.dispatch('capability:ref-remove', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, refId: 'huge-spec' })
    const t = await sendTurn(env, '恢复后的一轮')
    await waitForTurnEnd(env, t)
  } finally {
    env.svc.closeAll?.()
  }
})

test('T24-4 条目清单面：损坏条目跳过留痕（fail-visible 显性化，不阻塞列表）', async () => {
  const env = await makeEnv()
  try {
    await writeEntry(env, SPEC)
    writeFileSync(join(env.root, '.car', 'capabilities', 'broken.json'), '{ not json', 'utf8')
    const r = (await env.svc.dispatch('capability:list', { workspaceId: env.ws.id })) as { entries: CapabilityEntryDTO[]; warnings: string[] }
    assert.equal(r.entries.length, 1, '好条目正常列出')
    assert.equal(r.entries[0]!.id, 'code-review')
    assert.equal(r.warnings.length, 1, '损坏条目警告显性化')
    assert.ok(r.warnings[0]!.includes('broken.json'))
  } finally {
    env.svc.closeAll?.()
  }
})
