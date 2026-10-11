/**
 * S3-S2 · 文件安全规则引擎（桌面端文件安全设计 §5/§6 定稿；纯函数面，零 Electron）
 *
 * 口径：
 *  - 授权对象 = 「路径 × 动作」；动作三轴 read/write/delete ↔ 工具 fs_read/fs_write/fs_delete；
 *  - 判定顺序 = **规则面 > 会话 grant 面 > 人审门**（session-handle authorize 编排；本引擎只做
 *    规则面判定与 fallback 分类）；
 *  - 匹配语义 = 首条命中停止；**先 resolve/realpath 后匹配**——`..` 穿越 / 符号链接 / 大小写 /
 *    正反斜杠 / 8.3 短名均按真实路径判定，拒绝规则不可被路径花招绕过（§6.3 验收面）；
 *  - 变量白名单 = %USERPROFILE% / %WORKSPACE% / %APPDATA%——白名单外变量 = 规则不生效（inert）
 *    + warnings 显性告警（fail-visible 纪律，禁静默失效）；
 *  - 未命中 fallback = 现有安全策略：工作区内 → 人审门（fallback-inside）；工作区外 → 硬拒
 *    （fallback-outside）——默认预设下「未命中」即 S2 行为，向后兼容；
 *  - 预设排序纪律（R-FS-7）：**具体 → 宽泛**——.car/userData 拒绝×3 在 %WORKSPACE%\ 之前，
 *    否则被子树前缀遮蔽（首条命中语义下的遮蔽教训，测试实证）。
 */
import { realpathSync } from 'node:fs'
import path from 'node:path'

export type FileAction = 'read' | 'write' | 'delete'
export type FileTier = 'allow' | 'ask' | 'deny'

export interface FileRule {
  id: string
  /** 规则路径：白名单变量或物化绝对路径；带尾分隔符 = 目录规则（含子树），不带 = 精确文件规则 */
  path: string
  read: FileTier
  write: FileTier
  delete: FileTier
  preset?: boolean
}

export interface FileSecuritySettings {
  version: 1
  updatedAt: number
  rules: FileRule[]
}

export const FILE_TIERS: readonly FileTier[] = ['allow', 'ask', 'deny']
export const FILE_VAR_WHITELIST = ['USERPROFILE', 'WORKSPACE', 'APPDATA'] as const
export const FILE_RULE_MAX = 100

export type DecisionTier = 'allow' | 'ask' | 'deny' | 'fallback-inside' | 'fallback-outside'

export interface RuleDecision {
  tier: DecisionTier
  /** 命中的规则；fallback 两分支为 null */
  rule: FileRule | null
  /** 规范化后的目标路径（匹配与审计 resource 用同一形态） */
  target: string
  /** 规则面告警（未知变量等——设置页展示口径，不阻断匹配其余规则） */
  warnings: string[]
}

// ── 出厂预设（重置为默认的目标态；Q-FS-1/2/3 拍板：全询问收紧 + CAR 特有进首批） ──

export function factoryFileSecuritySettings(userDataDir: string): FileSecuritySettings {
  const ask3 = { read: 'ask', write: 'ask', delete: 'ask' } as const
  const deny3 = { read: 'deny', write: 'deny', delete: 'deny' } as const
  const rules: FileRule[] = [
    // 具体在前（R-FS-7）：审计链与 userData 不可被 agent 触碰——审计红线 + 安全闭环（备份区在 userData 内）
    { id: 'preset-car-data', path: userDataDir, ...deny3, preset: true },
    { id: 'preset-workspace-car', path: '%WORKSPACE%\\.car\\', ...deny3, preset: true },
    { id: 'preset-ssh', path: '%USERPROFILE%\\.ssh\\', ...ask3, preset: true },
    { id: 'preset-aws', path: '%USERPROFILE%\\.aws\\', ...ask3, preset: true },
    { id: 'preset-gcp', path: '%USERPROFILE%\\.gcp\\', ...ask3, preset: true },
    { id: 'preset-gnupg', path: '%USERPROFILE%\\.gnupg\\', ...ask3, preset: true },
    { id: 'preset-gpg', path: '%USERPROFILE%\\.gpg\\', ...ask3, preset: true },
    // 最宽泛收尾：工作区内读无妨、写删要问
    { id: 'preset-workspace', path: '%WORKSPACE%\\', read: 'allow', write: 'ask', delete: 'ask', preset: true },
  ]
  return { version: 1, updatedAt: Date.now(), rules }
}

