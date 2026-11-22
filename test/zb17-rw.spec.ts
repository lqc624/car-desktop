/**
 * zb17 · C1（RW-5 滞后检测）+ C2（RW-4 导出）行为测试（宿主公共 API 驱动 + 纯函数单测）
 *
 * 判据：
 *  - C1 纯函数：buildBaseline（stats 快照 + 非 git estimated）/ staleBaseline（HEAD 前移全列 /
 *    HEAD 未变抓脏树 size+mtime / 盘上缺失 = 变更 / 生成后新增文件不触发）/ readGitHead（非 git = null）；
 *  - C1 E2E：生成 → manifest.baseline 在（语料面）→ 改源文件 → repoWiki:get stale.files 命中；
 *  - C2 E2E：导出（pages/*.md + manifest 副本，白名单写盘）+ repo-wiki/export 落链 +
 *    篡改 manifest（pageId 路径穿越形态）fail-visible。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { test } from 'node:test'
import { buildBaseline, readGitHead, staleBaseline, type WikiBaseline } from '../src/host-core/repoWiki.ts'
import { createHostService, type HostService, type PushMessage } from '../src/host-core/service.ts'
import type { RepoWikiManifestDTO, RepoWikiPush, WorkspaceInfo } from '../src/shared/ipc-contract.ts'

function tmpDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `car-zb17-${label}-`))
}

// ==================== C1 纯函数单测 ====================

test('C1·readGitHead：非 git 目录 = null（禁抛）', () => {
  const root = tmpDir('nogit')
  writeFileSync(join(root, 'a.txt'), 'x', 'utf8')
  assert.equal(readGitHead(root), null)
})

test('C1·readGitHead + staleBaseline：真 git 仓 HEAD 快捷判——前移 = 全列，未变仍抓脏树', () => {
  const root = tmpDir('git')
  writeFileSync(join(root, 'doc.txt'), 'v1', 'utf8')
  const g = (...args: string[]): void => {
    execFileSync('git', args, { cwd: root, stdio: 'ignore' })
  }
  g('init')
  g('add', '.')
  g('-c', 'user.email=t@t.local', '-c', 'user.name=t', 'commit', '-m', 'init')
  const head = readGitHead(root)
  assert.ok(head, 'git 仓 HEAD 可读')
  const baseline = buildBaseline(root, ['doc.txt'])
  assert.equal(baseline.estimated, false)
  assert.equal(baseline.gitHead, head)
  assert.ok(baseline.files['doc.txt'], '语料 stats 快照在')
  // HEAD 未变：脏树编辑（size 变）→ stats 面命中
  writeFileSync(join(root, 'doc.txt'), 'v2-longer-content', 'utf8')
  assert.deepEqual(staleBaseline(baseline, head, root).files, ['doc.txt'], 'HEAD 未变仍抓脏树')
  // 干净树：零变更（基线重建自当前盘态——重写文件必改 mtime，stats 对比面如实反映）
  const baseline2 = buildBaseline(root, ['doc.txt'])
  assert.deepEqual(staleBaseline(baseline2, head, root).files, [])
  // HEAD 前移：全语料列变更（即使树干净）
  writeFileSync(join(root, 'doc2.txt'), 'new', 'utf8')
  g('add', '.')
  g('-c', 'user.email=t@t.local', '-c', 'user.name=t', 'commit', '-m', 'second')
  const head2 = readGitHead(root)
  assert.notEqual(head2, head)
  const st = staleBaseline(baseline2, head2, root)
  assert.deepEqual(st.files, ['doc.txt'], 'HEAD 前移 = 全基线列变更（页级细化留 RW-1）')
  assert.equal(st.estimated, false)
})

test('C1·staleBaseline：非 git（estimated）stats 面——修改/删除命中、新增不触发、盘上缺失 = 变更', () => {
  const root = tmpDir('nogit-stale')
  writeFileSync(join(root, 'a.md'), 'aaa', 'utf8')
  writeFileSync(join(root, 'b.md'), 'bbb', 'utf8')
  // 基线由 buildBaseline 现读（stats 面真实快照——mtime 对比语义）
  const baseline: WikiBaseline = buildBaseline(root, ['a.md', 'b.md'])
  assert.equal(baseline.estimated, true, '非 git = estimated')
  // 未变更
  assert.deepEqual(staleBaseline(baseline, null, root).files, [])
  // 修改（size 变——mtime 粒度不可靠，断言走 size 确定面）
  writeFileSync(join(root, 'a.md'), 'aaaa', 'utf8')
  assert.deepEqual(staleBaseline(baseline, null, root).files, ['a.md'])
  // 修改 b + 新增 c：双命中且新增不触发（基线只覆盖生成语料面——N-R2）
  writeFileSync(join(root, 'b.md'), 'bbbb', 'utf8')
  writeFileSync(join(root, 'c.md'), 'new', 'utf8')
  assert.deepEqual(staleBaseline(baseline, null, root).files.sort(), ['a.md', 'b.md'])
  // 删除 = 变更（盘上缺失）
  rmSync(join(root, 'a.md'))
  assert.deepEqual(staleBaseline(baseline, null, root).files.sort(), ['a.md', 'b.md'], 'a 删除（缺失）+ b size 不符')
})

// ==================== C1/C2 E2E（宿主公共 API——脚本化 SSE 同 repo-wiki.spec 形态） ====================

async function startScriptedSse(scripts: string[]): Promise<{ server: Server; port: number }> {
  const bodies: string[] = []
  const server: Server = createServer((req, res) => {
    let body = ''
    req.on('data', (c: Buffer) => (body += c.toString('utf8')))
    req.on('end', () => {
      bodies.push(body)
      const idx = Math.min(bodies.length - 1, scripts.length - 1)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(
        `data: ${JSON.stringify({ choices: [{ delta: { content: scripts[idx] } }] })}\n\n` +
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n` +
          'data: [DONE]\n\n',
      )
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { server, port: (server.address() as { port: number }).port }
}

const OUTLINE = JSON.stringify([
  { id: '00', title: '项目总览', files: ['README.md'], focus: '架构与边界' },
])

async function waitForRepoWikiDone(svc: HostService, pushes: PushMessage[], runId: string): Promise<RepoWikiPush> {
  const deadline = Date.now() + 15_000
  for (;;) {
    const p = pushes
      .filter((m) => m.topic === 'push:repo-wiki')
      .map((m) => m.payload as RepoWikiPush)
      .filter((x) => x.runId === runId && (x.step === 'done' || x.step === 'error'))
      .at(-1)
    if (p) {
      if (p.step === 'error') throw new Error('RepoWiki 生成失败：' + (p.error ?? p.message))
      return p
    }
    if (Date.now() > deadline) throw new Error('等待 RepoWiki done 超时')
    await new Promise((r) => setTimeout(r, 25))
  }
}

test('C1+C2 E2E：生成落 baseline → 改源文件 stale 命中 → 导出白名单写盘 + 落链 → 篡改 manifest fail-visible', async () => {
  const { server, port } = await startScriptedSse([OUTLINE, '# 00 项目总览\n\n架构与边界说明。'])
  const prevKey = process.env.CAR_RW_KEY
  process.env.CAR_RW_KEY = 'sk-rw-loopback-test' // secrets-scan:allow dummy loopback endpoint credential (fixture, not a real key)
  const userData = tmpDir('ud')
  const root = tmpDir('ws')
  writeFileSync(join(root, 'car.config.ts'), `export default { llm: { baseUrl: 'http://127.0.0.1:9', model: 'test-model' }, modelPool: { endpoints: [{ id: 'live-ep', baseUrl: 'http://127.0.0.1:${port}', model: 'm-live', keyEnv: 'CAR_RW_KEY' }], probe: { enabled: false } } }\n`, 'utf8')
  writeFileSync(join(root, 'README.md'), '# demo repo\n\n入口说明。', 'utf8')
  const svc = createHostService({ userDataDir: userData })
  const pushes: PushMessage[] = []
  svc.onPush((m) => pushes.push(m))
  try {
    const ws = (await svc.dispatch('workspace:register', { path: root })) as WorkspaceInfo
    const sess = (await svc.dispatch('session:create', { workspaceId: ws.id })) as { sessionId: string }

    // ── C1：生成 → baseline 随 manifest 落盘（语料 stats + 非 git estimated） ──
    const g = (await svc.dispatch('repoWiki:generate', { workspaceId: ws.id, sessionId: sess.sessionId })) as { runId: string }
    await waitForRepoWikiDone(svc, pushes, g.runId)
    const manifest = (await svc.dispatch('repoWiki:get', { workspaceId: ws.id })) as RepoWikiManifestDTO | null
    assert.ok(manifest?.baseline, 'C1：baseline 随 manifest 记')
    assert.equal(manifest!.baseline!.estimated, true, '假 .git 目录非真仓 = estimated 估算口径')
    assert.deepEqual(
      Object.keys(manifest!.baseline!.files).sort(),
      ['README.md', 'car.config.ts'].sort(),
      '基线 = 生成语料面（扫描可读文本全量——car.config.ts 亦在语料）',
    )
    assert.deepEqual(manifest!.stale?.files, [], '生成即读 = 零滞后')

    // ── C1：改源文件 → stale 命中（读取时现算，不落盘） ──
    writeFileSync(join(root, 'README.md'), '# demo repo — v2 with more content', 'utf8')
    const stale1 = (await svc.dispatch('repoWiki:get', { workspaceId: ws.id })) as RepoWikiManifestDTO
    assert.deepEqual(stale1.stale?.files, ['README.md'], '滞后命中（size 变）')
    assert.ok(manifest && !('stale' in JSON.parse(readFileSync(join(userData, 'repo-wiki', ws.id, 'manifest.json'), 'utf8'))), 'stale 不落盘（读时现算）')

    // ── C2：导出（白名单写盘 + 落链） ──
    const outDir = tmpDir('out')
    const r = (await svc.dispatch('repoWiki:export', { workspaceId: ws.id, sessionId: sess.sessionId, dir: outDir })) as { ok: boolean; dir: string; fileCount: number }
    assert.equal(r.ok, true)
    assert.equal(r.fileCount, 2, '1 页 + manifest 副本')
    assert.ok(existsSync(join(outDir, 'manifest.json')))
    const exported = readFileSync(join(outDir, 'pages', '00.md'), 'utf8')
    assert.equal(exported, '# 00 项目总览\n\n架构与边界说明。', '页内容逐字节一致')
    const exportNarr = pushes
      .filter((m) => m.topic === 'push:session-event')
      .map((m) => (m.payload as { event: { kind: string; payload: Record<string, unknown> } }).event)
      .filter((e) => e.kind === 'system' && e.payload['type'] === 'repo-wiki/export')
      .map((e) => e.payload)
    assert.equal(exportNarr.length, 1, 'repo-wiki/export 落链一次')
    assert.equal(exportNarr[0]!['fileCount'], 2)

    // ── C2：篡改 manifest（pageId 路径穿越形态）→ 名单校验 fail-visible ──
    writeFileSync(
      join(userData, 'repo-wiki', ws.id, 'manifest.json'),
      JSON.stringify({ workspaceId: ws.id, generatedAt: 1, model: 'm', durationMs: 1, pages: [{ id: '../evil', title: 'E', chars: 1 }] }),
      'utf8',
    )
    await assert.rejects(() => svc.dispatch('repoWiki:export', { workspaceId: ws.id, sessionId: sess.sessionId, dir: outDir }), /名单校验失败/)
  } finally {
    if (prevKey === undefined) delete process.env.CAR_RW_KEY
    else process.env.CAR_RW_KEY = prevKey
    svc.dispose()
    server.close()
  }
})
