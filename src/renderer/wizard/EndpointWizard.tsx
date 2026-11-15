import { useCallback, useRef, useState } from 'react'
import type { EndpointListDTO } from '../../shared/ipc-contract'
import { assertWizardText, createWizardTrace, wizardAnswerTraceText, wizardValidateStep, type WizardStepSpec, type WizardTraceLog } from '../../shared/wizard'
import { WizardPlanReview, WizardQuestion, WizardTraceView } from './wizard-ui'

/**
 * C4 端点配置向导（Super-agent T8 SETUP 协议桌面固化——复用 credentials* 既有 IPC 面，
 * 向导 = 表单的引导层，不新增配置面/不新增密钥通道）
 *
 * 协议落点：
 *  - 探针先行：既有端点表只读探测 → 计划期重复检测 + 推荐值（本流程六问无探针可裁剪项——
 *    探针发现的问题以计划警示呈现，登记 v0.10 任务列表）；
 *  - 一次一问 / 单条 ≤300 字 / 密钥永不进对话（secret 步骤 + 转录脱敏——safeStorage 落盘
 *    仍走 credentialsSave，向导层零密钥传输面）；
 *  - 先收集全部答案 → 完整计划 → 确认后才执行（禁边问边执行——引擎形态保证）；
 *  - 全程留痕：端点面无会话链 = 转录即留痕（差异登记 D-V10-W1），执行走既有通道。
 */

/** 步骤构建（≤300 字守卫 fail-visible——超限显式崩，禁静默截断） */
function buildSteps(): WizardStepSpec[] {
  const steps: WizardStepSpec[] = [
    {
      id: 'family',
      prompt: '端点按哪种适配器族接入？',
      why: '适配器族决定 baseUrl 形态与 Key 通道（anthropic = Claude Code 型网关）',
      recommended: 'openai-compat',
      input: 'choice',
      choices: [
        { value: 'openai-compat', label: 'OpenAI 兼容' },
        { value: 'anthropic', label: 'Anthropic 形态' },
      ],
    },
    {
      id: 'baseUrl',
      prompt: 'Base URL 是什么？',
      why: '端点地址——anthropic 形态不带 /v1，openai 兼容形态以 /v1 收尾',
      input: 'text',
      placeholder: 'https://…',
      validate: (v) => (/^https?:\/\/.+/.test(v.trim()) ? null : '须为 http(s):// 开头的 URL'),
    },
    {
      id: 'key',
      prompt: 'API Key（本步输入即入 safeStorage 加密通道，不进任何对话与转录）',
      why: '凭据边界——Key 经 safeStorage 加密落盘，渲染层只见已配置态，永不回显',
      input: 'secret',
      placeholder: 'API Key（必填，新增端点）',
    },
    {
      id: 'anchorModel',
      prompt: '锚点模型 ID 是什么？',
      why: '首行模型 = 新建会话的装配锚点（默认模型）',
      input: 'text',
      placeholder: '如 deepseek-ai/deepseek-v4-flash',
      validate: (v) => (v.trim() ? null : '锚点模型必填'),
    },
    {
      id: 'windowK',
      prompt: '声明上下文窗口 k 吗？（可选）',
      why: '声明后武装压缩阈值 floor(k×0.78)；不声明 = 禁估算不武装（滑窗口径网关建议声明网关口径等效窗口）',
      recommended: '',
      optional: true,
      input: 'text',
      placeholder: '窗口 k，如 128（留空 = 不声明）',
      validate: (v) => (v.trim() && !/^\d+$/.test(v.trim()) ? '窗口 k 只允许数字' : null),
    },
    {
      id: 'extraModel',
      prompt: '同一 URL 下再挂一个模型吗？（可选）',
      why: '一 URL 多模型（K5-F）——更多模型可后经表单专家路径补齐',
      recommended: '',
      optional: true,
      input: 'text',
      placeholder: '第二个模型 ID（留空 = 只挂锚点）',
    },
  ]
  for (const s of steps) {
    assertWizardText(`步骤「${s.id}」prompt`, s.prompt)
    if (s.why) assertWizardText(`步骤「${s.id}」why`, s.why)
  }
  return steps
}

