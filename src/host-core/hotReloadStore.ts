/**
 * C1 · 工具源热更新设置持久化（缺省关——D-V10-2 裁决，沿 1.20.0 P2 / T-B5 先例）
 *
 * 口径：
 *  - 存储 = `<userData>/hot-reload.json`（与 security-settings.json 分置——工具源面独立设置事实）；
 *    原子写 tmp+rename；损坏回退出厂值并写回（不 fail-open——securitySettingsStore 同款纪律）；
 *  - toolSourcesHot 出厂 = false（**缺省关**：热更新监听面复杂度风险 R-V10-5 的回退通道）；
 *  - 开关切换经 ToolSourceHotSet 通道即时生效（service 侧 start/stop watcher）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export interface HotReloadSettings {
  version: 1
  updatedAt: number
  /** 工具源（插件/MCP 快照面）热更新开关——缺省关（D-V10-2） */
  toolSourcesHot: boolean
}

export function factoryHotReloadSettings(): HotReloadSettings {
  return { version: 1, updatedAt: Date.now(), toolSourcesHot: false }
}

export interface HotReloadSettingsStore {
  get(): HotReloadSettings
  set(patch: Partial<Pick<HotReloadSettings, 'toolSourcesHot'>>): HotReloadSettings
}

export function createHotReloadStore(userDataDir: string): HotReloadSettingsStore {
  const file = path.join(userDataDir, 'hot-reload.json')
  let state = load()
  function load(): HotReloadSettings {
    if (!existsSync(file)) return factoryHotReloadSettings()
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<HotReloadSettings>
      return sanitize(raw)
    } catch {
      // 损坏回退出厂值并写回（不 fail-open）
      const factory = factoryHotReloadSettings()
      persist(factory)
      return factory
    }
  }
  function sanitize(raw: Partial<HotReloadSettings>): HotReloadSettings {
    const factory = factoryHotReloadSettings()
    return {
      version: 1,
      updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : factory.updatedAt,
      toolSourcesHot: raw.toolSourcesHot === true,
    }
  }
  function persist(next: HotReloadSettings): void {
    mkdirSync(userDataDir, { recursive: true })
    const tmp = file + '.tmp'
    writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
    renameSync(tmp, file)
  }
  return {
    get: () => state,
    set(patch) {
      state = sanitize({ ...state, ...patch, updatedAt: Date.now() })
      persist(state)
      return state
    },
  }
}
