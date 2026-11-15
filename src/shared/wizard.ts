/**
 * 配置向导协议引擎（C4 / 《Super-agent借鉴与渠道协同架构设计提案》模块 C 固化——SETUP 六条协议桌面形态）
 *
 * 六条协议与引擎落点：
 *  1. 一次一问：WizardStepSpec 单步呈现（WizardFrame 组件保证——一次只渲染一个未答步骤）；
 *  2. 单条 ≤300 字：WIZARD_TEXT_MAX + assertWizardText（prompt / 计划行 / 结论行全适用，fail-visible）；
 *  3. 密钥永不进对话：input:'secret' 步骤的答案在转录中脱敏（值不打印红线 N-D1 同源）——
 *     凭据输入复用既有 safeStorage 通道（credentialsSave），向导层不新增任何密钥传输面；
 *  4. 先收集全部答案 → 一次给出完整计划 → 用户确认后才执行（禁边问边执行）：
 *     引擎不提供「边收集边执行」的 API 形态——执行器只在 plan 确认后被调用；
 *  5. 探针先行：向导第一步只读探测（既有端点表 / 能力库条目 / 导入预览），探测已回答的问题
 *     不再问（步骤构建方按探针结果预填 recommended 或裁剪步骤）；
 *  6. 全程留痕：createWizardTrace 转录（probe/question/answer/plan/confirm/action/result/abort
 *     全序）——secret 步骤答案脱敏；执行动作走既有 IPC 落链通道（capability/import 叙事落链；
 *     端点面无会话链 = 转录即留痕，差异登记 v0.10 任务列表 D-V10-W1）。
 *
 * 纯决策层：零 electron / 零 React 依赖（skill-import.ts 同款分层纪律，node:test 可测）。
 */

/** 协议红线 2：单条文本 ≤300 字（Super-agent SETUP 口径） */
export const WIZARD_TEXT_MAX = 300

export type WizardInputKind = 'text' | 'secret' | 'choice'

export interface WizardChoiceOption {
  value: string
  label: string
}

/** 向导步骤规格（一次一问——每问一实例） */
export interface WizardStepSpec {
  id: string
  /** 问题文本（≤300 字） */
  prompt: string
  /** 一句「为什么重要」 */
  why?: string
  /** 推荐答案（一键接受——协议第 1 条「推荐答案可一词接受」） */
  recommended?: string
  input: WizardInputKind
  /** input='choice' 时的固定选项（「选择即问」固定选项形态） */
  choices?: WizardChoiceOption[]
  /** 空值可跳过（可选项） */
  optional?: boolean
  placeholder?: string
  /** 值校验：返回错误串 = 拒绝提交（fail-visible）；null = 通过 */
  validate?: (value: string) => string | null
}

export type WizardTraceKind = 'probe' | 'question' | 'answer' | 'plan' | 'confirm' | 'action' | 'result' | 'abort'

export interface WizardTraceEntry {
  seq: number
  /** ISO 时间（转录时间轴） */
  at: string
  kind: WizardTraceKind
  text: string
}

export interface WizardTraceLog {
  entries: readonly WizardTraceEntry[]
  push(kind: WizardTraceKind, text: string): void
}

/** 协议红线 6：全程留痕——全序转录（append-only，禁改写已录条目） */
export function createWizardTrace(): WizardTraceLog {
  const entries: WizardTraceEntry[] = []
  return {
    entries,
    push(kind: WizardTraceKind, text: string) {
      entries.push({ seq: entries.length + 1, at: new Date().toISOString(), kind, text: assertWizardText(`转录条目(${kind})`, text) })
    },
  }
}

/** 协议红线 3：secret 步骤答案脱敏——值不打印红线（N-D1 同源），转录只记「已填写」形态 */
export function wizardAnswerTraceText(step: WizardStepSpec, value: string): string {
  if (step.input === 'secret') return value.trim() ? '〔已填写——值不记录（值不打印红线）〕' : '（留空）'
  return value.trim() ? value.trim() : '（留空）'
}

/** 协议红线 2：单条 ≤300 字守卫（fail-visible，禁静默截断） */
export function assertWizardText(what: string, text: string): string {
  if (text.length > WIZARD_TEXT_MAX) {
    throw new Error(`CAR-E-WIZARD-TEXT: ${what}超限（${text.length} > ${WIZARD_TEXT_MAX} 字符）——协议红线单条 ≤300 字`)
  }
  return text
}

/** 步骤值提交校验：optional 空值放行；validate 返回错误串 = 拒绝 */
export function wizardValidateStep(step: WizardStepSpec, value: string): string | null {
  const v = value.trim()
  if (!v && step.optional) return null
  if (!v && step.input !== 'choice') return step.placeholder ? `必填：${step.prompt}` : '必填'
  if (step.input === 'choice' && !v) return '请选择一项'
  if (step.choices && v && !step.choices.some((c) => c.value === v)) return '选项非法'
  return step.validate ? step.validate(value) : null
}
