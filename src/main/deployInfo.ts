/**
 * T-DY 部署视图数据面（main 侧——node:https 拉取 GitHub Releases；同 updater 坐标源）
 *
 * 口径：
 *  - **真数据纪律**：releases = api.github.com 真拉取（updater 同仓坐标——api.github.com 通道
 *    已被 updater 跨版本首验证实可达；github.com:443 阻断仅影响下载面不影响查询面）；
 *    拉取失败 = error 上抛（渲染层红字空态）——禁假数据（示意值文化）；
 *  - apiBase 注入（测试 loopback）；UA 头必备（GitHub API 无 UA = 403）；
 *  - 本模块属 main 侧能力（updater 同款——不入宿主 dispatch，host-core 零网络纪律不变）。
 */
import { get } from 'node:https'
import { get as httpGet } from 'node:http'
import type { DeployReleaseDTO } from '../shared/ipc-contract.ts'
import { DEPLOY_REPO } from '../shared/deploy.ts'

/** 发布仓坐标（单一事实源在 shared/deploy.ts——渲染层标签同源，禁手抄字面量） */
export { DEPLOY_REPO }

interface RawRelease {
  tag_name?: unknown
  name?: unknown
  published_at?: unknown
  prerelease?: unknown
  html_url?: unknown
  draft?: unknown
}

/** GitHub Releases 真拉取（apiBase 注入——生产 api.github.com；测试 loopback）；draft 不出表 */
export function fetchReleases(apiBase: string, repo: string = DEPLOY_REPO): Promise<DeployReleaseDTO[]> {
  const url = `${apiBase}/repos/${repo}/releases?per_page=8`
  const client = url.startsWith('http://') ? httpGet : get
  return new Promise((resolve, reject) => {
    const req = client(
      url,
      { headers: { 'user-agent': 'car-desktop-deploy-view', accept: 'application/vnd.github+json' }, timeout: 10_000 },
      (res) => {
        if ((res.statusCode ?? 500) !== 200) {
          res.resume()
          reject(new Error(`CAR-E-DESKTOP: GitHub Releases 拉取失败（HTTP ${res.statusCode}）`))
          return
        }
        let body = ''
        res.on('data', (c: Buffer) => (body += c.toString('utf8')))
        res.on('end', () => {
          try {
            const arr = JSON.parse(body) as RawRelease[]
            if (!Array.isArray(arr)) throw new Error('响应不是数组')
            resolve(
              arr
                .filter((r) => r.draft !== true && typeof r.tag_name === 'string')
                .map((r) => ({
                  tag: String(r.tag_name),
                  name: typeof r.name === 'string' && r.name ? r.name : String(r.tag_name),
                  publishedAt: typeof r.published_at === 'string' ? r.published_at : '',
                  prerelease: r.prerelease === true,
                  url: typeof r.html_url === 'string' ? r.html_url : '',
                })),
            )
          } catch (err) {
            reject(new Error(`CAR-E-DESKTOP: GitHub Releases 响应解析失败（${err instanceof Error ? err.message : String(err)}）`))
          }
        })
      },
    )
    req.on('timeout', () => {
      req.destroy(new Error('CAR-E-DESKTOP: GitHub Releases 拉取超时（10s）'))
    })
    req.on('error', (err) => {
      reject(new Error(`CAR-E-DESKTOP: GitHub Releases 拉取失败（${err.message}）`))
    })
  })
}
