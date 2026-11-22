/**
 * WB-2 用户级画像共享面：跨工作区「我是谁 / 我的约定」条目 + 注入拼装（双侧共用——宿主 store
 * 校验/注入拼装、渲染层编辑面板）。
 *
 * 参考面（WorkBuddy 借鉴线 WB-2——一手实证 ~/.workbuddy/USER.md + MEMORY.md 形态）：
 * 用户级画像（称呼/习惯/项目上下文）+ 跨项目习得约定，全部**跨工作区常驻注入**。
 *
 * 口径：
 *  - **存储存端侧**（userData/user-profile.json，不进审计链）；**实时跟随**（persona 同款——
 *    改设置后已开会话下一 turn 生效）；压缩折叠后重注；关闭后停止新增（旧注入随前缀保留）；
 *  - **显式开关 enabled 出厂 false**（D-46：禁静默选择性注入——用户显式开启后才有注入）；
 *    关闭或零条目 = 零注入零落链（缺席无需取证，同 memory-recall 零命中口径）；
 *  - 注入文本 = buildUserProfileText 确定性拼装——以 system kind 事件落链（注入必落链纪律，
 *    persona 同款），meta injection='user-profile'；挂 persona 常驻指令面家族（非记忆召回
 *    管线——记忆召回管线零触碰，不新增第三套注入面）；
 *  - 预算 set 时 fail-visible（禁静默截断）：单条 ≤ENTRY_MAX / 条数 ≤COUNT_MAX / 总量 ≤TOTAL_MAX。
 */

/** 条目种类：profile = 用户画像（对 WorkBuddy USER.md）／convention = 跨工作区约定（对 MEMORY.md） */
export type UserProfileEntryKind = 'profile' | 'convention'

export interface UserProfileEntry {
  id: string
  kind: UserProfileEntryKind
  text: string
  updatedAt: number
}

export interface UserProfileState {
  enabled: boolean
  entries: UserProfileEntry[]
}

export const USER_PROFILE_ENTRY_MAX_CHARS = 1000
export const USER_PROFILE_ENTRY_MAX_COUNT = 16
export const USER_PROFILE_TOTAL_MAX_CHARS = 4000

export function isUserProfileEntryKind(v: unknown): v is UserProfileEntryKind {
  return v === 'profile' || v === 'convention'
}

/**
 * 确定性拼装：标题行 + 画像/约定两节逐条列点（空节省略）。
 * 未启用或零条目 = ''（零注入——字节面零痕迹）。
 * 总量预算由 store set 时按本函数渲染实长校验（fail-visible）——注入面所见即所校。
 * 标题词汇对齐 WorkBuddy 个性化面板（长期记忆——2026-11-22 用户裁决）。
 */
export function buildUserProfileText(state: UserProfileState): string {
  if (!state.enabled) return ''
  const profiles = state.entries.filter((e) => e.kind === 'profile')
  const conventions = state.entries.filter((e) => e.kind === 'convention')
  if (profiles.length === 0 && conventions.length === 0) return ''
  const section = (title: string, items: UserProfileEntry[]): string[] =>
    items.length === 0 ? [] : [title, ...items.map((e) => `- ${e.text.trim()}`)]
  const lines: string[] = ['用户长期记忆（跨工作区 · 用户显式维护）——在所有工作区生效，请遵循：']
  lines.push(...section('## 用户画像', profiles))
  lines.push(...section('## 跨工作区约定', conventions))
  return lines.join('\n')
}

/**
 * WB-2P 纪律面继承（子代理 spawn 注入——用户裁决 2026-11-22）：指令（customPrompt）+
 * 长期记忆（enabled 条目）确定性拼装。称呼/人格/回复风格**不继承**（子代理不直接面对用户——
 * 人格与风格是主会话对话面；纪律类约束子代理产出，产出会回流父上下文）。
 * 双源皆空 = ''（零注入零落链）。
 */
export function buildDisciplineText(customPrompt: string, up: UserProfileState): string {
  const custom = customPrompt.trim()
  const memory = buildUserProfileText(up)
  const parts: string[] = []
  if (custom) parts.push(`## 指令（用户自定义，须遵循）\n${custom}`)
  if (memory) parts.push(memory)
  if (parts.length === 0) return ''
  return `子任务纪律（继承自用户个性化设置——跨会话有效，须遵循）：\n\n${parts.join('\n\n')}`
}
