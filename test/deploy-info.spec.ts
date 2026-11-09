/**
 * T-DY 部署数据面单测（src/main/deployInfo.ts——fetchReleases loopback apiBase；
 * 真实 api.github.com 拉取走打包形态终端验收——CI 限流面禁真网依赖）。
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { test } from 'node:test'
import { fetchReleases } from '../src/main/deployInfo.ts'
import { DEPLOY_REPO, RELEASES_URL } from '../src/shared/deploy.ts'

async function withServer(json: string, status = 200): Promise<{ server: Server; base: Promise<string> }> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(json)
  })
  const base = new Promise<string>((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(server.address() as { port: number }).port}`)))
  return { server, base }
}

test('DY-1 fetchReleases 规范化：字段映射 / draft 剔除 / prerelease 标记', async () => {
  const { server, base } = await withServer(
    JSON.stringify([
      { tag_name: 'v0.7.0-beta.1', name: 'v0.7.0-beta.1', published_at: '2026-11-08T10:00:00Z', prerelease: true, html_url: 'https://github.com/lqc123qwe/car-desktop/releases/tag/v0.7.0-beta.1', draft: false },
      { tag_name: 'v0.6.2', name: 'v0.6.2', published_at: '2026-11-07T12:00:00Z', prerelease: false, html_url: 'https://github.com/lqc123qwe/car-desktop/releases/tag/v0.6.2' },
      { tag_name: 'v0.6.1', draft: true },
    ]),
  )
  try {
    const releases = await fetchReleases(await base, 'lqc123qwe/car-desktop')
    assert.equal(releases.length, 2, 'draft 不出表')
    assert.equal(releases[0]!.tag, 'v0.7.0-beta.1')
    assert.equal(releases[0]!.prerelease, true)
    assert.equal(releases[1]!.tag, 'v0.6.2')
    assert.equal(releases[1]!.prerelease, false)
    assert.equal(releases[1]!.publishedAt, '2026-11-07T12:00:00Z')
    assert.ok(releases[1]!.url.includes('/tag/v0.6.2'))
  } finally {
    await new Promise<void>((r) => server.close(() => r()))
  }
})

test('DY-2 fail-visible：非 200 / 坏 JSON / 网络错', async () => {
  const s1 = await withServer('{"message":"Not Found"}', 404)
  await assert.rejects(async () => fetchReleases(await s1.base), (e: Error) => /HTTP 404/.test(e.message))
  await new Promise<void>((r) => s1.server.close(() => r()))

  const s2 = await withServer('{broken')
  await assert.rejects(async () => fetchReleases(await s2.base), (e: Error) => /解析失败/.test(e.message))
  await new Promise<void>((r) => s2.server.close(() => r()))

  await assert.rejects(async () => fetchReleases('http://127.0.0.1:9'), (e: Error) => /拉取失败|超时/.test(e.message))
})

test('DY-3 坐标单一事实源：shared/deploy 常量 = package.json build.publish', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    build: { publish: { provider: string; owner: string; repo: string } }
  }
  const pub = pkg.build.publish
  assert.equal(pub.provider, 'github')
  assert.equal(DEPLOY_REPO, `${pub.owner}/${pub.repo}`, 'shared/deploy 常量必须与 build.publish 同值')
  assert.equal(RELEASES_URL, `https://github.com/${DEPLOY_REPO}/releases`)
})

test('DY-4 坐标禁手抄：src 内不得出现旧占位仓库 slug（D-10 回归）', () => {
  // 界面标签曾硬编码旧占位（lqc123qwe/car-desktop），与真拉取坐标分叉——显示与事实不符。
  // 坐标只许来自 shared/deploy.ts；测试 fixture 里的显式入参不属本约束（只扫 src）。
  // 注意判据是**仓库 slug** 不是裸 owner——`@lqc123qwe/car-runtime` 是 npm 作用域，合法。
  const stale = 'lqc123qwe/car-desktop'
  const files = readdirSync(new URL('../src', import.meta.url), { recursive: true }) as string[]
  const hits = files
    .filter((f) => /\.(ts|tsx)$/.test(f))
    .map((f) => f.replace(/\\/g, '/'))
    .filter((f) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8').includes(stale))
  assert.deepEqual(hits, [], `以下文件仍手抄旧坐标：${hits.join(', ')}`)
})
