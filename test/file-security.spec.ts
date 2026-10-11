/**
 * S3-S2 文件安全引擎与工具面行为测试（桌面端文件安全设计 §5/§6；S3 规划 WBS S3-S2 判据）
 *
 * 前提纪律（lesson-deterministic-test-premises）：全部注入临时目录——userData / 工作区 /
 * 「敏感目录」均由用例自建，不断言真实 %USERPROFILE% 形态；E2E 经宿主核心公共 API
 * （createHostService.dispatch + fileSecurity:* 设置面）驱动；内核 runTurn/AuthzService 真跑，
 * 仅模型回调注入假脚本（chatStep 落链口径复刻——turn.spec 同款）。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createHostService, type HostService, type PushMessage } from '../src/host-core/service.ts'
import {
  createFileSecurityEngine,
  factoryFileSecuritySettings,
  validateFileSecuritySettings,
  type FileRule,
  type FileSecuritySettings,
} from '../src/host-core/fileSecurity.ts'
import { createFileSecurityStore } from '../src/host-core/fileSecurityStore.ts'
import type { SessionEventDTO, SessionEventPush, WorkspaceInfo } from '../src/shared/ipc-contract.ts'
import type { SessionHandle } from '../src/host-core/session-handle.ts'
import type { HostModelFn, HostModelStep } from '../src/host-core/types.ts'

function tmpDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `car-fs-${label}-`))
}

// ==================== 引擎单测（规范化/规避矩阵/首条命中/fallback/hardReject） ====================

function makeEngine(rules: FileRule[], userDataDir = tmpDir('ud')) {
  const store = createFileSecurityStore(userDataDir)
  if (rules.length) store.set(rules)
  return { engine: createFileSecurityEngine(store), store, userDataDir }
}

test('出厂预设：8 条按「具体→宽泛」排序（R-FS-7）+ 档位为拍板口径（Q-FS-1/2/3）', () => {
  const userData = tmpDir('factory')
  const s = factoryFileSecuritySettings(userData)
  assert.equal(s.version, 2)
  assert.deepEqual(s.networkRules, [], 'v2 网络轴：出厂无网络规则（域名规则用户显式添加）')
  assert.equal(s.rules.length, 8)
  assert.deepEqual(
    s.rules.map((r) => r.id),
    [
      'preset-car-data', 'preset-workspace-car', 'preset-ssh', 'preset-aws',
      'preset-gcp', 'preset-gnupg', 'preset-gpg', 'preset-workspace',
    ],
  )
  const carData = s.rules[0]
  assert.equal(carData.path, userData, 'userData 拒绝规则以物化路径出厂（覆盖 file-security.json 与备份区）')
  assert.deepEqual([carData.read, carData.write, carData.delete], ['deny', 'deny', 'deny'])
  const wsCar = s.rules[1]
  assert.equal(wsCar.path, '%WORKSPACE%\\.car\\')
  assert.deepEqual([wsCar.read, wsCar.write, wsCar.delete], ['deny', 'deny', 'deny'])
  for (const id of ['preset-ssh', 'preset-aws', 'preset-gcp', 'preset-gnupg', 'preset-gpg']) {
    const r = s.rules.find((x) => x.id === id)!
    assert.deepEqual([r.read, r.write, r.delete], ['ask', 'ask', 'ask'], `${id} 收紧为全询问（R-FS-6）`)
  }
  const ws = s.rules[7]
  assert.deepEqual([ws.read, ws.write, ws.delete], ['allow', 'ask', 'ask'])
})

test('规避矩阵：.. 穿越 / 大小写折叠 / 正反斜杠 / 尾分隔符 dir-vs-file / 未知变量 inert / 首条命中', () => {
  const ws = tmpDir('ws')
  const sensitive = tmpDir('secret-box')
  mkdirSync(join(sensitive, 'keys'), { recursive: true })
  const { engine } = makeEngine([
    { id: 'r-first', path: sensitive + '\\keys\\', read: 'allow', write: 'allow', delete: 'allow' },
    { id: 'r-secret', path: sensitive + '\\', read: 'deny', write: 'deny', delete: 'deny' },
    { id: 'r-unknown-var', path: '%NOTAVAR%\\x\\', read: 'deny', write: 'deny', delete: 'deny' },
    { id: 'r-file', path: join(ws, 'exact.txt'), read: 'deny', write: 'deny', delete: 'deny' },
  ])

  // 1. 子树规则先于父规则（R-FS-7 排序纪律）；../ 穿越 resolve 后命中父规则
  const traversal = engine.decide('read', join(ws, '..', sensitive.split(/[\\/]/).pop()!, 'id_rsa'), ws)
  assert.equal(traversal.tier, 'deny')
  assert.equal(traversal.rule?.id, 'r-secret')

  // 2. 大小写折叠（win32）+ 正反斜杠混写 + 首条命中：keys 子树规则先于父规则
  const mixed = engine.decide('read', sensitive.replace(/\\/g, '/').toUpperCase() + '/KEYS/k1.txt', ws)
  assert.equal(mixed.tier, 'allow')
  assert.equal(mixed.rule?.id, 'r-first')

  // 3. 尾分隔符语义：目录规则（尾分隔符）子树命中；文件规则精确匹配
  assert.equal(engine.decide('read', join(sensitive, 'keys', 'k2.txt'), ws).rule?.id, 'r-first')
  assert.equal(engine.decide('read', join(ws, 'exact.txt'), ws).rule?.id, 'r-file')
  assert.equal(engine.decide('read', join(ws, 'exact.txt.bak'), ws).tier, 'fallback-inside', '文件规则不前缀误命中')

  // 4. 未知变量规则 inert + 告警（fail-visible，禁静默失效）
  const inert = engine.decide('read', 'C:/whatever/x/y.txt', ws)
  assert.notEqual(inert.tier, 'deny', '未知变量规则不参与命中')
  assert.ok(inert.warnings.some((w) => w.includes('%NOTAVAR%')), '告警显性化')

  // 5. fallback 双分支
  assert.equal(engine.decide('write', join(ws, 'in.txt'), ws).tier, 'fallback-inside')
  assert.equal(engine.decide('write', tmpDir('elsewhere') + '\\x.txt', ws).tier, 'fallback-outside')

  // 6. hardReject 消息形态（run 兜底口径）
  const denyMsg = engine.hardReject('read', join(ws, '..', sensitive.split(/[\\/]/).pop()!, 'id_rsa'), ws)
  assert.match(String(denyMsg), /CAR-E-DESKTOP: fs_read 被文件规则拒绝（r-secret:/)
  const outsideMsg = engine.hardReject('write', tmpDir('elsewhere2') + '\\y.txt', ws)
  assert.match(String(outsideMsg), /目标越界/)
  assert.equal(engine.hardReject('write', join(ws, 'ok.txt'), ws), null, 'fallback-inside 不硬拒（人审门可达）')
})

test('规避矩阵·符号链接逃逸：工作区内链接指向敏感目录 → realpath 解出真实目标后命中拒绝规则', () => {
  const ws = tmpDir('ws-symlink')
  const sensitive = tmpDir('secret-link')
  mkdirSync(join(sensitive, 'real'), { recursive: true })
  mkdirSync(join(ws, 'link'), { recursive: true })
  let linkMade = false
  try {
    symlinkSync(join(sensitive, 'real'), join(ws, 'link', 'esc'), 'junction')
    linkMade = true
  } catch {
    // win32 非提权可能拒绝建链——能力门控跳过（不构成失败）
  }
  if (!linkMade) return
  const { engine } = makeEngine([{ id: 'r-secret', path: sensitive + '\\', read: 'deny', write: 'deny', delete: 'deny' }])
  const d = engine.decide('read', join(ws, 'link', 'esc', 'id_rsa'), ws)
  assert.equal(d.tier, 'deny', 'realpath 展开后命中（逃逸不可达）')
})

test('store：set 校验 fail-visible / reset 还原出厂 / 损坏回退保守预设并写回', () => {
  const userData = tmpDir('store')
  const store = createFileSecurityStore(userData)
  assert.equal(store.get().rules.length, 8, '首启落出厂预设')
  assert.throws(() => store.set([{ id: 'x', path: 'a\\', read: 'maybe', write: 'ask', delete: 'ask' }]), /档位非法/)
  assert.throws(() => store.set([{ id: 'x', path: '', read: 'ask', write: 'ask', delete: 'ask' }]), /缺少 path/)
  assert.throws(() => store.set('not-an-array' as unknown), /缺少 rules/)
  const custom: FileSecuritySettings = store.set([{ id: 'r1', path: 'C:\\x\\', read: 'allow', write: 'allow', delete: 'allow' }])
  assert.equal(custom.rules.length, 1)
  assert.ok(existsSync(join(userData, 'file-security.json')), '持久化落盘')
  assert.equal(store.reset().rules.length, 8, 'reset 还原出厂 8 条')
  // 损坏回退：手写垃圾 → 新 store 实例读回出厂并写回（不 fail-open）
  writeFileSync(join(userData, 'file-security.json'), '{corrupted', 'utf8')
  const store2 = createFileSecurityStore(userData)
  assert.equal(store2.get().rules.length, 8)
  assert.equal((JSON.parse(readFileSync(join(userData, 'file-security.json'), 'utf8')) as FileSecuritySettings).rules.length, 8)
})

test('validate：档位白名单 / 未知字段剥离 / preset 保真', () => {
  const ok = validateFileSecuritySettings({ version: 1, rules: [{ id: 'a', path: 'C:\\a\\', read: 'allow', write: 'ask', delete: 'deny', preset: true }] })
  assert.equal(ok.rules[0].preset, true)
  const stripped = validateFileSecuritySettings({ version: 1, rules: [{ id: 'b', path: 'C:\\b\\', read: 'allow', write: 'ask', delete: 'deny', evil: 1 }] })
  assert.equal('evil' in stripped.rules[0], false, '未知字段剥离')
})

// ==================== E2E（service 公共 API 驱动；内核真跑 + 假模型复刻落链口径） ====================

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

/** 工具调用参数在模型回调时求值（turnIndex 从 0 递增——同一 env 内多 turn 可变路径） */
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
async function sendTurn(env: Env, text: string): Promise<string> {
  const r = (await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, text })) as { turnId: string }
  return r.turnId
}
async function waitForPending(env: Env, count = 1): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 3000
  for (;;) {
    if (pendingsOf(env).length >= count) return pendingsOf(env).at(-1)!
    if (Date.now() > deadline) throw new Error('pending 未推送')
    await new Promise((r) => setTimeout(r, 10))
  }
}
async function respondOnce(env: Env): Promise<void> {
  await env.svc.dispatch('authz:respond', {
    workspaceId: env.ws.id,
    sessionId: env.sess.sessionId,
    requestId: pendingsOf(env).at(-1)!['requestId'],
    decision: 'once',
  })
}
function authzEventsOf(env: Env): Array<{ payload: Record<string, unknown>; meta: Record<string, unknown> | null }> {
  return eventsOf(env)
    .filter((e) => e.turnId.startsWith('authz:'))
    .map((e) => ({ payload: e.payload as Record<string, unknown>, meta: (e.meta ?? null) as Record<string, unknown> | null }))
}
function toolErrorsOf(env: Env): string[] {
  return eventsOf(env)
    .filter((e) => e.kind === 'toolResult')
    .map((e) => e.payload as Record<string, unknown>)
    .filter((p) => typeof p['error'] === 'string')
    .map((p) => String(p['error']))
}

