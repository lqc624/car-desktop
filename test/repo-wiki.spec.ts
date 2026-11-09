/**
 * T-RW RepoWiki E2E（宿主公共 API 驱动；LLM 直调 = 真 chatStep 经计数版 loopback SSE——
 * 请求 1 = 大纲 JSON、后续 = 页面 md）
 *
 * 判据：
 *  - RW-1 全链：scan（排除面/预算）→ outline → 逐页 → 落盘 userData/repo-wiki/<wsId>/
 *    （manifest+pages 读回对拍）+ 链叙事 scan|outline|page|done + push pct 序列 + usage 累计；
 *  - RW-2 排除面：.git/node_modules 剪枝 + .car 出厂拒绝 + 二进制分类计数；
 *  - RW-3 fail-visible：ghost 会话 / 同工作区叠跑；
 *  - RW-4 stop：大纲后停止 → aborted 叙事 + push aborted（旧 manifest 不被破坏）；
 *  - RW-5 repoWikiGet roundtrip（pages 随 md 正文）。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { test } from 'node:test'
import { createHostService, type HostService, type PushMessage } from '../src/host-core/service.ts'
import type { RepoWikiManifestDTO, RepoWikiPush, WorkspaceInfo } from '../src/shared/ipc-contract.ts'

function tmpDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `car-rw-${label}-`))
}

/** 计数版 SSE：按请求序号返回脚本内容（请求 1 = 大纲、后续 = 页面 md；脚本尽 = 重复末项） */
async function startScriptedSse(scripts: string[]): Promise<{ server: Server; port: number; bodies: string[] }> {
  const bodies: string[] = []
  const server: Server = createServer((req, res) => {
    let body = ''
    req.on('data', (c: Buffer) => (body += c.toString('utf8')))
    req.on('end', () => {
      bodies.push(body)
      const idx = Math.min(bodies.length - 1, scripts.length - 1)
      const content = scripts[idx]
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(
        `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n` +
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n` +
          'data: [DONE]\n\n',
      )
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { server, port: (server.address() as { port: number }).port, bodies }
}

const OUTLINE = JSON.stringify([
  { id: '00', title: '项目总览', files: ['README.md', 'src/index.ts'], focus: '架构与边界' },
  { id: '01', title: '核心模块', files: ['src/index.ts'], focus: '实现要点' },
])

function makeEnv(userData: string, port: number): HostService {
  const prevKey = process.env.CAR_RW_KEY
  process.env.CAR_RW_KEY = 'sk-rw-loopback-test' // secrets-scan:allow dummy loopback endpoint credential (fixture, not a real key)
  const svc = createHostService({ userDataDir: userData })
  ;(svc as HostService & { __restore?: () => void }).__restore = () => {
    if (prevKey === undefined) delete process.env.CAR_RW_KEY
    else process.env.CAR_RW_KEY = prevKey
  }
  return svc
}

function cleanupSvc(svc: HostService): void {
  ;(svc as HostService & { __restore?: () => void }).__restore?.()
  svc.dispose()
}

test('RW-1+RW-2 全链 + 排除面：scan→outline→pages→落盘读回对拍 + 链叙事 + push 序列', async () => {
  const { server, port } = await startScriptedSse([OUTLINE, '# 00 项目总览\n\n架构与边界说明。', '# 01 核心模块\n\n实现要点说明。'])
  const userData = tmpDir('ud')
  const root = tmpDir('ws')
  writeFileSync(join(root, 'car.config.ts'), `export default { llm: { baseUrl: 'http://127.0.0.1:9', model: 'test-model' }, modelPool: { endpoints: [{ id: 'live-ep', baseUrl: 'http://127.0.0.1:${port}', model: 'm-live', keyEnv: 'CAR_RW_KEY' }], probe: { enabled: false } } }\n`, 'utf8')
  // 语料 + 排除面：README/src 正常；.git/HEAD 与 node_modules/x.js 剪枝；.car/secret.json 出厂拒绝；data.bin 二进制
  writeFileSync(join(root, 'README.md'), '# demo repo\n\n入口说明。', 'utf8')
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'index.ts'), 'export const main = (): void => console.log(42)\n', 'utf8')
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8')
  mkdirSync(join(root, 'node_modules'), { recursive: true })
  writeFileSync(join(root, 'node_modules', 'x.js'), 'module.exports = 1\n', 'utf8')
  mkdirSync(join(root, '.car'), { recursive: true })
  writeFileSync(join(root, '.car', 'secret.json'), '{"k":1}', 'utf8')
  writeFileSync(join(root, 'data.bin'), Buffer.from([0, 1, 2, 3]))
  const svc = makeEnv(userData, port)
  const pushes: PushMessage[] = []
  svc.onPush((m) => pushes.push(m))
  try {
    const ws = (await svc.dispatch('workspace:register', { path: root })) as WorkspaceInfo
    const sess = (await svc.dispatch('session:create', { workspaceId: ws.id })) as { sessionId: string }
    const g = (await svc.dispatch('repoWiki:generate', { workspaceId: ws.id, sessionId: sess.sessionId })) as { runId: string }
    assert.match(g.runId, /^RW-/)
    // 等 done push（编排 fire-and-forget——poll deadline）
    const done = await (async (): Promise<RepoWikiPush> => {
      const deadline = Date.now() + 15_000
      for (;;) {
        const p = pushes
          .filter((m) => m.topic === 'push:repo-wiki')
          .map((m) => m.payload as RepoWikiPush)
          .filter((p) => p.runId === g.runId && p.step === 'done')
          .at(-1)
        if (p) return p
        if (Date.now() > deadline) throw new Error('等待 RepoWiki done 超时')
        await new Promise((r) => setTimeout(r, 25))
      }
    })()
    assert.equal(done.pagesDone, 2)
    // manifest + pages 落盘读回对拍
    const manifest = (await svc.dispatch('repoWiki:get', { workspaceId: ws.id })) as RepoWikiManifestDTO | null
    assert.ok(manifest, 'manifest 落盘')
    assert.deepEqual(
      manifest!.pages.map((p) => ({ id: p.id, title: p.title })),
      [
        { id: '00', title: '项目总览' },
        { id: '01', title: '核心模块' },
      ],
    )
    assert.ok(manifest!.pages.every((p) => typeof p.md === 'string' && p.md.length > 0), 'repoWikiGet 随 md 正文')
    assert.ok(manifest!.pages.some((p) => p.md!.includes('架构与边界')))
    assert.ok(manifest!.durationMs >= 0)
    // 落链叙事族
    const sys = (type: string): Array<Record<string, unknown>> =>
      pushes
        .filter((m) => m.topic === 'push:session-event')
        .map((m) => (m.payload as { event: { kind: string; payload: unknown } }).event)
        .filter((e) => e.kind === 'system' && (e.payload as Record<string, unknown>)['type'] === type)
        .map((e) => e.payload as Record<string, unknown>)
    const scan = sys('repo-wiki/scan').at(-1)!
    assert.equal(scan['fileCount'], 3, '语料 = README + index.ts（.git/node_modules/.car/bin 全排除）')
    assert.ok(Number(scan['totalChars']) > 0)
    const pruned = scan['prunedDirs'] as string[]
    assert.ok(pruned.includes('.git') && pruned.includes('node_modules') && pruned.includes('.car'), '剪枝目录随叙事（排除面审计事实）')
    const ex = scan['excluded'] as Record<string, number>
    assert.equal(ex['binary'], 1, '二进制分类计数（fs_read 管线拒读）')
    assert.equal(ex['denied'], 0, '.car 已被目录剪枝（不到 decide 面）')
    assert.ok(!((scan['files'] as string[]).some((f) => f.includes('.git') || f.includes('node_modules'))), '语料零 .git/node_modules 路径')
    assert.equal(sys('repo-wiki/outline').length, 1)
    assert.equal(sys('repo-wiki/page').length, 2)
    const doneEv = sys('repo-wiki/done').at(-1)!
    assert.equal(doneEv['pages'], 2)
    // push pct 单调不减
    const pcts = pushes
      .filter((m) => m.topic === 'push:repo-wiki')
      .map((m) => (m.payload as RepoWikiPush).pct)
    assert.ok(pcts.every((p, i) => i === 0 || p >= pcts[i - 1]!), `pct 序列单调：${pcts.join(',')}`)
  } finally {
    cleanupSvc(svc)
    await new Promise<void>((r) => server.close(() => r()))
  }
})

test('RW-3 fail-visible：ghost 会话不可续写 + 同工作区叠跑拒绝', async () => {
  const { server, port } = await startScriptedSse([OUTLINE, '# 慢页'])
  const userData = tmpDir('ud')
  const root = tmpDir('ws')
  writeFileSync(join(root, 'car.config.ts'), `export default { llm: { baseUrl: 'http://127.0.0.1:9', model: 'test-model' }, modelPool: { endpoints: [{ id: 'live-ep', baseUrl: 'http://127.0.0.1:${port}', model: 'm-live', keyEnv: 'CAR_RW_KEY' }], probe: { enabled: false } } }\n`, 'utf8')
  writeFileSync(join(root, 'README.md'), 'x', 'utf8')
  const svc = makeEnv(userData, port)
  const pushes: PushMessage[] = []
  svc.onPush((m) => pushes.push(m))
  try {
    const ws = (await svc.dispatch('workspace:register', { path: root })) as WorkspaceInfo
    const sess = (await svc.dispatch('session:create', { workspaceId: ws.id })) as { sessionId: string }
    await assert.rejects(
      () => svc.dispatch('repoWiki:generate', { workspaceId: ws.id, sessionId: 'ghost' }),
      (e: Error) => /会话不可续写/.test(e.message),
    )
    // 叠跑：第一次生成进行中（脚本尽 = 重复慢页——编排持续多请求），第二次 generate fail-visible
    await svc.dispatch('repoWiki:generate', { workspaceId: ws.id, sessionId: sess.sessionId })
    await assert.rejects(
      () => svc.dispatch('repoWiki:generate', { workspaceId: ws.id, sessionId: sess.sessionId }),
      (e: Error) => /进行中/.test(e.message),
    )
    // 收尾：停止 + 等 aborted
    await svc.dispatch('repoWiki:stop', { workspaceId: ws.id })
    const deadline = Date.now() + 8000
    for (;;) {
      const aborted = pushes
        .filter((m) => m.topic === 'push:session-event')
        .map((m) => (m.payload as { event: { kind: string; payload: unknown } }).event)
        .some((e) => e.kind === 'system' && (e.payload as Record<string, unknown>)['type'] === 'repo-wiki/aborted')
      if (aborted) break
      if (Date.now() > deadline) break // 编排可能在页边界自然收口——非硬断言
      await new Promise((r) => setTimeout(r, 25))
    }
  } finally {
    cleanupSvc(svc)
    await new Promise<void>((r) => server.close(() => r()))
  }
})

test('RW-4 stop：大纲后停止 → aborted 叙事 + 旧 manifest 不被破坏', async () => {
  const { server, port } = await startScriptedSse([OUTLINE, '# 页 A', '# 页 B'])
  const userData = tmpDir('ud')
  const root = tmpDir('ws')
  writeFileSync(join(root, 'car.config.ts'), `export default { llm: { baseUrl: 'http://127.0.0.1:9', model: 'test-model' }, modelPool: { endpoints: [{ id: 'live-ep', baseUrl: 'http://127.0.0.1:${port}', model: 'm-live', keyEnv: 'CAR_RW_KEY' }], probe: { enabled: false } } }\n`, 'utf8')
  writeFileSync(join(root, 'README.md'), 'x', 'utf8')
  // 预置旧 manifest（RW-4 前置：历史版本不被中途破坏）
  const wikiDir = join(userData, 'repo-wiki')
  const svcPre = createHostService({ userDataDir: userData })
  const ws = (await svcPre.dispatch('workspace:register', { path: root })) as WorkspaceInfo
  mkdirSync(join(wikiDir, ws.id, 'pages'), { recursive: true })
  writeFileSync(join(wikiDir, ws.id, 'manifest.json'), JSON.stringify({ workspaceId: ws.id, generatedAt: 1, model: 'old', durationMs: 1, pages: [{ id: '99', title: '旧页', chars: 1 }] }), 'utf8')
  writeFileSync(join(wikiDir, ws.id, 'pages', '99.md'), '旧正文', 'utf8')
  svcPre.dispose()
  const svc = makeEnv(userData, port)
  const pushes: PushMessage[] = []
  svc.onPush((m) => pushes.push(m))
  try {
    const sess = (await svc.dispatch('session:create', { workspaceId: ws.id })) as { sessionId: string }
    await svc.dispatch('repoWiki:generate', { workspaceId: ws.id, sessionId: sess.sessionId })
    await svc.dispatch('repoWiki:stop', { workspaceId: ws.id })
    // 等 aborted push
    const deadline = Date.now() + 10_000
    for (;;) {
      const p = pushes
        .filter((m) => m.topic === 'push:repo-wiki')
        .map((m) => m.payload as RepoWikiPush)
        .find((p) => p.step === 'aborted')
      if (p) break
      if (Date.now() > deadline) throw new Error('等待 aborted push 超时')
      await new Promise((r) => setTimeout(r, 25))
    }
    // 旧 manifest 未被破坏（中止 = 零写盘）
    const m = (await svc.dispatch('repoWiki:get', { workspaceId: ws.id })) as RepoWikiManifestDTO | null
    assert.equal(m!.pages[0]!.id, '99', '旧 manifest 完好（中止零写盘）')
    assert.ok(existsSync(join(wikiDir, ws.id, 'pages', '99.md')))
    const abortedEv = pushes
      .filter((x) => x.topic === 'push:session-event')
      .map((x) => (x.payload as { event: { kind: string; payload: unknown } }).event)
      .some((e) => e.kind === 'system' && (e.payload as Record<string, unknown>)['type'] === 'repo-wiki/aborted')
    assert.ok(abortedEv, 'repo-wiki/aborted 落链')
  } finally {
    cleanupSvc(svc)
    await new Promise<void>((r) => server.close(() => r()))
  }
})

test('RW-5 repoWikiGet：无生成 = null', async () => {
  const svc = createHostService({ userDataDir: tmpDir('ud') })
  try {
    const ws = (await svc.dispatch('workspace:register', { path: tmpDir('ws') })) as WorkspaceInfo
    assert.equal(await svc.dispatch('repoWiki:get', { workspaceId: ws.id }), null)
  } finally {
    svc.dispose()
  }
})
