/**
 * T-MP · 个性化设置持久化（端侧偏好面——与安全设置分置：个性化是偏好、不是安全事实）
 *
 * 口径：
 *  - 存储 = `<userData>/personalization.json`；原子写 tmp+rename；损坏回退出厂值并写回（不 fail-open）；
 *  - **不进审计链**（设置本体是端侧偏好；「已应用」这一事实随 persona 注入事件落会话链）；
 *  - 应用于新会话（创建时快照）——set 不影响已开会话；
 *  - 校验 fail-visible：toneStyle ∈ TONE_STYLES 枚举 / customPrompt ≤2000 字符。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { isToneStyleId, PERSONA_PROMPT_MAX_CHARS, type PersonalizationState, type ToneStyleId } from '../shared/personalization.ts'

export interface PersonalizationSettings {
  version: 1
  updatedAt: number
  toneStyle: ToneStyleId
  customPrompt: string
}

export function factoryPersonalization(): PersonalizationSettings {
  return { version: 1, updatedAt: Date.now(), toneStyle: 'default', customPrompt: '' }
}

export interface PersonalizationStore {
  get(): PersonalizationSettings
  /** 部分更新（patch 合并；校验 fail-visible；返回规范态） */
  set(patch: unknown): PersonalizationSettings
  /** 规范化的个性化状态（store 超集 → 注入面二元组） */
  state(): PersonalizationState
  reset(): PersonalizationSettings
}

export function createPersonalizationStore(userDataDir: string): PersonalizationStore {
  const file = path.join(userDataDir, 'personalization.json')
  const persist = (s: PersonalizationSettings): PersonalizationSettings => {
    mkdirSync(userDataDir, { recursive: true })
    const tmp = file + '.tmp'
    writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8')
    renameSync(tmp, file)
    return s
  }
  const validate = (input: unknown): PersonalizationSettings => {
    const p = (input ?? {}) as Record<string, unknown>
    if (p['version'] !== 1) throw new Error('CAR-E-DESKTOP: personalization version 必须为 1')
    if (!isToneStyleId(p['toneStyle'])) throw new Error('CAR-E-DESKTOP: toneStyle 不在档位表（TONE_STYLES）内')
    const custom = p['customPrompt']
    if (typeof custom !== 'string') throw new Error('CAR-E-DESKTOP: customPrompt 必须为 string')
    if (custom.length > PERSONA_PROMPT_MAX_CHARS) {
      throw new Error(`CAR-E-DESKTOP: customPrompt 超长（${custom.length} > ${PERSONA_PROMPT_MAX_CHARS} 字符）`)
    }
    return {
      version: 1,
      updatedAt: typeof p['updatedAt'] === 'number' ? p['updatedAt'] : Date.now(),
      toneStyle: p['toneStyle'] as ToneStyleId,
      customPrompt: custom,
    }
  }
  const load = (): PersonalizationSettings => {
    if (!existsSync(file)) return persist(factoryPersonalization())
    try {
      return validate(JSON.parse(readFileSync(file, 'utf8')))
    } catch (err) {
      console.error('[host] personalization.json 损坏，回退出厂值：', err instanceof Error ? err.message : err)
      return persist(factoryPersonalization())
    }
  }
  let current = load()
  return {
    get: () => current,
    set(patch) {
      const p = (patch ?? {}) as Record<string, unknown>
      const merged: PersonalizationSettings = {
        ...current,
        ...(p['toneStyle'] !== undefined ? { toneStyle: p['toneStyle'] as ToneStyleId } : {}),
        ...(p['customPrompt'] !== undefined ? { customPrompt: p['customPrompt'] as string } : {}),
        updatedAt: Date.now(),
      }
      current = persist(validate(merged))
      return current
    },
    state: () => ({ toneStyle: current.toneStyle, customPrompt: current.customPrompt }),
    reset() {
      current = persist(factoryPersonalization())
      return current
    },
  }
}
