/**
 * v0.19 C1 · RW-2 知识回流开关持久化（per-workspace；personalizationStore 形态镜像）
 *
 * 口径：
 *  - 存储 = `userData/repo-wiki/<wsId>/settings.json`（与 manifest 同目录自然归属——wiki 未生成
 *    时 store 仍可持有出厂态；分置先例 = bash-wakeup.json）；原子写 = tmp + rename；
 *  - `backflowEnabled` 缺省 **false**（deny-by-default 血统——D-46 修订版红线下的显式开关）；
 *  - 读取校验失败 = 回退出厂态并写回（不 fail-open 到开启态）+ console 留痕；
 *  - 开关变更是设置操作、不入会话链；注入事实经 sendTurn 每轮对账落链（审计口径）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export interface RepoWikiSettings {
  version: 1
  updatedAt: number
  /** RW-2 知识回流引用开关（缺省关 = 零注入零落链） */
  backflowEnabled: boolean
}

export interface RepoWikiSettingsStore {
  get(): RepoWikiSettings
  /** 部分更新（白名单键合并；返回规范态） */
  set(patch: { backflowEnabled?: boolean }): RepoWikiSettings
}

function factorySettings(): RepoWikiSettings {
  return { version: 1, updatedAt: Date.now(), backflowEnabled: false }
}

function validate(input: unknown): RepoWikiSettings {
  const p = (input ?? {}) as Record<string, unknown>
  if (p['version'] !== 1) throw new Error('CAR-E-DESKTOP: repoWikiSettings version 必须为 1')
  return {
    version: 1,
    updatedAt: typeof p['updatedAt'] === 'number' ? p['updatedAt'] : Date.now(),
    backflowEnabled: p['backflowEnabled'] === true,
  }
}

export function createRepoWikiSettingsStore(repoWikiDir: string): RepoWikiSettingsStore {
  const file = path.join(repoWikiDir, 'settings.json')
  const persist = (s: RepoWikiSettings): RepoWikiSettings => {
    mkdirSync(repoWikiDir, { recursive: true })
    const tmp = file + '.tmp'
    writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8')
    renameSync(tmp, file) // 原子写：tmp + rename（同卷 rename 原子语义）
    return s
  }
  const load = (): RepoWikiSettings => {
    if (!existsSync(file)) return factorySettings() // 未持久化 = 出厂态（不落盘——开启时才写）
    try {
      return validate(JSON.parse(readFileSync(file, 'utf8')))
    } catch (err) {
      // 损坏回退：出厂态（关）+ 留痕（禁 fail-open 到开启态）；回退态写回，后续读取稳定
      console.error('[host] repo-wiki settings.json 损坏，回退出厂态：', err instanceof Error ? err.message : err)
      return persist(factorySettings())
    }
  }
  let current = load()
  return {
    get: () => current,
    set(patch) {
      const next: RepoWikiSettings = {
        version: 1,
        updatedAt: Date.now(),
        backflowEnabled: typeof patch['backflowEnabled'] === 'boolean' ? patch['backflowEnabled'] : current.backflowEnabled,
      }
      current = persist(validate(next))
      return current
    },
  }
}
