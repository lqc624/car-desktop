/**
 * 宿主核心行为测试（S1 规划 WBS S1-S3 判据）
 *
 * 前提纪律（lesson-deterministic-test-premises）：全部注入临时目录——
 * userDataDir / 工作区根 / 配置文件均由用例自建，不断言任何仓库环境态默认路径。
 * 全部经宿主核心公共 API（createHostService.dispatch）驱动——E2E 行为证明纪律。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createHostService } from '../src/host-core/service.ts'
import { sessionsDirFor } from '../src/host-core/sessions.ts'
import { probeSeam } from '../src/host-core/probe.ts'

function tmpRoot(label) {
  return mkdtempSync(join(tmpdir(), `car-desktop-${label}-`))
}

function makeService(label) {
  return createHostService({ userDataDir: tmpRoot(label) })
}

async function registerGoodWorkspace(svc, root) {
  writeFileSync(join(root, 'car.config.ts'), "export default { llm: { model: 'test-model' } }\n", 'utf8')
  return svc.dispatch('workspace:register', { path: root })
}

test('probe：seam 版本形态 + 宿主消费符号在位（调用点核验，非清单冻结）', () => {
  const probe = probeSeam()
  assert.match(probe.seamVersion, /^\d+\.\d+\.\d+/)
  assert.match(probe.nodeVersion, /^\d+\./)
  assert.ok(probe.symbolCount > 10, `符号计数异常：${probe.symbolCount}`)
  assert.deepEqual(probe.symbols.sort(), [...probe.symbols].sort())
  for (const name of ['SessionLog', 'SessionFileStore', 'loadCarConfig', 'warmCarConfig']) {
    assert.ok(probe.symbols.includes(name), `seam 缺少宿主消费符号 ${name}`)
  }
})

test('工作区注册：合法 config 装载成功，configPath 在册', async () => {
  const svc = makeService('good')
  const root = tmpRoot('ws-good')
  const info = await registerGoodWorkspace(svc, root)
  assert.equal(info.path, root)
  assert.equal(info.name, root.split(/[\\/]/).pop())
  assert.ok(info.configPath && info.configPath.endsWith('car.config.ts'))
  assert.equal(info.configError, null)
})

test('工作区注册：无 config 为正常态（configPath = null）', async () => {
  const svc = makeService('noconf')
  const root = tmpRoot('ws-noconf')
  const info = await svc.dispatch('workspace:register', { path: root })
  assert.equal(info.configPath, null)
})

test('工作区注册：坏 config fail-visible（CAR-E-CONFIG，拒绝注册）', async () => {
  const svc = makeService('bad')
  const root = tmpRoot('ws-bad')
  writeFileSync(join(root, 'car.config.ts'), "export default { notARegisteredKey: true }\n", 'utf8')
  await assert.rejects(
    () => svc.dispatch('workspace:register', { path: root }),
    (err) => /CAR-E-CONFIG/.test(err.message),
  )
  // 拒绝注册后索引不得残留半态
  assert.deepEqual(await svc.dispatch('workspace:list'), [])
})

test('工作区注册：目录不存在 / 相对路径 fail-visible', async () => {
  const svc = makeService('badpath')
  const ghost = join(tmpRoot('ws-ghost'), 'does-not-exist')
  await assert.rejects(() => svc.dispatch('workspace:register', { path: ghost }), /不存在或非目录/)
  await assert.rejects(() => svc.dispatch('workspace:register', { path: 'relative/path' }), /绝对路径/)
})

test('工作区注册：同路径幂等（重复注册不产生重复条目）', async () => {
  const svc = makeService('dup')
  const root = tmpRoot('ws-dup')
  await svc.dispatch('workspace:register', { path: root })
  const info2 = await svc.dispatch('workspace:register', { path: root })
  const list = await svc.dispatch('workspace:list')
  assert.equal(list.length, 1)
  assert.equal(info2.id, list[0].id)
})

test('会话生命周期：create 落 session-start 进 JSONL + list/open 读回一致', async () => {
  const svc = makeService('sess')
  const root = tmpRoot('ws-sess')
  const ws = await registerGoodWorkspace(svc, root)
  const sess = await svc.dispatch('session:create', { workspaceId: ws.id })
  assert.match(sess.sessionId, /^S-[a-z0-9]+-[a-f0-9]{4}$/)
  assert.ok(existsSync(join(sessionsDirFor(root), sess.sessionId + '.jsonl')), '会话 JSONL 未落盘')
  assert.equal(sess.eventCount, 1)

  const list = await svc.dispatch('session:list', { workspaceId: ws.id })
  assert.equal(list.length, 1)
  assert.equal(list[0].sessionId, sess.sessionId)
  assert.equal(list[0].eventCount, 1)

  const opened = await svc.dispatch('session:open', { workspaceId: ws.id, sessionId: sess.sessionId })
  assert.equal(opened.exists, true)
  assert.equal(opened.eventCount, 1)
})

test('会话生命周期：未知工作区 / 非法 sessionId fail-visible', async () => {
  const svc = makeService('sess-err')
  await assert.rejects(() => svc.dispatch('session:create', { workspaceId: 'nosuch' }), /未知工作区/)
  const root = tmpRoot('ws-sess-err')
  const ws = await svc.dispatch('workspace:register', { path: root })
  await assert.rejects(
    () => svc.dispatch('session:open', { workspaceId: ws.id, sessionId: '../escape' }),
    /非法 会话 id/,
  )
})

test('dispatch：载荷缺字段 / 未知通道 fail-visible', async () => {
  const svc = makeService('dispatch')
  await assert.rejects(() => svc.dispatch('workspace:register', {}), /缺少 path/)
  await assert.rejects(() => svc.dispatch('session:create', {}), /缺少 workspaceId/)
  await assert.rejects(() => svc.dispatch('channel:not-in-contract', {}), /未知 IPC 通道/)
})

test('门禁前提：临时目录注入生效（userData 不落默认路径）', async () => {
  const userData = tmpRoot('idx')
  const svc = createHostService({ userDataDir: userData })
  const root = tmpRoot('ws-idx')
  await svc.dispatch('workspace:register', { path: root })
  assert.ok(existsSync(join(userData, 'workspaces.json')), '工作区索引未落在注入 userDataDir')
  const idx = JSON.parse(await import('node:fs').then((m) => m.readFileSync(join(userData, 'workspaces.json'), 'utf8')))
  assert.equal(idx.workspaces.length, 1)
})
