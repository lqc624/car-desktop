/**
 * zb17 · C6（LF-1 链盘对账）行为测试（纯模块 + 宿主 doctor 行）
 *
 * 判据：
 *  - 纯函数：案 B（回执自含 sha256）/ 案 A（老链重放 args.content）/ 漂移（size/hash 不符）/
 *    链删一致（fs_delete 收口 + 盘缺 = deleted 一致面）/ 外删红（fs_write 后盘缺 = deleted + 红）/
 *    链外重建（fs_delete 后盘有 = drift）/ 子链入账（跨链 last-wins by ts）；
 *  - E2E：doctor:run 对账行（漂移红 + 盲区脚注常驻）。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { collectChainDiskRecon, type ChainDiskReconRow } from '../src/host-core/reconciliation.ts'
import { summarizeChainDiskRecon } from '../src/host-core/doctor.ts'
import { createHostService } from '../src/host-core/service.ts'
import type { WorkspaceInfo } from '../src/shared/ipc-contract.ts'

function tmpDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `car-zb17-c6-`))
}

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')

/** 会话 JSONL 行构造（事件形态 = 内核 1.24 实查镜像——对账面免验链） */
const call = (seq: number, ts: number, id: string, tool: string, args: Record<string, unknown>): string =>
  JSON.stringify({ seq, ts, actor: 'model', kind: 'toolCall', turnId: 'T1', payload: { id, tool, args }, prevHash: '', hash: '' })
const result = (seq: number, ts: number, id: string, payload: Record<string, unknown>): string =>
  JSON.stringify({ seq, ts, actor: 'runtime', kind: 'toolResult', turnId: 'T1', payload: { id, ...payload }, prevHash: '', hash: '' })

function setup(): { root: string; sessionsDir: string } {
  const root = tmpDir('ws')
  const sessionsDir = join(root, '.car', 'sessions')
  mkdirSync(sessionsDir, { recursive: true })
  return { root, sessionsDir }
}

test('C6·案 B（回执自含 sha256）+ 案 A（老链重放）+ 漂移', () => {
  const { root, sessionsDir } = setup()
  writeFileSync(join(root, 'a.txt'), 'AAA', 'utf8')
  writeFileSync(join(root, 'b.txt'), 'BBB', 'utf8')
  writeFileSync(join(root, 'c.txt'), 'CCC', 'utf8')
  writeFileSync(
    join(sessionsDir, 'S1.jsonl'),
    [
      call(1, 1000, 'c1', 'fs_write', { path: 'a.txt', content: 'AAA' }),
      result(2, 1001, 'c1', { ok: true, path: 'a.txt', bytes: 3, sha256: sha('AAA') }), // 案 B
      call(3, 1002, 'c2', 'fs_write', { path: 'b.txt', content: 'BBB' }),
      result(4, 1003, 'c2', { ok: true, path: 'b.txt', bytes: 3 }), // 案 A（老链无指纹）
      call(5, 1004, 'c3', 'fs_write', { path: 'c.txt', content: 'CCC' }),
      // 嵌套形态（内核 1.27 真实链——成功 = { id, result: {…工具返回} }）：c.txt 走嵌套回执
      result(6, 1005, 'c3', { result: { ok: true, path: 'c.txt', bytes: 3, sha256: sha('CCC') } }),
      call(7, 1006, 'c4', 'fs_write', { path: 'x.txt', content: 'fail' }),
      result(8, 1007, 'c4', { ok: false, error: 'CAR-E-DESKTOP: fs_write 目标越界' }), // 失败不入账
    ].join('\n'),
    'utf8',
  )
  writeFileSync(join(root, 'c.txt'), 'CCC-modified', 'utf8') // 盘面漂移
  const r = collectChainDiskRecon(sessionsDir, root)
  assert.equal(r.sessions, 1)
  const byPath = new Map(r.rows.map((row) => [row.path, row]))
  assert.equal(byPath.get('a.txt')!.state, 'match', '案 B 指纹一致')
  assert.equal(byPath.get('a.txt')!.sha256, sha('AAA'))
  assert.equal(byPath.get('b.txt')!.state, 'match', '案 A 重放一致（老链兜底）')
  assert.equal(byPath.get('b.txt')!.sha256, sha('BBB'))
  assert.equal(byPath.get('c.txt')!.state, 'drift', '盘面 hash 不符 = 漂移')
  assert.equal(byPath.get('x.txt'), undefined, '失败操作不入账')
})

