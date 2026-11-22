/**
 * WB-2 · 用户级画像持久化（端侧偏好面——userData 级 = 跨工作区；个性化/persona 同族纪律）
 *
 * 口径：
 *  - 存储 = `<userData>/user-profile.json`；原子写 tmp+rename；损坏回退出厂值并写回（不 fail-open）；
 *  - **不进审计链**（设置本体是端侧偏好；「已注入」这一事实随 user-profile system 事件落会话链）；
 *  - **显式开关 enabled 出厂 false**（D-46 三件套之一——禁静默选择性注入）；
 *  - 实时跟随（WB-2P）——sendTurn 每轮读本 store 渲染对账，改设置后已开会话下一 turn 生效；resume 从链恢复（不读本 store）；
 *  - 校验 fail-visible：kind ∈ 两类 / 单条 ≤1000 字符 / 条数 ≤16 / 启用态注入渲染实长 ≤4000。
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  buildUserProfileText,
  isUserProfileEntryKind,
  USER_PROFILE_ENTRY_MAX_CHARS,
  USER_PROFILE_ENTRY_MAX_COUNT,
  USER_PROFILE_TOTAL_MAX_CHARS,
  type UserProfileEntry,
  type UserProfileEntryKind,
  type UserProfileState,
} from '../shared/userProfile.ts'

export interface UserProfileSettings {
  version: 1
  updatedAt: number
  enabled: boolean
  entries: UserProfileEntry[]
}

export function factoryUserProfile(): UserProfileSettings {
  return { version: 1, updatedAt: Date.now(), enabled: false, entries: [] }
}

export interface UserProfileStore {
  get(): UserProfileSettings
  /** 部分更新（patch 合并；entries 全量替换并规范化补 id/updatedAt；校验 fail-visible） */
  set(patch: unknown): UserProfileSettings
  /** 规范化的画像状态（store 超集 → 注入面二元组） */
  state(): UserProfileState
  reset(): UserProfileSettings
}

/** 条目规范化：补 id/updatedAt；kind/text 校验 fail-visible（禁静默丢弃） */
function normalizeEntry(raw: unknown, index: number): UserProfileEntry {
  const p = (raw ?? {}) as Record<string, unknown>
  if (!isUserProfileEntryKind(p['kind'])) {
    throw new Error(`CAR-E-DESKTOP: entries[${index}].kind 不在画像条目两类（profile/convention）内`)
  }
  const text = p['text']
  if (typeof text !== 'string') throw new Error(`CAR-E-DESKTOP: entries[${index}].text 必须为 string`)
  if (text.length > USER_PROFILE_ENTRY_MAX_CHARS) {
    throw new Error(`CAR-E-DESKTOP: entries[${index}] 超长（${text.length} > ${USER_PROFILE_ENTRY_MAX_CHARS} 字符）`)
  }
  return {
    id: typeof p['id'] === 'string' && p['id'] ? p['id'] : randomUUID(),
    kind: p['kind'] as UserProfileEntryKind,
    text,
    updatedAt: typeof p['updatedAt'] === 'number' ? p['updatedAt'] : Date.now(),
  }
}

/** 全量校验（load 与 set 共用——fail-visible，禁静默截断） */
function validate(input: unknown): UserProfileSettings {
  const p = (input ?? {}) as Record<string, unknown>
  if (p['version'] !== 1) throw new Error('CAR-E-DESKTOP: user-profile version 必须为 1')
  if (typeof p['enabled'] !== 'boolean') throw new Error('CAR-E-DESKTOP: enabled 必须为 boolean')
  if (!Array.isArray(p['entries'])) throw new Error('CAR-E-DESKTOP: entries 必须为数组')
  if (p['entries'].length > USER_PROFILE_ENTRY_MAX_COUNT) {
    throw new Error(`CAR-E-DESKTOP: 条目数超限（${p['entries'].length} > ${USER_PROFILE_ENTRY_MAX_COUNT}）`)
  }
  const entries = p['entries'].map((e, i) => normalizeEntry(e, i))
  const settings: UserProfileSettings = {
    version: 1,
    updatedAt: typeof p['updatedAt'] === 'number' ? p['updatedAt'] : Date.now(),
    enabled: p['enabled'],
    entries,
  }
  const rendered = buildUserProfileText({ enabled: settings.enabled, entries })
  if (rendered.length > USER_PROFILE_TOTAL_MAX_CHARS) {
    throw new Error(`CAR-E-DESKTOP: 注入总量超预算（${rendered.length} > ${USER_PROFILE_TOTAL_MAX_CHARS} 字符）`)
  }
  return settings
}

export function createUserProfileStore(userDataDir: string): UserProfileStore {
  const file = path.join(userDataDir, 'user-profile.json')
  const persist = (s: UserProfileSettings): UserProfileSettings => {
    mkdirSync(userDataDir, { recursive: true })
    const tmp = file + '.tmp'
    writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8')
    renameSync(tmp, file)
    return s
  }
  const load = (): UserProfileSettings => {
    if (!existsSync(file)) return persist(factoryUserProfile())
    try {
      return validate(JSON.parse(readFileSync(file, 'utf8')))
    } catch (err) {
      console.error('[host] user-profile.json 损坏，回退出厂值：', err instanceof Error ? err.message : err)
      return persist(factoryUserProfile())
    }
  }
  let current = load()
  return {
    get: () => current,
    set(patch) {
      const p = (patch ?? {}) as Record<string, unknown>
      const merged: Record<string, unknown> = {
        ...current,
        ...(p['enabled'] !== undefined ? { enabled: p['enabled'] } : {}),
        ...(p['entries'] !== undefined ? { entries: p['entries'] } : {}),
        updatedAt: Date.now(),
      }
      current = persist(validate(merged))
      return current
    },
    state: () => ({ enabled: current.enabled, entries: current.entries }),
    reset() {
      current = persist(factoryUserProfile())
      return current
    },
  }
}
