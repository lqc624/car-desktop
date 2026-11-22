/**
 * T-MP · 个性化设置持久化（端侧偏好面——与安全设置分置：个性化是偏好、不是安全事实）
 *
 * 口径：
 *  - 存储 = `<userData>/personalization.json`；原子写 tmp+rename；损坏回退出厂值并写回（不 fail-open）；
 *  - **不进审计链**（设置本体是端侧偏好；「已应用」这一事实随 persona 注入事件落会话链）；
 *  - 实时跟随（WB-2P）——sendTurn 每轮读本 store 渲染对账，改设置后已开会话下一 turn 生效；
 *  - 校验 fail-visible：toneStyle ∈ TONE_STYLES 枚举 / customPrompt ≤2000 / addressName ≤50 /
 *    personaText ≤2000 字符；addressName/personaText 为后增字段（2026-11-22 WorkBuddy 面板对照批）
 *    ——旧文件缺字段 = 出厂 ''（向后兼容），在场但类型错 = fail-visible。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  ADDRESS_NAME_MAX_CHARS,
  PERSONA_PROMPT_MAX_CHARS,
  PERSONA_TEXT_MAX_CHARS,
  isToneStyleId,
  type PersonalizationState,
  type ToneStyleId,
} from '../shared/personalization.ts'

export interface PersonalizationSettings {
  version: 1
  updatedAt: number
  toneStyle: ToneStyleId
  customPrompt: string
  addressName: string
  personaText: string
}

export function factoryPersonalization(): PersonalizationSettings {
  return { version: 1, updatedAt: Date.now(), toneStyle: 'default', customPrompt: '', addressName: '', personaText: '' }
}

export interface PersonalizationStore {
  get(): PersonalizationSettings
  /** 部分更新（patch 合并；校验 fail-visible；返回规范态） */
  set(patch: unknown): PersonalizationSettings
  /** 规范化的个性化状态（store 超集 → 注入面四元组） */
  state(): PersonalizationState
  reset(): PersonalizationSettings
}

/** 字符串字段规范化：在场必须 string（fail-visible）；缺省 = ''（旧文件向后兼容） */
function strField(p: Record<string, unknown>, key: string, max: number, label: string): string {
  const v = p[key]
  if (v === undefined) return ''
  if (typeof v !== 'string') throw new Error(`CAR-E-DESKTOP: ${label} 必须为 string`)
  if (v.length > max) throw new Error(`CAR-E-DESKTOP: ${label} 超长（${v.length} > ${max} 字符）`)
  return v
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
      addressName: strField(p, 'addressName', ADDRESS_NAME_MAX_CHARS, 'addressName'),
      personaText: strField(p, 'personaText', PERSONA_TEXT_MAX_CHARS, 'personaText'),
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
        ...(p['addressName'] !== undefined ? { addressName: p['addressName'] as string } : {}),
        ...(p['personaText'] !== undefined ? { personaText: p['personaText'] as string } : {}),
        updatedAt: Date.now(),
      }
      current = persist(validate(merged))
      return current
    },
    state: () => ({
      toneStyle: current.toneStyle,
      customPrompt: current.customPrompt,
      addressName: current.addressName,
      personaText: current.personaText,
    }),
    reset() {
      current = persist(factoryPersonalization())
      return current
    },
  }
}
