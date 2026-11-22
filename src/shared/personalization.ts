/**
 * T-MP 个性化共享面：称呼 + 回复风格档位 + 指令拼装（双侧共用——宿主 store 校验/注入拼装、渲染层风格网格）。
 *
 * 口径：
 *  - **设置存端侧**（userData/personalization.json，不进审计链）；**实时跟随**（WB-2P，用户裁决
 *    2026-11-22：改设置后已开会话下一 turn 生效——sendTurn 每轮对账链上最后注入）；压缩折叠后重注；
 *  - 指令文本 = 人格设定 + 称呼 + 风格 directive + 用户自定义指令确定性拼装（buildPersonaText）
 *    ——以 system kind 事件落链（memory 注入同款纪律：注入必落链），内核投影恒以 role:'system'
 *    进每轮请求；
 *  - 全部为空 = 无指令（零注入，字节面零痕迹）；
 *  - 字段对照 WorkBuddy 个性化面板五项（2026-11-22 本机 ~/.workbuddy 四文件取证）：
 *    称呼 → USER.md Name（助手对用户的称呼）；人格设定 → SOUL.md（助手基调自由文本，≤2000）；
 *    回复风格 → toneStyle 八档；指令 → customPrompt；长期记忆 → userProfileStore（WB-2 分立 store）。
 */

export type ToneStyleId = 'default' | 'professional' | 'friendly' | 'direct' | 'creative' | 'efficient' | 'sharp' | 'socratic'

export interface ToneStyle {
  id: ToneStyleId
  label: string
  desc: string
  /** 注入指令（default = ''——不注入） */
  directive: string
}

export const TONE_STYLES: ReadonlyArray<ToneStyle> = [
  { id: 'default', label: '默认', desc: '跟随模型的自然风格', directive: '' },
  { id: 'professional', label: '专业', desc: '严谨结构化，术语准确', directive: '回复风格：专业——严谨、结构化、术语准确；先结论后论据，避免口语化与寒暄。' },
  { id: 'friendly', label: '友好', desc: '轻松自然，多用比喻', directive: '回复风格：友好——语气轻松自然，善用贴近生活的比喻，保持鼓励感但不冗长。' },
  { id: 'direct', label: '直白', desc: '有话直说，不加铺垫', directive: '回复风格：直白——有话直说，不加铺垫与客套；结论前置，需要否定时明确说否。' },
  { id: 'creative', label: '创意', desc: '发散联想，多方案备选', directive: '回复风格：创意——鼓励发散联想，主动给出多个备选方案与非常规思路，标注各自取舍。' },
  { id: 'efficient', label: '高效', desc: '最短路径，能省则省', directive: '回复风格：高效——最短路径交付，能一句话说清不展开；列表优于段落，无价值细节一律省略。' },
  { id: 'sharp', label: '毒舌', desc: '犀利吐槽，一针见血', directive: '回复风格：毒舌——犀利吐槽、一针见血地指出问题（对事不对人），吐槽完仍给出可靠结论。' },
  { id: 'socratic', label: '苏格拉底', desc: '反问引导，启发思考', directive: '回复风格：苏格拉底——以反问引导用户自己得出结论，关键决策点先问再答（任务执行类请求除外，照常执行）。' },
]

export const PERSONA_PROMPT_MAX_CHARS = 2000
/** 称呼（助手对用户的称呼——对 WorkBuddy USER.md Name 形态） */
export const ADDRESS_NAME_MAX_CHARS = 50
/** 人格设定（助手基调自由文本——对 WorkBuddy SOUL.md 形态） */
export const PERSONA_TEXT_MAX_CHARS = 2000

export interface PersonalizationState {
  toneStyle: ToneStyleId
  customPrompt: string
  /** 称呼（'' = 不注入） */
  addressName: string
  /** 人格设定（'' = 不注入） */
  personaText: string
}

export function isToneStyleId(v: unknown): v is ToneStyleId {
  return typeof v === 'string' && TONE_STYLES.some((t) => t.id === v)
}

/**
 * 确定性拼装：人格设定 → 称呼 → 风格 directive → 自定义指令段。
 * 全部为空 = ''（零注入——字节面零痕迹，与既有 default+空 语义兼容）。
 */
export function buildPersonaText(state: PersonalizationState): string {
  const style = TONE_STYLES.find((t) => t.id === state.toneStyle) ?? TONE_STYLES[0]!
  const persona = state.personaText.trim()
  const name = state.addressName.trim()
  const custom = state.customPrompt.trim()
  const parts: string[] = []
  if (persona) parts.push(`人格设定（助手基调，长期有效）：\n${persona}`)
  if (name) parts.push(`对用户的称呼：请称呼用户为「${name}」。`)
  if (style.directive) parts.push(style.directive)
  if (custom) parts.push(`用户附加指令（优先级高于风格设定）：\n${custom}`)
  return parts.join('\n\n')
}
