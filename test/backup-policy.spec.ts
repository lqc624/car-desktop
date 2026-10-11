/**
 * S3-S3 自动备份 + 会话默认策略行为测试（安全中心设计 §4/§5；Q-SC-2/3 拍板口径）
 *
 * 判据（S3 规划 WBS S3-S3）：先保后变顺序（备份在写前）、备份失败→变更不落盘、LRU 淘汰、
 * toolResult backup 字段、默认策略继承（新会话读 securitySettings）、会话内切换落链。
 * 前提纪律同 file-security.spec：全注入临时目录；E2E 经宿主公共 API 驱动；内核真跑 + 假模型。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { test } from 'node:test'
import { createHostService, type HostService, type PushMessage } from '../src/host-core/service.ts'
import { createBackupStore } from '../src/host-core/backupStore.ts'
import { createSecuritySettingsStore } from '../src/host-core/securitySettingsStore.ts'
import type { SecuritySettings, SecuritySettingsStore } from '../src/host-core/securitySettingsStore.ts'
import type { SessionEventDTO, SessionEventPush, WorkspaceInfo } from '../src/shared/ipc-contract.ts'
import type { SessionHandle } from '../src/host-core/session-handle.ts'
import type { HostModelFn, HostModelStep } from '../src/host-core/types.ts'

function tmpDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `car-bk-${label}-`))
}

// ==================== backupStore 单测（先保后变 / 开关 / fail-visible / LRU / 目录树） ====================

test('backupStore：覆盖前备份内容一致；新建写返回 null；开关关闭不产生备份', () => {
  const ud = tmpDir('ud')
  const settings = { enabled: true, maxTotalBytes: 2000 * 1024 * 1024 }
  const store = createBackupStore(ud, () => ({ ...settings }))
  const ws = tmpDir('ws')
  const target = join(ws, 'a.txt')
  writeFileSync(target, 'original-v0', 'utf8')
  const rec = store.backupBefore(target, ws, { workspaceId: 'ws1', sessionId: 'S1' })
  assert.ok(rec, '覆盖前备份产出')
  assert.equal(readFileSync(rec!.path, 'utf8'), 'original-v0', '备份件 = 变更前原件')
  assert.ok(rec!.path.startsWith(join(ud, 'backups')), '布局在 backups 根内')
  // 新建写：目标不存在 → null（无可保留原件）
  assert.equal(store.backupBefore(join(ws, 'new.txt'), ws, { workspaceId: 'ws1', sessionId: 'S1' }), null)
  // 开关关闭：null 且不落任何备份目录
  const disabled = createBackupStore(tmpDir('ud2'), () => ({ enabled: false, maxTotalBytes: 2000 * 1024 * 1024 }))
  assert.equal(disabled.backupBefore(target, ws, { workspaceId: 'w', sessionId: 's' }), null)
  assert.ok(!existsSync(join(tmpDir('ud2'), 'backups')) || readdirCount(join(tmpDir('ud2'), 'backups')) === 0, '关闭态零备份写入')
})

function readdirCount(dir: string): number {
  try {
    return readdirSync(dir).length
  } catch {
    return 0
  }
}

test('backupStore：fail-visible——配额不可满足时 throw（变更不落盘的前置保证）；LRU 淘汰最旧 op', () => {
  const ud = tmpDir('ud-lru')
  let max = 1024 * 1024 // 起始充足
  const store = createBackupStore(ud, () => ({ enabled: true, maxTotalBytes: max }))
  const ws = tmpDir('ws')
  // 三个文件三个 op（各自独立 mtime 序列由创建顺序保证——同 ms 内 op-seq 递增仍可分新旧，
  // mtime 粒度可能相同 → LRU 断言用「最旧被淘汰、其余存活」的集合语义）
  const f1 = join(ws, 'f1.txt')
  const f2 = join(ws, 'f2.txt')
  writeFileSync(f1, 'A'.repeat(300), 'utf8')
  writeFileSync(f2, 'B'.repeat(300), 'utf8')
  const r1 = store.backupBefore(f1, ws, { workspaceId: 'w', sessionId: 's' })
  assert.ok(r1)
  const r2 = store.backupBefore(f2, ws, { workspaceId: 'w', sessionId: 's' })
  assert.ok(r2)
  // 收紧配额：600B → 现存 ~600B 恰好贴线；再备份 300B 文件 → 需淘汰
  max = 600
  const f3 = join(ws, 'f3.txt')
  writeFileSync(f3, 'C'.repeat(200), 'utf8')
  const r3 = store.backupBefore(f3, ws, { workspaceId: 'w', sessionId: 's' })
  assert.ok(r3, 'LRU 淘汰后新备份可写入')
  assert.ok(!existsSync(r1!.path) || !existsSync(r2!.path), '至少淘汰一个最旧 op')
  assert.ok(existsSync(r3!.path), '最新备份存活')
  // fail-visible：单次备份超过上限 → throw（run 侧即变更不落盘）
  max = 1024 // 1KB 上限
  const big = join(ws, 'big.txt')
  writeFileSync(big, 'D'.repeat(2 * 1024), 'utf8')
  assert.throws(() => store.backupBefore(big, ws, { workspaceId: 'w', sessionId: 's' }), /备份配额不足/)
})

test('backupStore：目录删除整树备份（结构保留）', () => {
  const ud = tmpDir('ud-tree')
  const store = createBackupStore(ud, () => ({ enabled: true, maxTotalBytes: 2000 * 1024 * 1024 }))
  const ws = tmpDir('ws')
  mkdirSync(join(ws, 'd', 'sub'), { recursive: true })
  writeFileSync(join(ws, 'd', 'sub', 'x.txt'), 'tree-node', 'utf8')
  const rec = store.backupBefore(join(ws, 'd'), ws, { workspaceId: 'w', sessionId: 's' })
  assert.ok(rec)
  assert.equal(readFileSync(join(rec!.path, 'sub', 'x.txt'), 'utf8'), 'tree-node', '整树结构保留')
})

// ==================== E2E（service 公共 API；内核真跑 + 假模型按 turn 变参数） ====================

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
  userData: string
  pushes: PushMessage[]
}

async function makeEnv(callOf: (h: SessionHandle, turnIndex: number) => { tool: string; args: Record<string, unknown> }): Promise<Env> {
  const userData = tmpDir('ud')
  const root = tmpDir('ws')
  writeFileSync(join(root, 'car.config.ts'), "export default { llm: { baseUrl: 'http://127.0.0.1:9', model: 'test-model' } }\n", 'utf8')
  const svc = createHostService({
    userDataDir: userData,
    modelFnOverride: (h: SessionHandle) => {
      let lastTurn = ''
      let turnIndex = 0
      return async () => {
        const t = h.currentTurnId()
        if (t !== lastTurn) {
          lastTurn = t
          const call = callOf(h, turnIndex++)
          return { stopReason: 'toolUse', toolCalls: [{ id: 'c-' + t, tool: call.tool, args: call.args }] }
        }
        return emitAssistant(h, { stopReason: 'stop', text: 'done' })
      }
    },
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
function pendingsOf(env: Env): Array<Record<string, unknown>> {
  return env.pushes.filter((m) => m.topic === 'push:authz-pending').map((m) => m.payload as Record<string, unknown>)
}
async function waitForTurnEnd(env: Env, turnId: string, timeoutMs = 5000): Promise<SessionEventDTO> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const e = eventsOf(env).find((x) => x.kind === 'turnEnd' && x.turnId === turnId)
    if (e) return e
    if (Date.now() > deadline) throw new Error(`waitForTurnEnd 超时（${turnId}）——已见: ${eventsOf(env).map((x) => x.kind).join(',')}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}
async function sendTurn(env: Env, sessionId: string, text: string): Promise<string> {
  const r = (await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId, text })) as { turnId: string }
  return r.turnId
}
async function waitForPending(env: Env): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 3000
  for (;;) {
    if (pendingsOf(env).length) return pendingsOf(env).at(-1)!
    if (Date.now() > deadline) throw new Error('pending 未推送')
    await new Promise((r) => setTimeout(r, 10))
  }
}
async function respond(env: Env, decision: 'once' | 'session' | 'deny'): Promise<void> {
  await env.svc.dispatch('authz:respond', {
    workspaceId: env.ws.id,
    sessionId: env.sess.sessionId,
    requestId: pendingsOf(env).at(-1)!['requestId'],
    decision,
  })
}
function resultPayloadsOf(env: Env, sessionId: string): Array<Record<string, unknown>> {
  return eventsOf(env)
    .filter((e) => e.kind === 'toolResult' && e.turnId.startsWith('T'))
    .map((e) => e.payload as Record<string, unknown>)
    .filter((p) => p['id']?.toString().includes('c-T'))
}
function authzReasons(env: Env): string[] {
  return eventsOf(env)
    .filter((e) => e.turnId.startsWith('authz:'))
    .map((e) => String((e.meta as Record<string, unknown> | null)?.['reason'] ?? ''))
}

test('E2E·自动备份：新建写无 backup 字段；覆盖写先保后变（backup 字段 + 原件内容可取回）', async () => {
  const env = await makeEnv((h, i) => ({
    tool: 'fs_write',
    args: { path: join(h.workspaceRoot, 'doc.txt'), content: 'v' + i },
  }))
  // turn0：新建（无原件可备份）——先应答授权门再等收口
  const t0 = await sendTurn(env, env.sess.sessionId, 'T0')
  await waitForPending(env)
  await respond(env, 'once')
  await waitForTurnEnd(env, t0)
  const p0 = resultPayloadsOf(env, env.sess.sessionId).at(-1)!
  assert.equal(existsSync(join(env.root, 'doc.txt')), true)
  assert.equal((p0['result'] as Record<string, unknown>)['backup'], undefined, '新建写无备份字段')

  // turn1：覆盖（先保后变——backup 字段 + 备份件内容 = v0）
  const t1 = await sendTurn(env, env.sess.sessionId, 'T1')
  await waitForPending(env)
  await respond(env, 'once')
  await waitForTurnEnd(env, t1)
  const p1 = resultPayloadsOf(env, env.sess.sessionId).at(-1)!
  const backup = (p1['result'] as Record<string, unknown>)['backup'] as Record<string, unknown> | undefined
  assert.ok(backup, '覆盖写带 backup 字段（EventKind 零新增的 payload 加法）')
  assert.equal(readFileSync(String(backup!['path']), 'utf8'), 'v0', '备份件 = 覆盖前原件（先保后变顺序）')
  assert.equal(readFileSync(join(env.root, 'doc.txt'), 'utf8'), 'v1', '变更照常落盘')
  assert.ok(String(backup!['path']).startsWith(join(env.userData, 'backups')), '备份区在 userData（拒绝×3 预设内）')
})

test('E2E·fs_delete 备份：删除前备份原件——审计链可回答「原件在哪」', async () => {
  const env = await makeEnv((h, i) =>
    i === 0
      ? { tool: 'fs_write', args: { path: join(h.workspaceRoot, 'gone.txt'), content: 'precious' } }
      : { tool: 'fs_delete', args: { path: join(h.workspaceRoot, 'gone.txt') } },
  )
  const t0 = await sendTurn(env, env.sess.sessionId, 'T0')
  await waitForPending(env)
  await respond(env, 'once')
  await waitForTurnEnd(env, t0)
  const t1 = await sendTurn(env, env.sess.sessionId, 'T1')
  await waitForPending(env)
  await respond(env, 'once')
  await waitForTurnEnd(env, t1)
  assert.equal(existsSync(join(env.root, 'gone.txt')), false, '文件已删除')
  const del = resultPayloadsOf(env, env.sess.sessionId).at(-1)!
  const backup = (del['result'] as Record<string, unknown>)['backup'] as Record<string, unknown>
  assert.ok(backup, '删除前备份字段在')
  assert.equal(readFileSync(String(backup['path']), 'utf8'), 'precious', '原件可从备份区手动取回')
})

test('E2E·先保后变 fail-visible：配额不足 → 备份失败 → 变更不落盘（toolResult 错误交回模型）', async () => {
  const env = await makeEnv((h, i) => ({
    tool: 'fs_write',
    args: { path: join(h.workspaceRoot, 'big.txt'), content: 'v' + i + '-' + 'x'.repeat(2 * 1024 * 1024) },
  }))
  // 收紧配额到下限附近（1MB）——2MB 内容的覆盖备份必然不可满足
  await env.svc.dispatch('securitySettings:set', { patch: { autoBackup: { enabled: true, maxTotalBytes: 1024 * 1024 } } })
  const t0 = await sendTurn(env, env.sess.sessionId, 'T0')
  await waitForPending(env)
  await respond(env, 'once')
  await waitForTurnEnd(env, t0)
  assert.equal(existsSync(join(env.root, 'big.txt')), true, '首次新建写成功（无原件可备份）')
  // 覆盖写：备份 2MB > 1MB 上限 → fail-visible → 变更不落盘
  const t1 = await sendTurn(env, env.sess.sessionId, 'T1')
  await waitForPending(env)
  await respond(env, 'once')
  await waitForTurnEnd(env, t1)
  const err = resultPayloadsOf(env, env.sess.sessionId)
    .filter((p) => typeof p['error'] === 'string')
    .map((p) => String(p['error']))
    .find((m) => m.includes('备份'))
  assert.match(String(err), /备份配额不足/, '备份失败 fail-visible 交回模型')
  assert.equal(readFileSync(join(env.root, 'big.txt'), 'utf8').startsWith('v0-'), true, '变更未落盘（原件保持 v0）')
})

test('E2E·默认策略继承（Q-SC-3）：securitySettings readonly → 新会话写/删直判拒绝（不弹窗）+ 读取规则面照常', async () => {
  const env = await makeEnv((h, i) =>
    i === 0
      ? { tool: 'fs_write', args: { path: join(h.workspaceRoot, 'ro.txt'), content: 'x' } }
      : { tool: 'fs_read', args: { path: 'in.txt' } },
  )
  writeFileSync(join(env.root, 'in.txt'), 'readable', 'utf8')
  await env.svc.dispatch('securitySettings:set', { patch: { sessionDefaultPolicy: 'readonly' } })
  const sess2 = (await env.svc.dispatch('session:create', { workspaceId: env.ws.id })) as { sessionId: string }
  // 新会话继承只读：fs_write → 策略面直判拒绝（先于规则面）
  const t0 = await sendTurn(env, sess2.sessionId, 'T0')
  const end0 = await waitForTurnEnd(env, t0)
  assert.equal((end0.meta as Record<string, unknown>)['reason'], 'completed')
  assert.equal(pendingsOf(env).length, 0, '只读策略写拒绝不弹窗')
  const roDeny = authzReasons(env).find((r) => r.includes('session-policy:readonly deny write'))
  assert.ok(roDeny, '只读策略拒绝落链（决策 100% 审计）')
  assert.ok(!existsSync(join(env.root, 'ro.txt')), '只读模式下未写入')
  // 读取：出厂预设 workspace read=allow → 照常执行（只读模式查询类放行）
  const t1 = await sendTurn(env, sess2.sessionId, 'T1')
  await waitForTurnEnd(env, t1)
  const read = resultPayloadsOf(env, sess2.sessionId).find((p) => (p['result'] as Record<string, unknown> | undefined)?.['content'] === 'readable')
  assert.ok(read, '只读模式读取照常放行')
})

test('E2E·只读模式读保护：凭据目录询问档在只读下依然可达（策略不削弱规则面）', async () => {
  const sensitive = tmpDir('secret-ro')
  writeFileSync(join(sensitive, 'id_rsa'), 'PRIVATE', 'utf8')
  const env = await makeEnv((h, i) =>
    i === 0
      ? { tool: 'fs_read', args: { path: join(sensitive, 'id_rsa') } }
      : { tool: 'fs_write', args: { path: join(sensitive, 'w.txt'), content: 'x' } },
  )
  // 规则：sensitive 读=询问、写=允许（显式放宽）——只读模式下写仍被策略面拒绝（policy 先于规则）
  await env.svc.dispatch('fileSecurity:set', { rules: [{ id: 'r-s', path: sensitive + '\\', read: 'ask', write: 'allow', delete: 'allow' }] })
  await env.svc.dispatch('session:set-policy', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, policy: 'readonly' })
  // 读取：ask 档 → 人审门（只读不绕过规则面的询问）→ 批准后执行
  const t0 = await sendTurn(env, env.sess.sessionId, 'T0')
  const pending = await waitForPending(env)
  assert.equal(pending['tool'], 'fs_read', '只读模式下凭据读取仍弹窗（规则面未被策略削弱）')
  await respond(env, 'once')
  await waitForTurnEnd(env, t0)
  // 写入：规则面 allow 但只读策略先决 → 拒绝
  const t1 = await sendTurn(env, env.sess.sessionId, 'T1')
  await waitForTurnEnd(env, t1)
  assert.equal(pendingsOf(env).length, 1, '只读写拒绝不弹窗')
  assert.ok(authzReasons(env).some((r) => r.includes('session-policy:readonly deny write')))
  assert.ok(!existsSync(join(sensitive, 'w.txt')), '规则 allow 不越过只读策略')
})

test('E2E·会话内放行（policy=session）：规则面之后自动放行（拒绝红线仍先决）+ session/policy 落链 + 切回 default 恢复人审', async () => {
  const env = await makeEnv((h, i) => ({
    tool: 'fs_write',
    args: { path: join(h.workspaceRoot, i === 0 ? 's1.txt' : 's2.txt'), content: 'v' + i },
  }))
  // 切换：会话内放行（落链）
  await env.svc.dispatch('session:set-policy', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, policy: 'session' })
  const t0 = await sendTurn(env, env.sess.sessionId, 'T0')
  const end0 = await waitForTurnEnd(env, t0)
  assert.equal((end0.meta as Record<string, unknown>)['reason'], 'completed')
  assert.equal(pendingsOf(env).length, 0, '会话内放行不弹窗')
  assert.ok(authzReasons(env).some((r) => r.includes('session policy grant')), '逐次 policy 直判落链')
  const t1 = await sendTurn(env, env.sess.sessionId, 'T1')
  await waitForTurnEnd(env, t1)
  assert.equal(pendingsOf(env).length, 0, '后续同类操作持续放行')
  // 落链：session/policy system 事件（D-S2-3 口径）
  const policyEvent = eventsOf(env).find((e) => e.kind === 'system' && (e.payload as Record<string, unknown>)['type'] === 'session/policy')
  assert.ok(policyEvent, '策略切换未落链')
  assert.equal((policyEvent!.payload as Record<string, unknown>)['policy'], 'session')
  // 切回默认：人审门恢复
  await env.svc.dispatch('session:set-policy', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, policy: 'default' })
  const t2 = await sendTurn(env, env.sess.sessionId, 'T2')
  await waitForPending(env)
  assert.equal(pendingsOf(env).length, 1, '切回 default 后人审门恢复')
  await respond(env, 'deny')
  await waitForTurnEnd(env, t2)
})

test('E2E·securitySettings 三形态：get 出厂 / set 校验 fail-visible / 持久化', async () => {
  const ud = tmpDir('ss')
  const store: SecuritySettingsStore = createSecuritySettingsStore(ud)
  const factory: SecuritySettings = store.get()
  assert.equal(factory.sessionDefaultPolicy, 'default')
  assert.equal(factory.autoBackup.enabled, true)
  assert.equal(factory.autoBackup.maxTotalBytes, 2000 * 1024 * 1024)
  assert.throws(() => store.set({ sessionDefaultPolicy: 'session' }), /不作出厂默认/, '「会话内放行」禁止作为默认策略')
  assert.throws(() => store.set({ autoBackup: { enabled: true, maxTotalBytes: 100 } }), /maxTotalBytes/)
  const saved = store.set({ sessionDefaultPolicy: 'readonly', autoBackup: { enabled: false } })
  assert.equal(saved.sessionDefaultPolicy, 'readonly')
  assert.equal(saved.autoBackup.enabled, false)
  assert.equal(saved.autoBackup.maxTotalBytes, 2000 * 1024 * 1024, 'patch 合并：未触及字段保持')
  assert.equal((JSON.parse(readFileSync(join(ud, 'security-settings.json'), 'utf8')) as SecuritySettings).autoBackup.enabled, false)
})