export function EndpointWizard({ onCancel, onDone, onEndpointChanged }: { onCancel: () => void; onDone: (msg: string) => void; onEndpointChanged?: () => void }) {
  const [probe, setProbe] = useState<EndpointListDTO | null>(null)
  const [phase, setPhase] = useState<'ask' | 'plan' | 'executing'>('ask')
  const [stepIdx, setStepIdx] = useState(0)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [stepError, setStepError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const traceRef = useRef<WizardTraceLog | null>(null)
  if (!traceRef.current) traceRef.current = createWizardTrace()
  const trace = traceRef.current

  const steps = useRef<WizardStepSpec[]>(buildSteps())
  const step = steps.current[stepIdx]!

  // 探针先行（只读）——探针失败不阻塞向导（转录 fail-visible 呈现）
  const runProbe = useCallback(async () => {
    try {
      const list = await window.car.credentialsList()
      setProbe(list)
      trace.push('probe', `既有端点 ${list.endpoints.length} 个（使用中：${list.endpoints.find((e) => e.id === list.activeId)?.baseUrl ?? '无——装配回退 car.config llm'}）`)
    } catch (e) {
      trace.push('probe', `探针失败（fail-visible，不阻塞）：${e instanceof Error ? e.message : String(e)}`)
    }
  }, [trace])

  const started = useRef(false)
  if (!started.current) {
    started.current = true
    trace.push('probe', '端点配置向导启动——探针先行（只读，探测已回答的问题不再问）')
    void runProbe()
  }

  const current = answers[step.id] ?? ''
  const submitAnswer = () => {
    const err = wizardValidateStep(step, current)
    if (err) {
      setStepError(err)
      return
    }
    setStepError(null)
    trace.push('question', step.prompt)
    trace.push('answer', wizardAnswerTraceText(step, current))
    setAnswers({ ...answers, [step.id]: current.trim() })
    if (stepIdx + 1 < steps.current.length) setStepIdx(stepIdx + 1)
    else {
      trace.push('plan', '全部答案已收集——生成完整计划（先收集后计划，禁边问边执行）')
      setPhase('plan')
    }
  }

  const baseUrl = answers.baseUrl?.trim() ?? ''
  const duplicate = probe?.endpoints.some((e) => e.baseUrl === baseUrl) ?? false
  const anchor = answers.anchorModel?.trim() ?? ''
  const extra = answers.extraModel?.trim() ?? ''
  const win = answers.windowK?.trim() ?? ''
  const planRows = [
    `适配器族：${answers.family === 'anthropic' ? 'Anthropic 形态（Claude Code 型网关）' : 'OpenAI 兼容'}`,
    `Base URL：${baseUrl}`,
    `API Key：${answers.key?.trim() ? '已填写（safeStorage 加密落盘——值不显示）' : '（未填写）'}`,
    `模型：${anchor}${win ? `（窗口 ${win}k）` : ''}${extra ? ` ＋ ${extra}` : ''}`,
    '动作：保存端点并设为使用中（credentialsSave——safeStorage 加密 + 推宿主装配，新会话生效）',
  ]
  const planWarnings = duplicate ? [`Base URL 与既有端点重复（${baseUrl}）——继续将新增另一端点槽；如需修改既有端点请取消后走「编辑」路径`] : []

  const execute = async () => {
    setPhase('executing')
    setError(null)
    trace.push('confirm', '用户确认计划——开始执行（完整计划确认后才执行）')
    try {
      const models = [anchor, ...(extra ? [extra] : [])].map((id) => ({ id, ...(win ? { contextWindow: Number(win) * 1000 } : {}) }))
      trace.push('action', `credentialsSave（baseUrl=${baseUrl}，adapterId=${answers.family}，models=${models.map((m) => m.id).join('、')}，key=〔脱敏〕）`)
      const ep = await window.car.credentialsSave({ baseUrl, adapterId: answers.family === 'anthropic' ? 'anthropic' : 'openai-compat', models, ...(answers.key?.trim() ? { key: answers.key.trim() } : {}) })
      trace.push('result', `端点已保存（id=${ep.id ?? 'new'}）并设为使用中——safeStorage 加密；新会话生效`)
      onEndpointChanged?.()
      onDone('端点已保存（向导完成——safeStorage 加密落盘并推宿主装配，新会话生效）')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      trace.push('result', `执行失败（fail-visible）：${msg}`)
      setError(msg)
      setPhase('plan') // 回到计划复审——可重试或取消（已确认前不重执行）
    }
  }

  const cancel = () => {
    trace.push('abort', '用户中止向导（先计划后执行语义下中止 = 零副作用）')
    onCancel()
  }

  return (
    <div>
      <div className="cap-title-row" style={{ margin: '6px 0' }}>
        <b>端点配置向导</b>
        <span className="dim">（协议六条：探针先行 / 一次一问 / ≤300 字 / 密钥不进对话 / 先计划后执行 / 全程留痕）</span>
      </div>
      {phase === 'ask' && (
        <WizardQuestion
          step={step}
          value={current}
          index={stepIdx}
          total={steps.current.length}
          onChange={(v) => setAnswers({ ...answers, [step.id]: v })}
          onSubmit={submitAnswer}
          error={stepError}
        />
      )}
      {(phase === 'plan' || phase === 'executing') && (
        <WizardPlanReview
          title="端点配置计划"
          rows={planRows}
          warnings={planWarnings}
          executing={phase === 'executing'}
          onConfirm={() => void execute()}
          onCancel={cancel}
          error={error}
          status={phase === 'executing' ? '执行中…' : null}
        />
      )}
      <WizardTraceView entries={trace.entries} />
    </div>
  )
}