test('C6·链删一致（fs_delete 收口 + 盘缺）+ 外删红（fs_write 后盘缺）+ 链外重建（drift）', () => {
  const { root, sessionsDir } = setup()
  // d1.txt：写入后链上删除（收口）→ 盘缺 = deleted 一致面
  // d2.txt：写入后盘面被外删（链上无删除）→ deleted + 红
  // d3.txt：链上删除后盘面在件（链外重建）→ drift
  writeFileSync(
    join(sessionsDir, 'S1.jsonl'),
    [
      call(1, 1000, 'c1', 'fs_write', { path: 'd1.txt', content: 'D1' }),
      result(2, 1001, 'c1', { ok: true, path: 'd1.txt', bytes: 2, sha256: sha('D1') }),
      call(3, 1002, 'c2', 'fs_delete', { path: 'd1.txt' }),
      result(4, 1003, 'c2', { ok: true, path: 'd1.txt', deletedSha256: sha('D1'), deletedBytes: 2 }),
      call(5, 1004, 'c3', 'fs_write', { path: 'd2.txt', content: 'D2' }),
      result(6, 1005, 'c3', { ok: true, path: 'd2.txt', bytes: 2, sha256: sha('D2') }),
      call(7, 1006, 'c4', 'fs_write', { path: 'd3.txt', content: 'D3' }),
      result(8, 1007, 'c4', { ok: true, path: 'd3.txt', bytes: 2, sha256: sha('D3') }),
      call(9, 1008, 'c5', 'fs_delete', { path: 'd3.txt' }),
      result(10, 1009, 'c5', { ok: true, path: 'd3.txt' }),
    ].join('\n'),
    'utf8',
  )
  writeFileSync(join(root, 'd3.txt'), 'recreated', 'utf8') // 链外重建
  // d2.txt 不创建（外删形态）
  const r = collectChainDiskRecon(sessionsDir, root)
  const byPath = new Map(r.rows.map((row) => [row.path, row]))
  const d1 = byPath.get('d1.txt')!
  assert.equal(d1.state, 'deleted')
  assert.equal(d1.lastOp, 'fs_delete')
  assert.equal(d1.sha256, sha('D1'), '被删件指纹在案（删前现读——案 B 删除面）')
  const d2 = byPath.get('d2.txt')!
  assert.equal(d2.state, 'deleted')
  assert.equal(d2.lastOp, 'fs_write')
  const d3 = byPath.get('d3.txt')!
  assert.equal(d3.state, 'drift', '链上删除后盘面在件 = 漂移（链外重建）')
  // doctor 汇总：d2（外删）+ d3（链外重建）= 红；d1 = 一致面绿
  const row = summarizeChainDiskRecon(r.rows, r.sessions, r.warnings)
  assert.equal(row.ok, false, '外删 + 链外重建 = 待关注红行')
  assert.match(row.detail, /待关注 2/)
})

test('C6·子链入账 + 跨链 last-wins（ts 定序）+ doctor 盲区脚注常驻', () => {
  const { root, sessionsDir } = setup()
  writeFileSync(join(root, 'z.txt'), 'v1', 'utf8')
  // 主链早写、子链晚写（ts 更大 = 末次）——对账源 = 全部链
  writeFileSync(
    join(sessionsDir, 'main.jsonl'),
    [call(1, 1000, 'm1', 'fs_write', { path: 'z.txt', content: 'v1' }), result(2, 1001, 'm1', { ok: true, path: 'z.txt', bytes: 2, sha256: sha('v1') })].join('\n'),
    'utf8',
  )
  writeFileSync(
    join(sessionsDir, 'main--sub1.jsonl'),
    [call(1, 2000, 's1', 'fs_write', { path: 'z.txt', content: 'v2-longer' }), result(2, 2001, 's1', { ok: true, path: 'z.txt', bytes: 9, sha256: sha('v2-longer') })].join('\n'),
    'utf8',
  )
  rmSync(join(root, 'z.txt'))
  writeFileSync(join(root, 'z.txt'), 'v2-longer', 'utf8')
  const r = collectChainDiskRecon(sessionsDir, root)
  assert.equal(r.sessions, 2, '全部链入账（主链 + 子链）')
  const row: ChainDiskReconRow | undefined = r.rows.find((x) => x.path === 'z.txt')
  assert.ok(row)
  assert.equal(row!.sessionId, 'main--sub1', '跨链 last-wins（ts 定序）')
  assert.equal(row!.state, 'match')
  const doctorRow = summarizeChainDiskRecon(r.rows, r.sessions, r.warnings)
  assert.equal(doctorRow.ok, true)
  assert.match(doctorRow.detail, /bash_run\/浏览器写\/进程外修改不经本对账/, '盲区脚注常驻')
  assert.match(doctorRow.detail, /1 路径/, '路径计数在位')
  assert.match(doctorRow.detail, /1 一致/, '一致计数在位')
})

test('C6 E2E·doctor:run 对账行在位（漂移红行 + 盲区脚注）', async () => {
  const userData = tmpDir('ud')
  const root = tmpDir('ws')
  writeFileSync(join(root, 'car.config.ts'), "export default { llm: { baseUrl: 'http://127.0.0.1:9', model: 'test-model' } }\n", 'utf8')
  writeFileSync(join(root, 'e.txt'), 'EEE', 'utf8')
  const sessionsDir = join(root, '.car', 'sessions')
  mkdirSync(sessionsDir, { recursive: true })
  writeFileSync(
    join(sessionsDir, 'S1.jsonl'),
    [call(1, 1000, 'c1', 'fs_write', { path: 'e.txt', content: 'EEE' }), result(2, 1001, 'c1', { ok: true, path: 'e.txt', bytes: 3, sha256: sha('EEE') })].join('\n'),
    'utf8',
  )
  writeFileSync(join(root, 'e.txt'), 'EEE-modified-longer', 'utf8') // 盘面漂移
  const svc = createHostService({ userDataDir: userData })
  try {
    const ws = (await svc.dispatch('workspace:register', { path: root })) as WorkspaceInfo
    const r = (await svc.dispatch('doctor:run', { workspaceId: ws.id })) as { rows: Array<{ label: string; ok: boolean; detail: string }> }
    const recon = r.rows.find((x) => x.label === '链盘对账')
    assert.ok(recon, '链盘对账行在位')
    assert.equal(recon!.ok, false, '漂移 = 红行 fail-visible')
    assert.match(recon!.detail, /e\.txt/)
    assert.match(recon!.detail, /盲区常驻/)
  } finally {
    svc.dispose()
  }
})