/** 设置面校验（fileSecurity:set 入口；违规 fail-visible，非法项拒绝而非静默修正） */
export function validateFileSecuritySettings(input: unknown): FileSecuritySettings {
  const p = (input ?? {}) as Record<string, unknown>
  if (p['version'] !== 1) throw new Error('CAR-E-DESKTOP: fileSecurity.set version 必须为 1')
  const rawRules = p['rules']
  if (!Array.isArray(rawRules)) throw new Error('CAR-E-DESKTOP: fileSecurity.set 缺少 rules（数组）')
  if (rawRules.length > FILE_RULE_MAX) throw new Error(`CAR-E-DESKTOP: 规则数超上限（${FILE_RULE_MAX}）`)
  const rules: FileRule[] = rawRules.map((r, i) => {
    const o = (r ?? {}) as Record<string, unknown>
    const id = typeof o['id'] === 'string' && o['id'].trim() ? o['id'].trim() : `r-${i + 1}`
    if (typeof o['path'] !== 'string' || o['path'].trim().length === 0) {
      throw new Error(`CAR-E-DESKTOP: 规则 #${i + 1} 缺少 path（非空 string）`)
    }
    if (o['path'].length > 512) throw new Error(`CAR-E-DESKTOP: 规则 #${i + 1} path 超长（>512）`)
    const tier = (k: string): FileTier => {
      const v = o[k]
      if (typeof v !== 'string' || !FILE_TIERS.includes(v as FileTier)) {
        throw new Error(`CAR-E-DESKTOP: 规则 #${i + 1}（${id}）${k} 档位非法（${String(v)}）——仅 allow/ask/deny`)
      }
      return v as FileTier
    }
    const rule: FileRule = { id, path: o['path'], read: tier('read'), write: tier('write'), delete: tier('delete') }
    if (o['preset'] === true) rule.preset = true
    return rule
  })
  return { version: 1, updatedAt: typeof p['updatedAt'] === 'number' ? p['updatedAt'] : Date.now(), rules }
}

// ── 规范化管线（§6.1：变量展开 → resolve → realpath 最近存在祖先 → 大小写折叠/分隔符统一 → 段解析） ──

export interface FileSecurityEnv {
  /** %USERPROFILE% 展开值；null = 该变量规则全部 inert */
  userProfile: string | null
  /** %WORKSPACE% 展开值（每会话工作区根，decide 时注入） */
  workspace: string
  /** %APPDATA% 展开值；null = inert */
  appData: string | null
}

function expandVars(rulePath: string, env: FileSecurityEnv): { expanded: string; unknown: string[] } {
  const unknown: string[] = []
  const expanded = rulePath.replace(/%([^%]+)%/g, (m, name: string) => {
    const key = String(name).toUpperCase()
    if (key === 'USERPROFILE') return env.userProfile ?? `\u0000${m}`
    if (key === 'WORKSPACE') return env.workspace
    if (key === 'APPDATA') return env.appData ?? `\u0000${m}`
    unknown.push(m)
    return `\u0000${m}`
  })
  return { expanded, unknown }
}

/**
 * 真实路径解析：目标自身存在 → realpath；否则最近存在祖先 realpath + 余段词法拼接
 * （写入场景目标不存在；symlink/8.3 由 GetFinalPathNameByHandle 语义展开）。
 */
function realpathNearest(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    const parent = path.dirname(p)
    if (parent === p) return p // 到达根仍不存在——词法原样
    const real = realpathNearest(parent)
    const rest = p.slice(parent.length)
    return real.endsWith(path.sep) ? real + rest.slice(1) : real + rest
  }
}

/** 目标路径规范化：resolve（相对锚工作区根，含 ./.. 段解析）→ realpath 最近祖先 → 小写折叠（win32）→ '/' 统一 */
function canonicalTarget(raw: string, workspaceRoot: string): string {
  const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(workspaceRoot, raw)
  let real: string
  try {
    real = realpathNearest(abs)
  } catch {
    real = abs
  }
  let out = real.replace(/\\/g, '/')
  if (process.platform === 'win32') out = out.toLowerCase()
  return out.replace(/\/+$/, '') || '/'
}

