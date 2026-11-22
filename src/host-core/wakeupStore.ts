/**
 * C7（AD-2 · Q-AD2/AD-3）· 后台任务完成接回设置持久化
 *
 * 口径：
 *  - **自动唤醒缺省关**（deny-by-default 血统——花 token 的自动行为显式开关，《借鉴七篇裁决
 *    记录》Q-AD3 用户批：徽标提醒出厂默认 + 自动唤醒显式开关）；提醒档 = 任务行「结果待取回」
 *    徽标（task-rows 渲染态），零链事件零 token；
 *  - 存储 = `<userData>/bash-wakeup.json`（browser-settings.json 分置先例——独立设置事实）；
 *    原子写 tmp+rename；损坏回退出厂值并写回（不 fail-open）；
 *  - host-core（utilityProcess）独写（main 仅 passthrough IPC——Get/Set 面白名单 +2 条）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export interface BashWakeupSettings {
  version: 1
  updatedAt: number
  /** 自动唤醒（任务自然退出后自动 append 引导 user 事件——下一 turn 交付模型消费）；缺省 false */
  autoWakeup: boolean
}

export function factoryBashWakeupSettings(): BashWakeupSettings {
  return { version: 1, updatedAt: Date.now(), autoWakeup: false }
}

export interface BashWakeupStore {
  get(): BashWakeupSettings
  set(patch: Partial<Pick<BashWakeupSettings, 'autoWakeup'>>): BashWakeupSettings
}

export function createBashWakeupStore(userDataDir: string): BashWakeupStore {
  const file = path.join(userDataDir, 'bash-wakeup.json')
  let state = load()
  function sanitize(v: Partial<BashWakeupSettings>): BashWakeupSettings {
    const f = factoryBashWakeupSettings()
    return { version: 1, updatedAt: typeof v.updatedAt === 'number' ? v.updatedAt : f.updatedAt, autoWakeup: v.autoWakeup === true }
  }
  function persist(s: BashWakeupSettings): void {
    mkdirSync(userDataDir, { recursive: true })
    const tmp = file + '.tmp'
    writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8')
    renameSync(tmp, file)
  }
  function load(): BashWakeupSettings {
    if (!existsSync(file)) return factoryBashWakeupSettings()
    try {
      const s = sanitize(JSON.parse(readFileSync(file, 'utf8')) as Partial<BashWakeupSettings>)
      return s
    } catch {
      const factory = factoryBashWakeupSettings()
      persist(factory)
      return factory
    }
  }
  return {
    get: () => state,
    set: (patch) => {
      state = sanitize({ ...state, ...patch, updatedAt: Date.now() })
      persist(state)
      return state
    },
  }
}