test('E2E·allow 档免弹窗：工作区读取（出厂预设 read=allow）→ 无 pending、规则直判落链 reason 带 ruleId', async () => {
  const env = await makeEnv((h) => ({ tool: 'fs_read', args: { path: 'in.txt' } }))
  writeFileSync(join(env.root, 'in.txt'), '工作区内文件内容', 'utf8')
  const t = await sendTurn(env, '读文件')
  const end = await waitForTurnEnd(env, t)
  assert.equal((end.meta as Record<string, unknown>)['reason'], 'completed')
  assert.equal(pendingsOf(env).length, 0, 'allow 档不弹窗')
  const executed = eventsOf(env).find((e) => e.kind === 'toolResult' && ((e.payload as Record<string, unknown>)['result'] as Record<string, unknown> | undefined)?.['content'] !== undefined)
  assert.ok(executed, 'fs_read 已执行')
  const ruleEvents = authzEventsOf(env).filter((e) => String(e.meta?.['reason']).includes('file-rule:preset-workspace allow read'))
  assert.equal(ruleEvents.length, 1, '规则直判落链（审计可回答「为什么没问人」）')
  assert.equal(ruleEvents[0].payload['decision'], 'APPROVED')
  assert.equal(ruleEvents[0].payload['decidedBy'], 'policy')
})

