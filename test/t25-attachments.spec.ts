/**
 * T-25 附件注入 E2E（D2-S2 / PRD C-3/C-5/D-C6；宿主公共 API 驱动，链真跑）
 *
 * 判据：
 *  - 双形态分流：文本类 ≤200KB = fulltext（turn 装配全文注入）；二进制/超大 = path-ref
 *    （不注入内容——fs_read 按需读取走授权门）；file/attach 叙事恒落链（append-only）；
 *  - 工作区外路径 = fallback-outside 硬拒落链（与 fs_read 同口径）；
 *  - 注入真值（D-C6）：meta.chars = 实际读取字符数（禁硬编码估算表）；
 *  - 撤销 = file/attach-remove 补偿事件（未注入的不再注入）；dedup（同路径不重注）；
 *  - 合并预算（C-5）：fulltext 超 8000 字符 → sendTurn fail-visible，busy 不残留。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createHostService, type HostService, type PushMessage } from '../src/host-core/service.ts'
import type { AttachmentRowDTO, SessionEventDTO, SessionEventPush, WorkspaceInfo } from '../src/shared/ipc-contract.ts'
import type { SessionHandle } from '../src/host-core/session-handle.ts'
import type { HostModelStep } from '../src/host-core/types.ts'

function tmpDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `car-t25-${label}-`))
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

async function attach(env: Env, ...paths: string[]): Promise<AttachmentRowDTO[]> {
  return (await env.svc.dispatch('attachment:add', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, paths })) as AttachmentRowDTO[]
}

test('T25-1 双形态分流：文本全文 / 二进制·超大路径登记 + file/attach 恒落链', async () => {
  const env = await makeEnv()
  try {
    const txt = join(env.root, 'notes.txt')
    const bin = join(env.root, 'data.bin')
    const big = join(env.root, 'big.txt')
    writeFileSync(txt, 'hello attachment', 'utf8')
    writeFileSync(bin, Buffer.from([0, 1, 2, 3, 255]))
    writeFileSync(big, 'x'.repeat(200 * 1024 + 1), 'utf8')
    const rows = await attach(env, txt, bin, big)
    assert.deepEqual(rows.map((r) => r.mode), ['fulltext', 'path-ref', 'path-ref'], '文本 ≤200KB 全文；二进制/超大路径登记')
    assert.equal(rows[0]!.mime, 'text/plain')
    assert.equal(rows[1]!.mime, 'application/octet-stream')
    // file/attach 叙事恒落链（含路径登记形态）
    const attachEvents = eventsOf(env).filter((e) => (e.payload as Record<string, unknown> | null)?.['type'] === 'file/attach')
    assert.equal(attachEvents.length, 3)
    assert.equal((attachEvents[0]!.payload as Record<string, unknown>)['size'], 16, 'size = 实际文件大小')
    // 工作区外路径硬拒落链（与 fs_read 同口径）
    const outside = tmpDir('outside')
    const outsideFile = join(outside, 'o.txt')
    writeFileSync(outsideFile, 'outside', 'utf8')
    await assert.rejects(
      () => attach(env, outsideFile),
      (err: Error) => /安全规则拒绝|工作区外/.test(err.message),
      '工作区外 = fallback-outside 硬拒（PRD C-3）',
    )
    assert.ok(!eventsOf(env).some((e) => (e.payload as Record<string, unknown> | null)?.['type'] === 'file/attach' && (e.payload as Record<string, unknown>)['path'] === outsideFile), '被拒路径零落链')
  } finally {
    env.svc.closeAll?.()
  }
})

test('T25-2 全文注入真值（D-C6）+ dedup + 路径登记不注入', async () => {
  const env = await makeEnv()
  try {
    const txt = join(env.root, 'notes.txt')
    const bin = join(env.root, 'data.bin')
    const content = 'hello attachment'
    writeFileSync(txt, content, 'utf8')
    writeFileSync(bin, Buffer.from([1, 2, 3]))
    await attach(env, txt, bin)
    const t1 = await sendTurn(env, '带附件的一轮')
    await waitForTurnEnd(env, t1)
    // fulltext 注入：内容进 payload、meta.chars = 实际字符数（D-C6 禁硬编码）
    const inj = eventsOf(env).find((e) => (e.meta as Record<string, unknown> | null)?.['injection'] === 'attachment')
    assert.ok(inj, '全文注入行落链')
    assert.equal(String(inj!.payload), content)
    const meta = inj!.meta as Record<string, unknown>
    assert.equal(meta['chars'], content.length, 'meta.chars = 实际读取字符数')
    assert.equal(meta['path'], txt)
    assert.equal(meta['mime'], 'text/plain')
    // 路径登记形态不注入内容
    assert.ok(!eventsOf(env).some((e) => (e.meta as Record<string, unknown> | null)?.['injection'] === 'attachment' && (e.meta as Record<string, unknown>)['path'] === bin), 'path-ref 不注入')
    // dedup：第二 turn 同路径不重注
    const t2 = await sendTurn(env, '第二问')
    await waitForTurnEnd(env, t2)
    assert.equal(eventsOf(env).filter((e) => (e.meta as Record<string, unknown> | null)?.['injection'] === 'attachment').length, 1, '同路径不重注')
    const report = (await env.svc.dispatch('audit:report', { workspaceId: env.ws.id, sessionId: env.sess.sessionId })) as { chain: { intact: boolean } }
    assert.equal(report.chain.intact, true)
  } finally {
    env.svc.closeAll?.()
  }
})

test('T25-3 撤销 = 补偿事件：未注入的附件撤销后不再注入；未知路径撤销 fail-visible', async () => {
  const env = await makeEnv()
  try {
    const txt = join(env.root, 'later.txt')
    writeFileSync(txt, 'revoked content', 'utf8')
    await attach(env, txt)
    await env.svc.dispatch('attachment:remove', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, path: txt })
    const rmEv = eventsOf(env).filter((e) => (e.payload as Record<string, unknown> | null)?.['type'] === 'file/attach-remove').at(-1)!
    assert.equal((rmEv.payload as Record<string, unknown>)['path'], txt, 'file/attach-remove 补偿事件落链')
    const t = await sendTurn(env, '撤销后的一轮')
    await waitForTurnEnd(env, t)
    assert.ok(!eventsOf(env).some((e) => (e.meta as Record<string, unknown> | null)?.['injection'] === 'attachment'), '撤销后全文不注入')
    await assert.rejects(
      () => env.svc.dispatch('attachment:remove', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, path: join(env.root, 'ghost.txt') }),
      (err: Error) => /不存在或已撤销/.test(err.message),
    )
  } finally {
    env.svc.closeAll?.()
  }
})

test('T25-4 合并预算（C-5）：fulltext 超 8000 → sendTurn fail-visible 且 busy 不残留', async () => {
  const env = await makeEnv()
  try {
    const big = join(env.root, 'huge.txt')
    writeFileSync(big, 'a'.repeat(200 * 1024), 'utf8') // 200KB 边界内（fulltext 形态）
    await attach(env, big)
    await assert.rejects(
      () => sendTurn(env, '超预算的一轮'),
      (err: Error) => /CAR-E-MEM-BUDGET|合并预算/.test(err.message),
      '全文超合并预算 fail-visible（禁静默截断）',
    )
    // busy 不残留：撤销后可正常发送
    await env.svc.dispatch('attachment:remove', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, path: big })
    const t = await sendTurn(env, '恢复后的一轮')
    await waitForTurnEnd(env, t)
  } finally {
    env.svc.closeAll?.()
  }
})
