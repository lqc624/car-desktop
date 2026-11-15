/**
 * C3-B1 · 浏览器操控设置持久化（缺省关——D-V10-2 裁决，沿 1.20.0 P2 / T-B5 先例；提案 T-B5）
 *
 * 口径：
 *  - 存储 = `<userData>/browser-settings.json`（hot-reload.json 分置先例——独立设置事实）；
 *    原子写 tmp+rename；损坏回退出厂值并写回（不 fail-open）；
 *  - browserEnabled 出厂 = false（**缺省关**：设置页显式开——开启后宿主重启生效
 *    （remote-debugging-port 为启动期开关），Get 面 restartRequired 显式标注）；
 *  - host-core（utilityProcess）与 main 共读本 store（零 electron 依赖模块，双进程同构）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export interface BrowserSettings {
  version: 1
  updatedAt: number
  /** 受控浏览器工具面开关——缺省关（D-V10-2 / 提案 T-B5）；开启 = 重启宿主生效（CDP 端口启动期开关） */
  browserEnabled: boolean
}

export function factoryBrowserSettings(): BrowserSettings {
  return { version: 1, updatedAt: Date.now(), browserEnabled: false }
}

export interface BrowserSettingsStore {
  get(): BrowserSettings
  set(patch: Partial<Pick<BrowserSettings, 'browserEnabled'>>): BrowserSettings
}

export function createBrowserStore(userDataDir: string): BrowserSettingsStore {
  const file = path.join(userDataDir, 'browser-settings.json')
  let state = load()
  function load(): BrowserSettings {
    if (!existsSync(file)) return factoryBrowserSettings()
    try {
      return sanitize(JSON.parse(readFileSync(file, 'utf8')) as Partial<BrowserSettings>)
    } catch {
      const factory = factoryBrowserSettings()
      persist(factory)
      return factory
    }
  }
  function sanitize(raw: Partial<BrowserSettings>): BrowserSettings {
    return {
      version: 1,
      updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
      browserEnabled: raw.browserEnabled === true,
    }
  }
  function persist(next: BrowserSettings): void {
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
