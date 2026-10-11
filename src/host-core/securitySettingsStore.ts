/**
 * S3-S3 · 安全中心设置持久化（安全中心设计 §4/§5；Q-SC-2/3 拍板口径）
 *
 * 口径：
 *  - 存储 = `<userData>/security-settings.json`（与 file-security.json 分置——规则面与设置面两类事实）；
 *    原子写 tmp+rename；损坏回退出厂值并写回（不 fail-open）；
 *  - sessionDefaultPolicy 出厂值 = 'default'（默认安全）——**「会话内放行」不作出厂默认**
 *    （deny-by-default 血统：全局默认自动放行等于取消人审门），仅会话内可切（session:set-policy）；
 *  - autoBackup 出厂 = 开启 + 2000MB（Q-SC-2）；上限区间 [1MB, 1TB]（set 校验 fail-visible）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export type SessionPolicy = 'default' | 'session' | 'readonly'

export interface SecuritySettings {
  version: 1
  updatedAt: number
  /** 新建会话默认策略（Q-SC-3）；会话内可经 session:set-policy 切换（落链） */
  sessionDefaultPolicy: 'default' | 'readonly'
  autoBackup: {
    enabled: boolean
    maxTotalBytes: number
  }
}

export const AUTO_BACKUP_DEFAULT_MAX_BYTES = 2000 * 1024 * 1024
const MAX_BYTES_MIN = 1024 * 1024
const MAX_BYTES_MAX = 1024 * 1024 * 1024 * 1024

export function factorySecuritySettings(): SecuritySettings {
  return {
    version: 1,
    updatedAt: Date.now(),
    sessionDefaultPolicy: 'default',
    autoBackup: { enabled: true, maxTotalBytes: AUTO_BACKUP_DEFAULT_MAX_BYTES },
  }
}

export interface SecuritySettingsStore {
  get(): SecuritySettings
  /** 部分更新（patch 合并；校验 fail-visible；返回规范态） */
  set(patch: unknown): SecuritySettings
  reset(): SecuritySettings
}

export function createSecuritySettingsStore(userDataDir: string): SecuritySettingsStore {
  const file = path.join(userDataDir, 'security-settings.json')
  const persist = (s: SecuritySettings): SecuritySettings => {
    mkdirSync(userDataDir, { recursive: true })
    const tmp = file + '.tmp'
    writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8')
    renameSync(tmp, file)
    return s
  }
  const load = (): SecuritySettings => {
    if (!existsSync(file)) return persist(factorySecuritySettings())
    try {
      return validate(JSON.parse(readFileSync(file, 'utf8')))
    } catch (err) {
      console.error('[host] security-settings.json 损坏，回退出厂值：', err instanceof Error ? err.message : err)
      return persist(factorySecuritySettings())
    }
  }
  const validate = (input: unknown): SecuritySettings => {
    const p = (input ?? {}) as Record<string, unknown>
    if (p['version'] !== 1) throw new Error('CAR-E-DESKTOP: securitySettings version 必须为 1')
    const policy = p['sessionDefaultPolicy']
    if (policy !== 'default' && policy !== 'readonly') {
      throw new Error('CAR-E-DESKTOP: sessionDefaultPolicy 仅 default/readonly（「会话内放行」不作出厂默认）')
    }
    const ab = (p['autoBackup'] ?? {}) as Record<string, unknown>
    const enabled = ab['enabled']
    const max = ab['maxTotalBytes']
    if (typeof enabled !== 'boolean') throw new Error('CAR-E-DESKTOP: autoBackup.enabled 必须为 boolean')
    if (typeof max !== 'number' || !Number.isFinite(max) || max < MAX_BYTES_MIN || max > MAX_BYTES_MAX) {
      throw new Error(`CAR-E-DESKTOP: autoBackup.maxTotalBytes 超出区间 [${MAX_BYTES_MIN}, ${MAX_BYTES_MAX}]`)
    }
    return {
      version: 1,
      updatedAt: typeof p['updatedAt'] === 'number' ? p['updatedAt'] : Date.now(),
      sessionDefaultPolicy: policy,
      autoBackup: { enabled, maxTotalBytes: max },
    }
  }
  let current = load()
  return {
    get: () => current,
    set(patch) {
      const p = (patch ?? {}) as Record<string, unknown>
      const merged: SecuritySettings = {
        ...current,
        ...(p['sessionDefaultPolicy'] !== undefined ? { sessionDefaultPolicy: p['sessionDefaultPolicy'] as SecuritySettings['sessionDefaultPolicy'] } : {}),
        ...(p['autoBackup'] !== undefined
          ? {
              autoBackup: {
                enabled: (p['autoBackup'] as Record<string, unknown>)['enabled'] !== undefined
                  ? ((p['autoBackup'] as Record<string, unknown>)['enabled'] as boolean)
                  : current.autoBackup.enabled,
                maxTotalBytes: (p['autoBackup'] as Record<string, unknown>)['maxTotalBytes'] !== undefined
                  ? ((p['autoBackup'] as Record<string, unknown>)['maxTotalBytes'] as number)
                  : current.autoBackup.maxTotalBytes,
              },
            }
          : {}),
        updatedAt: Date.now(),
      }
      current = persist(validate(merged))
      return current
    },
    reset() {
      current = persist(factorySecuritySettings())
      return current
    },
  }
}