test('E2E·deny 档（审计红线）：fs_delete 会话 JSONL → 静默拒绝不弹窗 + 文件完好', async () => {
  const env = await makeEnv((h) => ({ tool: 'fs_delete', args: { path: join(h.workspaceRoot, '.car', 'sessions', h.sessionId + '.jsonl') } }))
  const jsonl = join(env.root, '.car', 'sessions', env.sess.sessionId + '.jsonl')
  assert.ok(existsSync(jsonl))
  const t = await sendTurn(env, '删日志')
  const end = await waitForTurnEnd(env, t)
  assert.equal((end.meta as Record<string, unknown>)['reason'], 'completed')
  assert.equal(pendingsOf(env).length, 0, 'deny 档不弹窗')
  const tr = eventsOf(env).filter((e) => e.kind === 'toolResult').map((e) => e.payload as Record<string, unknown>)
  assert.ok(tr.some((p) => p['error'] === 'authorization-denied' && p['granted'] === false))
  assert.ok(existsSync(jsonl), '审计链 JSONL 未被删除（出厂拒绝×3 生效）')
  const denyEvent = authzEventsOf(env).find((e) => String(e.meta?.['reason']).includes('file-rule:preset-workspace-car deny delete'))
  assert.ok(denyEvent, '拒绝规则落链 reason 保真')
  assert.equal(denyEvent!.payload['decision'], 'DENIED')
})

