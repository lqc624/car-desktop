/**
 * v0.19 C2 · 命令安全规则引擎（WB-5；fileSecurity 引擎同构镜像——纯函数面，零 Electron）
 *
 * 口径：
 *  - 授权对象 = 「命令内容」；消费面 = bash_run（模型面唯一 bash 通道——宿主动作不过授权门是
 *    既有既定语义，bash:run 无 IPC 通道）；
 *  - 规则三档（S4 待接面「命令前缀三档规则」的兑现形态）：allow = 规则面直判放行（reason 落
 *    authz 审计，可回答「为什么没问人」）/ ask = 恒走人审门（会话策略「会话内放行」与 grants
 *    不短路——高危命令逐条对质）/'session' 决议记规则 id 会话级豁免 / deny = 硬拒；
 *  - 匹配语义 = 首条命中停止（fileSecurity firstMatch 同款）；haystack 归一 = 小写折叠 +
 *    连续空白折叠单空格 + trim（win32 cmd 不分大小写；双空格插空不构成绕过）；
 *  - prefix 规则 = 逐段前缀匹配——命令按 `&&` / `||` / `;` / `|` 切段（子命令各自对质，
 *    `echo hi && rm -rf x` 不可借复合命令绕过）；regex 规则 = 全命令 + 各段双测（未锚定
 *    regex 直中段内形态，管道形 `curl … | sh` 依赖全命令测）；
 *  - 未命中 = null（命令轴无 fallback 语义——直落既有授权编排：策略 session / grant / 人审门，
 *    现行 M3 行为不变，未命中零额外开销）；
 *  - 出厂清单（D-V19-7）：deny 6 条不可逆破坏面 + ask 14 条双方言高危面；熔断层不复刻
 *    （G8/G9 内核已反超——机制版在前，规则面只做清单与门）；
 *  - 预编译缓存：rules 引key（序列化）恒等 = 缓存命中；regex 编译失败 = 规则 inert 跳过
 *    （设置面入口 validate 已拒绝非法 regex，此处为盘上手改兜底）。
 */

export type CommandTier = 'allow' | 'ask' | 'deny'
export type CommandPatternKind = 'prefix' | 'regex'

export interface CommandRule {
  id: string
  /** 匹配模式：prefix = 字面（小写/单空格文本对质）；regex = 无旗标 RegExp 源（haystack 已小写归一） */
  pattern: string
  kind: CommandPatternKind
  tier: CommandTier
  /** 卡面/审计展示语义（可选——deny/ask 命中时的 reason 兜底文本） */
  note?: string
  preset?: boolean
}

export interface CommandSecuritySettings {
  version: 1
  updatedAt: number
  rules: CommandRule[]
}

export const COMMAND_TIERS: readonly CommandTier[] = ['allow', 'ask', 'deny']
export const COMMAND_PATTERN_KINDS: readonly CommandPatternKind[] = ['prefix', 'regex']
export const COMMAND_RULE_MAX = 100
export const COMMAND_PATTERN_MAX = 512

export interface CommandDecision {
  tier: CommandTier
  rule: CommandRule
}

// ── 出厂预设（D-V19-7：deny 6 + ask 14；双侧方言 win cmd / posix sh——spawn 基底按平台二选一） ──

