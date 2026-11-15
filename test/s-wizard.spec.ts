/**
 * s-wizard · C4 配置向导协议引擎（《Super-agent借鉴》模块 C / T8 SETUP 六条桌面固化）
 *
 * 判据（shared/wizard.ts——纯决策层）：
 *  - 协议红线 2：单条 ≤300 字守卫 fail-visible（禁静默截断）；
 *  - 协议红线 3：secret 步骤答案转录脱敏（值不打印红线 N-D1 同源）；
 *  - 协议红线 6：全程留痕 append-only（seq 单调 + ISO 时间轴 + 禁改写）；
 *  - 步骤校验：optional 空值放行 / 必填空值拒 / choice 非法选项拒 / 自定义 validate 接线。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertWizardText, createWizardTrace, WIZARD_TEXT_MAX, wizardAnswerTraceText, wizardValidateStep, type WizardStepSpec } from '../src/shared/wizard.ts'

const textStep: WizardStepSpec = { id: 't', prompt: '问题？', input: 'text' }
const optStep: WizardStepSpec = { id: 'o', prompt: '可选？', input: 'text', optional: true }
const secretStep: WizardStepSpec = { id: 'k', prompt: '密钥', input: 'secret' }
const choiceStep: WizardStepSpec = {
  id: 'c',
  prompt: '选一项',
  input: 'choice',
  choices: [
    { value: 'a', label: 'A' },
    { value: 'b', label: 'B' },
  ],
}

test('s-wizard: 协议红线 2——单条 ≤300 字守卫 fail-visible（300 过 / 301 拒，禁静默截断）', () => {
  const ok = 'x'.repeat(WIZARD_TEXT_MAX)
  assert.equal(assertWizardText('测试', ok), ok, '恰好 300 字放行')
  assert.throws(() => assertWizardText('测试', 'x'.repeat(WIZARD_TEXT_MAX + 1)), /CAR-E-WIZARD-TEXT.*301 > 300/)
})

test('s-wizard: 协议红线 3——secret 步骤答案转录脱敏（值不打印红线）', () => {
  assert.equal(wizardAnswerTraceText(secretStep, 'sk-live-abc123'), '〔已填写——值不记录（值不打印红线）〕', 'secret 填写态零值泄漏')
  assert.equal(wizardAnswerTraceText(secretStep, ''), '（留空）')
  assert.equal(wizardAnswerTraceText(textStep, '明文可录'), '明文可录', '非 secret 步骤原样转录')
  assert.equal(wizardAnswerTraceText(textStep, '   '), '（留空）')
})

test('s-wizard: 协议红线 6——全程留痕 append-only（seq 单调 / ISO 时间轴 / 全 kind 落录）', () => {
  const t = createWizardTrace()
  t.push('probe', '探针：既有端点 0 个')
  t.push('question', 'Q1')
  t.push('answer', 'A1')
  t.push('plan', '计划 1 行')
  t.push('confirm', '用户确认')
  t.push('action', 'credentialsSave〔脱敏〕')
  t.push('result', '已保存')
  assert.equal(t.entries.length, 7)
  assert.deepEqual(t.entries.map((e) => e.seq), [1, 2, 3, 4, 5, 6, 7], 'seq 单调递增')
  for (const e of t.entries) assert.match(e.at, /^\d{4}-\d{2}-\d{2}T/, 'ISO 时间轴')
  assert.equal(t.entries[0]!.kind, 'probe')
  assert.equal(t.entries[6]!.kind, 'result')
  // 超限转录条目 = fail-visible（禁静默截断留痕）
  assert.throws(() => t.push('result', 'x'.repeat(WIZARD_TEXT_MAX + 1)), /CAR-E-WIZARD-TEXT/)
})

test('s-wizard: 步骤校验——optional 空值放行 / 必填空值拒 / choice 非法选项拒 / validate 接线', () => {
  assert.equal(wizardValidateStep(optStep, ''), null, 'optional 空值放行（可选项留空跳过）')
  assert.match(wizardValidateStep(textStep, '') ?? '', /必填/, '必填空值拒')
  assert.match(wizardValidateStep(choiceStep, '') ?? '', /请选择/, 'choice 空值拒')
  assert.match(wizardValidateStep(choiceStep, 'zzz') ?? '', /选项非法/, 'choice 非法选项拒（固定选项形态）')
  assert.equal(wizardValidateStep(choiceStep, 'a'), null, '合法选项放行')
  const urlStep: WizardStepSpec = { id: 'u', prompt: 'URL', input: 'text', validate: (v) => (/^https?:\/\//.test(v.trim()) ? null : '须为 URL') }
  assert.match(wizardValidateStep(urlStep, 'not-a-url') ?? '', /须为 URL/, '自定义 validate 接线（拒绝）')
  assert.equal(wizardValidateStep(urlStep, 'https://gw.example.com'), null, '自定义 validate 接线（放行）')
  // trim 口径：空白值等同空值（必填拒 / optional 放行）
  assert.match(wizardValidateStep(textStep, '   ') ?? '', /必填/)
  assert.equal(wizardValidateStep(optStep, '   '), null)
})