test('E2E·拒绝规则压会话 grant：session 档放行的工具在拒绝路径上仍被静默拒绝（红线不因顺手批准失守）', async () => {
  const env = await makeEnv((h, i) => ({
    tool: 'fs_write',
    args: { path: join(h.workspaceRoot, i === 0 ? 'dirB' : 'dirA', 'x.txt'), content: 'x' },
  }))
  mkdirSync(join(env.root, 'dirA'), { recursive: true })
  mkdirSync(join(env.root, 'dirB'), { recursive: true })
  // 规则面：dirA 写=deny（set 全量替换——无 workspace 预设；dirB 未命中 → fallback-inside 人审门）
  await env.svc.dispatch('fileSecurity:set', { rules: [{ id: 'r-deny-a', path: join(env.root, 'dirA') + '\\', read: 'allow', write: 'deny', delete: 'deny' }] })
  // turn1（dirB）：fallback-inside → 人审门 → 「会话内始终允许」→ fs_write grant 入缓存
  const t1 = await sendTurn(env, 'T1')
  await waitForPending(env)
  await env.svc.dispatch('authz:respond', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, requestId: pendingsOf(env).at(-1)!['requestId'], decision: 'session' })
  await waitForTurnEnd(env, t1)
  assert.ok(existsSync(join(env.root, 'dirB', 'x.txt')), 'grant 放行的 dirB 已写入')
  const pendingsAfterT1 = pendingsOf(env).length
  // turn2（dirA）：grant 命中但规则面先决 → 静默拒绝（无新 pending）
  const t2 = await sendTurn(env, 'T2')
  await waitForTurnEnd(env, t2)
  assert.equal(pendingsOf(env).length, pendingsAfterT1, '拒绝规则路径不再弹窗')
  const denied = authzEventsOf(env).find((e) => String(e.meta?.['reason']).includes('file-rule:r-deny-a deny write'))
  assert.ok(denied, '拒绝规则直判落链')
  assert.equal(denied!.payload['decision'], 'DENIED')
  assert.ok(!existsSync(join(env.root, 'dirA', 'x.txt')), '拒绝路径未写入')
})