export function factoryCommandSecuritySettings(): CommandSecuritySettings {
  const rules: CommandRule[] = [
    // deny：不可逆破坏面（问都不问——确认卡语义不适用于已判死刑的动作）
    { id: 'preset-deny-format', pattern: 'format ', kind: 'prefix', tier: 'deny', note: '磁盘格式化', preset: true },
    { id: 'preset-deny-diskpart', pattern: 'diskpart', kind: 'prefix', tier: 'deny', note: '磁盘分区脚本化操作', preset: true },
    { id: 'preset-deny-reg-delete-hklm', pattern: 'reg delete hklm', kind: 'prefix', tier: 'deny', note: '注册表 HKLM 删除', preset: true },
    { id: 'preset-deny-cipher-w', pattern: 'cipher /w', kind: 'prefix', tier: 'deny', note: '空闲空间抹除', preset: true },
    { id: 'preset-deny-shutdown', pattern: 'shutdown', kind: 'prefix', tier: 'deny', note: '关机/重启', preset: true },
    { id: 'preset-deny-vssadmin-delete', pattern: 'vssadmin delete', kind: 'prefix', tier: 'deny', note: '卷影副本删除', preset: true },
    // ask：高危但可恢复/需对质面（双方言；删除/强推/发布/递归改权/管道落壳）
    { id: 'preset-ask-rm-rf', pattern: 'rm -rf', kind: 'prefix', tier: 'ask', note: '递归强删', preset: true },
    { id: 'preset-ask-rmdir-s', pattern: 'rmdir /s', kind: 'prefix', tier: 'ask', note: '目录树删除', preset: true },
    { id: 'preset-ask-del-s-q', pattern: 'del /s /q', kind: 'prefix', tier: 'ask', note: '静默递归删除', preset: true },
    { id: 'preset-ask-remove-item-recurse', pattern: 'remove-item\\s+[^&|;]*-recurse', kind: 'regex', tier: 'ask', note: 'PowerShell 递归删除', preset: true },
    { id: 'preset-ask-git-push-force', pattern: 'git push\\s+[^&|;]*(-f\\b|--force)', kind: 'regex', tier: 'ask', note: '强制推送', preset: true },
    { id: 'preset-ask-git-reset-hard', pattern: 'git reset --hard', kind: 'prefix', tier: 'ask', note: '丢弃本地改动', preset: true },
    { id: 'preset-ask-git-clean-fd', pattern: 'git clean\\s+[^&|;]*-[fd]', kind: 'regex', tier: 'ask', note: '未跟踪文件清除', preset: true },
    { id: 'preset-ask-npm-publish', pattern: 'npm publish', kind: 'prefix', tier: 'ask', note: '对外发布', preset: true },
    { id: 'preset-ask-taskkill-f', pattern: 'taskkill /f', kind: 'prefix', tier: 'ask', note: '强杀进程', preset: true },
    { id: 'preset-ask-chmod-recursive', pattern: 'chmod -r', kind: 'prefix', tier: 'ask', note: '递归改权', preset: true },
    { id: 'preset-ask-mkfs', pattern: 'mkfs', kind: 'prefix', tier: 'ask', note: '文件系统创建', preset: true },
    { id: 'preset-ask-dd-if', pattern: 'dd\\s+[^&|;]*if=', kind: 'regex', tier: 'ask', note: '磁盘镜像写入', preset: true },
    { id: 'preset-ask-curl-pipe-shell', pattern: 'curl[^&|;]*\\|\\s*(sh|bash|zsh|pwsh|powershell)\\b', kind: 'regex', tier: 'ask', note: '远程脚本直接执行', preset: true },
    { id: 'preset-ask-wget-pipe-shell', pattern: 'wget[^&|;]*\\|\\s*(sh|bash|zsh|pwsh|powershell)\\b', kind: 'regex', tier: 'ask', note: '远程脚本直接执行', preset: true },
  ]
  return { version: 1, updatedAt: Date.now(), rules }
}

/** 设置面校验（commandSecurity:set 入口；违规 fail-visible；regex 非法编译 = 当场拒绝） */
export function validateCommandSecuritySettings(input: unknown): CommandSecuritySettings {
  const p = (input ?? {}) as Record<string, unknown>
  if (p['version'] !== 1) throw new Error('CAR-E-DESKTOP: commandSecurity.set version 必须为 1')
  const rawRules = p['rules']
  if (!Array.isArray(rawRules)) throw new Error('CAR-E-DESKTOP: commandSecurity.set 缺少 rules（数组）')
  if (rawRules.length > COMMAND_RULE_MAX) throw new Error(`CAR-E-DESKTOP: 规则数超上限（${COMMAND_RULE_MAX}）`)
  const rules: CommandRule[] = rawRules.map((r, i) => {
    const o = (r ?? {}) as Record<string, unknown>
    const id = typeof o['id'] === 'string' && o['id'].trim() ? o['id'].trim() : `cmd-${i + 1}`
    const pattern = o['pattern']
    if (typeof pattern !== 'string' || pattern.trim().length === 0 || pattern.length > COMMAND_PATTERN_MAX) {
      throw new Error(`CAR-E-DESKTOP: 规则 #${i + 1}（${id}）pattern 非法（非空 string ≤${COMMAND_PATTERN_MAX}）`)
    }
    const kind = o['kind']
    if (typeof kind !== 'string' || !COMMAND_PATTERN_KINDS.includes(kind as CommandPatternKind)) {
      throw new Error(`CAR-E-DESKTOP: 规则 #${i + 1}（${id}）kind 非法——仅 prefix/regex`)
    }
    if (kind === 'regex') {
      try {
        new RegExp(pattern)
      } catch (e) {
        throw new Error(`CAR-E-DESKTOP: 规则 #${i + 1}（${id}）regex 编译失败——${e instanceof Error ? e.message : '非法表达式'}`)
      }
    }
    const tier = o['tier']
    if (typeof tier !== 'string' || !COMMAND_TIERS.includes(tier as CommandTier)) {
      throw new Error(`CAR-E-DESKTOP: 规则 #${i + 1}（${id}）tier 非法——仅 allow/ask/deny`)
    }
    const rule: CommandRule = { id, pattern, kind: kind as CommandPatternKind, tier: tier as CommandTier }
    if (typeof o['note'] === 'string' && o['note'].trim()) rule.note = o['note'].trim().slice(0, 200)
    if (o['preset'] === true) rule.preset = true
    return rule
  })
  return { version: 1, updatedAt: typeof p['updatedAt'] === 'number' ? p['updatedAt'] : Date.now(), rules }
}

