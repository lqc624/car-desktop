/**
 * B-2 · 浏览器网络授权 grants 持久化存储（§4.7 consent 模型五条硬化的存储面落实）
 *
 * 口径（提案 §4.7 / D-B2 批内登记）：
 *  - **grant 持久化按 (会话 id, 域名身份) 分片**：`browser_open@<domain>`——跨宿主重启存活、
 *    跨会话不共享（key1 = sessionId）；browser_act 无 url 参数不持久化（act 域名粒度 = 当前页
 *    域已过 open 轴——登记），高危子集恒走人审门不受 grant 影响；
 *  - **派发前重查**：每次 authorize 现读盘面（不信任内存缓存——撤销立即生效）；
 *  - **存储失败 = 拒绝授权与派发**（fail-visible）：损坏文件抛错 → authorize deny，绝不降级
 *    临时授权；文件缺失 = 出厂空表（非失败）；
 *  - **revoke 语义**：revokeAll = 清空落盘（「已派发输入不可撤销」由浏览器工具错误文案与
 *    description 声明——DSH 同款）；
 *  - 存储位置 = userData/browser-grants.json（与 browser-settings.json 同域——控制面数据）。
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs'

export interface BrowserGrantsFile {
  version: 1
  updatedAt: number
  /** key1 = sessionId；key2 = `browser_open@<domain>`；value = 授予时刻 */
  grants: Record<string, Record<string, number>>
}

export interface BrowserGrantsStore {
  /** 派发前重查（现读盘——撤销立即生效）；存储失败抛错（authorize 侧捕获 = deny） */
  has(sessionId: string, key: string): boolean
  /** 授予（session 三档响应时写盘） */
  grant(sessionId: string, key: string): void
  /** revoke：清空落盘（设置页「清除浏览器授权记录」动作） */
  revokeAll(): void
  /** 面向设置页/doctor 的只读快照（异常回空） */
  snapshot(): BrowserGrantsFile
}

const EMPTY: BrowserGrantsFile = { version: 1, updatedAt: 0, grants: {} }

export function createBrowserGrantsStore(file: string): BrowserGrantsStore {
  const read = (): BrowserGrantsFile => {
    let raw: string
    try {
      raw = readFileSync(file, 'utf8') // ENOENT → 出厂空表（非失败）
    } catch {
      return { ...EMPTY, grants: {} }
    }
    // 损坏 = 存储失败 → 抛错（authorize 捕获 = deny——§4.7 第 4 条绝不降级临时授权）
    let parsed: BrowserGrantsFile
    try {
      parsed = JSON.parse(raw) as BrowserGrantsFile
    } catch {
      throw new Error('CAR-E-BROWSER-GRANTS: browser-grants.json 形态损坏（fail-visible——拒绝授权与派发，清除动作可修复）')
    }
    if (parsed?.version !== 1 || typeof parsed.grants !== 'object' || parsed.grants === null) {
      throw new Error('CAR-E-BROWSER-GRANTS: browser-grants.json 形态损坏（fail-visible——拒绝授权与派发，清除动作可修复）')
    }
    return parsed
  }
  const write = (f: BrowserGrantsFile): void => {
    writeFileSync(file, JSON.stringify({ ...f, updatedAt: Date.now() }, null, 2), 'utf8')
  }
  return {
    has(sessionId, key) {
      const f = read()
      return typeof f.grants[sessionId]?.[key] === 'number'
    },
    grant(sessionId, key) {
      const f = read()
      const row = f.grants[sessionId] ?? {}
      row[key] = Date.now()
      write({ ...f, grants: { ...f.grants, [sessionId]: row } })
    },
    revokeAll() {
      try {
        rmSync(file, { force: true })
      } catch (e) {
        throw new Error(`CAR-E-BROWSER-GRANTS: 授权记录清除失败（${e instanceof Error ? e.message : String(e)}）`)
      }
    },
    snapshot() {
      try {
        return read()
      } catch {
        return { ...EMPTY, grants: {} }
      }
    },
  }
}

/** browser_open url → 域名身份（grant key 组装——无效 url 返回 null 不授予） */
export function domainOfUrl(url: string): string | null {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.host : null
  } catch {
    return null
  }
}