test('E2E·允许规则拓宽面：规则允许的工作区外写入 → 免弹窗执行（用户显式放宽）', async () => {
  const outside = tmpDir('outside')
  const env = await makeEnv(() => ({ tool: 'fs_write', args: { path: join(outside, 'w.txt'), content: 'outside-ok' } }))
  await env.svc.dispatch('fileSecurity:set', { rules: [{ id: 'r-out', path: outside + '\\', read: 'allow', write: 'allow', delete: 'allow' }] })
  const t = await sendTurn(env, '外写')
  const end = await waitForTurnEnd(env, t)
  assert.equal((end.meta as Record<string, unknown>)['reason'], 'completed')
  assert.equal(pendingsOf(env).length, 0)
  assert.ok(existsSync(join(outside, 'w.txt')), '规则放行的工作区外写入已执行')
  assert.ok(authzEventsOf(env).some((e) => String(e.meta?.['reason']).includes('file-rule:r-out allow write')))
})

test('E2E·fallback-outside（S3-S2 语义升级）：未命中+工作区外 → 授权层自动拒绝落链，不再弹窗', async () => {
  const escDir = tmpDir('esc')
  const env = await makeEnv(() => ({ tool: 'fs_write', args: { path: join(escDir, 'escape.txt'), content: 'x' } }))
  const t = await sendTurn(env, '越界写')
  const end = await waitForTurnEnd(env, t)
  assert.equal((end.meta as Record<string, unknown>)['reason'], 'completed')
  assert.equal(pendingsOf(env).length, 0, '不弹窗（fail-visible 直判）')
  const tr = eventsOf(env).filter((e) => e.kind === 'toolResult').map((e) => e.payload as Record<string, unknown>)
  assert.ok(tr.some((p) => p['error'] === 'authorization-denied' && p['granted'] === false))
  const fb = authzEventsOf(env).find((e) => String(e.meta?.['reason']).includes('file-fallback:outside-workspace'))
  assert.ok(fb, 'fallback 硬拒落链（决策 100% 审计）')
  assert.equal(fb!.payload['decision'], 'DENIED')
  assert.ok(!existsSync(join(escDir, 'escape.txt')), '越界目标未创建')
})

test('E2E·fs_read 脱敏落链（K-FS-4）：凭据形态被遮蔽——链上不进密钥原文', async () => {
  const env = await makeEnv(() => ({ tool: 'fs_read', args: { path: 'cred.txt' } }))
  const secret = 'sk-abcdefghijklmnopqrstuvwxyz012345' // secrets-scan:allow —— 假密钥 fixture（K-FS-4 脱敏断言的检测靶料，非真实凭据）
  writeFileSync(join(env.root, 'cred.txt'), 'token: ' + secret + '\n', 'utf8')
  const t = await sendTurn(env, '读凭据')
  await waitForTurnEnd(env, t)
  const executed = eventsOf(env).find((e) => e.kind === 'toolResult' && ((e.payload as Record<string, unknown>)['result'] as Record<string, unknown> | undefined)?.['content'] !== undefined)
  const content = String(((executed!.payload as Record<string, unknown>)['result'] as Record<string, unknown>)['content'])
  assert.ok(!content.includes(secret), '执行结果不含密钥原文')
  assert.ok((((executed!.payload as Record<string, unknown>)['result'] as Record<string, unknown>)['redactedCount'] as number) >= 1, '命中计数显性化')
  // 全事件流扫描（与 JSONL 同源同序）：任何事件都不含原文（落链面零泄漏）
  assert.ok(!JSON.stringify(eventsOf(env)).includes(secret), '事件流不含密钥原文')
})