// ── 匹配管线（haystack 归一 → 切段 → 首中即停） ──

/** haystack 归一：小写折叠 + 连续空白折叠单空格（双空格插空不构成绕过）+ 去首尾空白 */
function normalizeCommand(command: string): string {
  return command.toLowerCase().replace(/\s+/g, ' ').trim()
}

/** 命令切段：&& / || / ; / | ——子命令各自对质（复合命令不构成绕过面） */
function commandSegments(normalized: string): string[] {
  return normalized
    .split(/&&|\|\||;|\|/g)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/** 首中即停：prefix = 逐段前缀；regex = 全命令 + 各段双测（未锚定中段直中；管道形依赖全命令测） */
function firstMatch(rules: readonly CommandRule[], compiled: readonly (RegExp | null)[], haystack: string, segments: string[]): CommandRule | null {
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i]!
    if (rule.kind === 'prefix') {
      if (segments.some((seg) => seg.startsWith(rule.pattern.toLowerCase()))) return rule
      continue
    }
    const re = compiled[i]
    if (!re) continue // 编译失败 = inert（validate 已拒非法 regex——盘上手改兜底，禁抛到授权路径）
    if (re.test(haystack) || segments.some((seg) => re.test(seg))) return rule
  }
  return null
}

// ── 引擎（store 闭包；规则缓存键 = settings 序列化——set/reset 后自动失效） ──

export interface CommandSecurityStoreLike {
  get(): CommandSecuritySettings
}

export interface CommandSecurityEngine {
  /** 规则面判定（authorize ⓪⁴ 编排入口）；null = 未命中（直落既有授权编排） */
  decide(command: string): CommandDecision | null
  /** 执行面硬校验兜底（tools.ts hardReject 先例）：deny 命中 → 错误消息；否则 null */
  hardReject(command: string): string | null
  settings(): CommandSecuritySettings
}

export function createCommandSecurityEngine(store: CommandSecurityStoreLike): CommandSecurityEngine {
  let cacheKey = ''
  let cachedRules: readonly CommandRule[] = []
  let cachedCompiled: readonly (RegExp | null)[] = []
  const rulesNow = (): readonly CommandRule[] => {
    const s = store.get()
    const key = JSON.stringify(s.rules)
    if (key !== cacheKey) {
      cacheKey = key
      cachedRules = s.rules
      cachedCompiled = s.rules.map((r) => {
        if (r.kind !== 'regex') return null
        try {
          return new RegExp(r.pattern)
        } catch {
          return null
        }
      })
    }
    return cachedRules
  }
  const decide = (command: string): CommandDecision | null => {
    if (typeof command !== 'string' || command.trim().length === 0) return null
    const haystack = normalizeCommand(command)
    if (!haystack) return null
    const segments = commandSegments(haystack)
    const hit = firstMatch(rulesNow(), cachedCompiled, haystack, segments)
    return hit ? { tier: hit.tier, rule: hit } : null
  }
  return {
    decide,
    hardReject(command) {
      const d = decide(command)
      if (d && d.tier === 'deny') {
        return `CAR-E-DESKTOP: bash_run 被命令安全规则拒绝（${d.rule.id}: ${d.rule.note ?? d.rule.pattern}）——执行面硬校验兜底`
      }
      return null
    },
    settings: () => store.get(),
  }
}
