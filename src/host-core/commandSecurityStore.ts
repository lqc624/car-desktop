/**
 * v0.19 C2 · 命令安全设置持久化（WB-5；fileSecurityStore 同构镜像）
 *
 * 口径：
 *  - 存储 = `<userData>/command-security.json`（应用级全局一份，与 file-security.json 分置——
 *    免 version 迁移，browser-settings 分置先例）；原子写 = tmp + rename；
 *  - 读取校验失败 = **回退出厂预设并写回**（损坏不 fail-open 到宽松态）+ console 留痕；
 *  - set = 校验（validateCommandSecuritySettings，regex 编译失败当场拒绝）→ updatedAt 收敛 →
 *    原子落盘 → 返回规范态；
 *  - 规则变更是设置操作、不入会话链；会话内每次命令判决经 AuthzService #commit 落链（审计口径）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  factoryCommandSecuritySettings,
  validateCommandSecuritySettings,
  type CommandSecuritySettings,
} from './commandSecurity.ts'

export interface CommandSecurityStore {
  get(): CommandSecuritySettings
  /** 全量规则表替换（校验 fail-visible；返回规范态） */
  set(rules: unknown): CommandSecuritySettings
  /** 重置为出厂预设（deny 6 + ask 14，D-V19-7 拍板清单） */
  reset(): CommandSecuritySettings
}

export function createCommandSecurityStore(userDataDir: string): CommandSecurityStore {
  const file = path.join(userDataDir, 'command-security.json')
  const persist = (s: CommandSecuritySettings): CommandSecuritySettings => {
    mkdirSync(userDataDir, { recursive: true })
    const tmp = file + '.tmp'
    writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8')
    renameSync(tmp, file) // 原子写：tmp + rename（同卷 rename 原子语义）
    return s
  }
  const load = (): CommandSecuritySettings => {
    if (!existsSync(file)) return persist(factoryCommandSecuritySettings())
    try {
      return validateCommandSecuritySettings(JSON.parse(readFileSync(file, 'utf8')))
    } catch (err) {
      // 损坏回退：出厂预设 + 留痕（禁 fail-open 到宽松态；回退态写回，后续读取稳定）
      console.error('[host] command-security.json 损坏，回退出厂预设：', err instanceof Error ? err.message : err)
      return persist(factoryCommandSecuritySettings())
    }
  }
  let current = load()
  return {
    get: () => current,
    set(input) {
      const p = (input ?? {}) as Record<string, unknown>
      const payload = Array.isArray(input) ? { version: 1, rules: input } : { version: p['version'] ?? 1, rules: p['rules'] }
      current = persist(validateCommandSecuritySettings({ ...validateCommandSecuritySettings(payload), updatedAt: Date.now() }))
      return current
    },
    reset() {
      current = persist(factoryCommandSecuritySettings())
      return current
    },
  }
}