test('E2E·fs_read 截断与二进制守卫', async () => {
  const env = await makeEnv(() => ({ tool: 'fs_read', args: { path: 'big.txt' } }))
  writeFileSync(join(env.root, 'big.txt'), 'x'.repeat(300 * 1024), 'utf8')
  const t = await sendTurn(env, '读大文件')
  await waitForTurnEnd(env, t)
  const executed = eventsOf(env).find((e) => e.kind === 'toolResult' && ((e.payload as Record<string, unknown>)['result'] as Record<string, unknown> | undefined)?.['truncated'] !== undefined)
  assert.equal(((executed!.payload as Record<string, unknown>)['result'] as Record<string, unknown>)['truncated'], true)
  assert.ok(String(((executed!.payload as Record<string, unknown>)['result'] as Record<string, unknown>)['content']).length <= 256 * 1024)

  const env2 = await makeEnv(() => ({ tool: 'fs_read', args: { path: 'bin.dat' } }))
  writeFileSync(join(env2.root, 'bin.dat'), Buffer.from([0x70, 0x00, 0x71]))
  const t2 = await sendTurn(env2, '读二进制')
  await waitForTurnEnd(env2, t2)
  assert.match(toolErrorsOf(env2).find((m) => m.includes('二进制')) ?? '', /疑似二进制/)
})

test('E2E·fs_delete 目录守卫：未带 recursive 拒绝（人审门后工具错误交回）；显式 recursive 经人审门执行', async () => {
  const env = await makeEnv(() => ({ tool: 'fs_delete', args: { path: 'dir' } }))
  mkdirSync(join(env.root, 'dir'), { recursive: true })
  writeFileSync(join(env.root, 'dir', 'f.txt'), 'x', 'utf8')
  const t = await sendTurn(env, '删目录')
  await waitForPending(env) // workspace delete=ask → 人审门
  await respondOnce(env)
  await waitForTurnEnd(env, t)
  assert.match(toolErrorsOf(env).find((m) => m.includes('recursive')) ?? '', /recursive/)
  assert.ok(existsSync(join(env.root, 'dir')), '目录仍在')

  const env2 = await makeEnv(() => ({ tool: 'fs_delete', args: { path: 'dir', recursive: true } }))
  mkdirSync(join(env2.root, 'dir'), { recursive: true })
  writeFileSync(join(env2.root, 'dir', 'f.txt'), 'x', 'utf8')
  const t2 = await sendTurn(env2, '递归删')
  await waitForPending(env2)
  await respondOnce(env2)
  await waitForTurnEnd(env2, t2)
  assert.ok(!existsSync(join(env2.root, 'dir')), '显式 recursive 后目录已删')
})

test('E2E·设置面三通道：get 出厂 / set 校验与持久化 / reset 还原 / 规则即时生效', async () => {
  const zDir = tmpDir('z')
  const env = await makeEnv(() => ({ tool: 'fs_write', args: { path: join(zDir, 'z.txt'), content: 'z' } }))
  const factory = (await env.svc.dispatch('fileSecurity:get', {})) as FileSecuritySettings
  assert.equal(factory.rules.length, 8)
  await assert.rejects(() => env.svc.dispatch('fileSecurity:set', { rules: [{ id: 'x', path: 'a\\', read: 'nope', write: 'ask', delete: 'ask' }] }), /档位非法/)
  await env.svc.dispatch('fileSecurity:set', { rules: [{ id: 'r-z', path: zDir + '\\', read: 'allow', write: 'allow', delete: 'allow' }] })
  const saved = JSON.parse(readFileSync(join(env.userData, 'file-security.json'), 'utf8')) as FileSecuritySettings
  assert.equal(saved.rules.length, 1, 'set 已持久化（原子写）')
  const t = await sendTurn(env, '写 z')
  const end = await waitForTurnEnd(env, t)
  assert.equal((end.meta as Record<string, unknown>)['reason'], 'completed')
  assert.equal(pendingsOf(env).length, 0, '新规则即时生效（免弹窗）')
  const reset = (await env.svc.dispatch('fileSecurity:reset', {})) as FileSecuritySettings
  assert.equal(reset.rules.length, 8)
})

async function waitForPendingAlias(env: Env): Promise<Record<string, unknown>> {
  return waitForPending(env)
}
void waitForPendingAlias