/** 规则路径规范化：变量展开 → resolve → realpath（存在才展开，目录不存在时词法即可）→ 与目标同构 */
function canonicalRulePath(rulePath: string, env: FileSecurityEnv): { canonical: string; isDir: boolean; unknown: string[] } {
  const { expanded, unknown } = expandVars(rulePath, env)
  if (unknown.length) return { canonical: '\u0000inert', isDir: false, unknown }
  const unified = expanded.replace(/\//g, '\\')
  const isDir = /\\$/.test(unified) // 尾分隔符语义在分隔符统一之后判定（§6.1 第 4→5 步）
  let canonical: string
  try {
    canonical = realpathNearest(path.resolve(expanded))
  } catch {
    canonical = path.resolve(expanded)
  }
  canonical = canonical.replace(/\\/g, '/')
  if (process.platform === 'win32') canonical = canonical.toLowerCase()
  return { canonical: canonical.replace(/\/+$/, '') || '/', isDir, unknown }
}

function firstMatch(rules: readonly FileRule[], target: string, env: FileSecurityEnv): { rule: FileRule | null; warnings: string[] } {
  const warnings: string[] = []
  for (const rule of rules) {
    const { canonical, isDir, unknown } = canonicalRulePath(rule.path, env)
    if (unknown.length) {
      warnings.push(`规则 ${rule.id} 含白名单外变量 ${unknown.join(' ')}——不生效（白名单：${FILE_VAR_WHITELIST.join('/')}）`)
      continue
    }
    const hit = isDir ? target === canonical || target.startsWith(canonical + '/') : target === canonical
    if (hit) return { rule, warnings }
  }
  return { rule: null, warnings }
}

// ── 引擎（store 闭包；规则缓存键 = settings 序列化——set/reset 后自动失效） ──

export interface FileSecurityStoreLike {
  get(): FileSecuritySettings
}

export interface FileSecurityEngine {
  /** 规则面判定（authorize 编排入口；纯计算幂等——authorize 与 run 兜底可各自重算） */
  decide(action: FileAction, rawPath: unknown, workspaceRoot: string): RuleDecision
  /** 执行面硬校验兜底（R-FS-3）：deny 规则命中 / 未命中-工作区外两种硬拒 → 错误消息；否则 null */
  hardReject(action: FileAction, rawPath: unknown, workspaceRoot: string): string | null
  settings(): FileSecuritySettings
}

export function createFileSecurityEngine(store: FileSecurityStoreLike): FileSecurityEngine {
  let cacheKey = ''
  let cachedRules: readonly FileRule[] = []
  const rulesNow = (): readonly FileRule[] => {
    const s = store.get()
    const key = JSON.stringify(s.rules)
    if (key !== cacheKey) {
      cacheKey = key
      cachedRules = s.rules
    }
    return cachedRules
  }
  const decide = (action: FileAction, rawPath: unknown, workspaceRoot: string): RuleDecision => {
    const warnings: string[] = []
    if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
      return { tier: 'deny', rule: null, target: '', warnings: [`缺少 path（string）——${action} 调用参数不合法`] }
    }
    const workspace = canonicalTarget(workspaceRoot, workspaceRoot)
    const target = canonicalTarget(rawPath, workspaceRoot)
    const env: FileSecurityEnv = {
      userProfile: process.env['USERPROFILE'] ?? null,
      workspace,
      appData: process.env['APPDATA'] ?? null,
    }
    const hit = firstMatch(rulesNow(), target, env)
    warnings.push(...hit.warnings)
    if (hit.rule) {
      return { tier: hit.rule[action], rule: hit.rule, target, warnings }
    }
    const inside = target === workspace || target.startsWith(workspace + '/')
    return { tier: inside ? 'fallback-inside' : 'fallback-outside', rule: null, target, warnings }
  }
  return {
    decide,
    hardReject(action, rawPath, workspaceRoot) {
      const d = decide(action, rawPath, workspaceRoot)
      if (d.tier === 'deny' && d.rule) {
        return `CAR-E-DESKTOP: fs_${action} 被文件规则拒绝（${d.rule.id}: ${d.rule.path}）——执行面硬校验兜底`
      }
      if (d.tier === 'fallback-outside') {
        return `CAR-E-DESKTOP: fs_${action} 目标越界（${String(rawPath)}）——未命中规则且位于工作区外`
      }
      return null
    },
    settings: () => store.get(),
  }
}
