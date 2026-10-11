/**
 * S3-S2 · 文件安全设置持久化（桌面端文件安全设计 §5.1）
 *
 * 口径：
 *  - 存储 = `<userData>/file-security.json`（应用级全局一份）；原子写 = tmp + rename；
 *  - 读取校验失败 = **回退出厂预设并写回**（设置面损坏不 fail-open 到宽松态——回退到保守预设）
 *    + console 留痕；version 字段承载后续迁移；
 *  - set = 校验（validateFileSecuritySettings）→ updatedAt 收敛 → 原子落盘 → 返回规范态；
 *  - 规则变更是设置操作、不入会话链；会话内每次规则判决经 AuthzService #commit 落链（审计口径）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  factoryFileSecuritySettings,
  validateFileSecuritySettings,
  type FileSecuritySettings,
} from './fileSecurity.ts'

export interface FileSecurityStore {
  get(): FileSecuritySettings
  /** 全量规则表替换（校验 fail-visible；返回规范态） */
  set(rules: unknown): FileSecuritySettings
  /** 重置为出厂预设（8 条，Q-FS-1/2/3 拍板档位） */
  reset(): FileSecuritySettings
}

export function createFileSecurityStore(userDataDir: string): FileSecurityStore {
  const file = path.join(userDataDir, 'file-security.json')
  const persist = (s: FileSecuritySettings): FileSecuritySettings => {
    mkdirSync(userDataDir, { recursive: true })
    const tmp = file + '.tmp'
    writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8')
    renameSync(tmp, file) // 原子写：tmp + rename（同卷 rename 原子语义）
    return s
  }
  const load = (): FileSecuritySettings => {
    if (!existsSync(file)) return persist(factoryFileSecuritySettings(userDataDir))
    try {
      return validateFileSecuritySettings(JSON.parse(readFileSync(file, 'utf8')))
    } catch (err) {
      // 损坏回退：保守预设 + 留痕（禁 fail-open 到宽松态；回退态写回，后续读取稳定）
      console.error('[host] file-security.json 损坏，回退出厂预设：', err instanceof Error ? err.message : err)
      return persist(factoryFileSecuritySettings(userDataDir))
    }
  }
  let current = load()
  return {
    get: () => current,
    set(rules) {
      current = persist({ ...validateFileSecuritySettings({ version: 1, rules, updatedAt: Date.now() }) })
      return current
    },
    reset() {
      current = persist(factoryFileSecuritySettings(userDataDir))
      return current
    },
  }
}
