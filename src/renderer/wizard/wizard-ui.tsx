import type { WizardStepSpec, WizardTraceEntry } from '../../shared/wizard'
import { WIZARD_TEXT_MAX } from '../../shared/wizard'

/**
 * C4 向导共享 UI 件（协议六条的呈现面——引擎在 shared/wizard.ts，本文件只做渲染）
 *
 * 留痕 kind 中文标签（转录呈现——协议第 6 条全程留痕的可视形态）
 */
const TRACE_KIND_LABEL: Record<WizardTraceEntry['kind'], string> = {
  probe: '探针',
  question: '提问',
  answer: '回答',
  plan: '计划',
  confirm: '确认',
  action: '执行',
  result: '结果',
  abort: '中止',
}

const KIND_ORDER: Array<WizardTraceEntry['kind']> = ['probe', 'question', 'answer', 'plan', 'confirm', 'action', 'result', 'abort']

/** 全程留痕转录（append-only 列表 + 时间轴；secret 条目已由引擎脱敏） */
export function WizardTraceView({ entries, title = '向导留痕' }: { entries: readonly WizardTraceEntry[]; title?: string }) {
  if (!entries.length) return null
  const ordered = [...entries].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.seq - b.seq)
  return (
    <div style={{ margin: '8px 0' }}>
      <div className="dim" style={{ marginBottom: 4 }}>{title}（{entries.length} 条 · 全序 append-only · secret 值已脱敏）</div>
      {ordered.map((e) => (
        <div key={e.seq} className="dim" style={{ margin: '2px 0', fontSize: 12 }}>
          <code className="mono">#{e.seq}</code> [{TRACE_KIND_LABEL[e.kind]}] {e.text}
        </div>
      ))}
    </div>
  )
}

/**
 * 一次一问卡（协议第 1 条：单步单问 + 推荐答案一键接受 + 一句为什么）
 * 错误 = 校验拒绝（fail-visible），不推进步骤。
 */
export function WizardQuestion({
  step, value, onChange, onSubmit, error, index, total,
}: {
  step: WizardStepSpec
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
  error: string | null
  index: number
  total: number
}) {
  return (
    <div style={{ margin: '10px 0' }}>
      <div className="dim">第 {index + 1} / {total} 问 · 一次一问</div>
      <div style={{ margin: '4px 0' }}>
        <b>{step.prompt}</b>
        <span className="dim">（≤{WIZARD_TEXT_MAX} 字）</span>
      </div>
      {step.why && <div className="dim">为什么问：{step.why}</div>}
      {step.input === 'choice' ? (
        <div className="row wrap" style={{ margin: '8px 0' }}>
          {(step.choices ?? []).map((c) => (
            <button key={c.value} className={`btn ${value === c.value ? 'primary' : ''}`} onClick={() => onChange(c.value)}>
              {c.label}
              {step.recommended === c.value && <span className="dim"> · 推荐</span>}
            </button>
          ))}
        </div>
      ) : (
        <div className="row wrap" style={{ margin: '8px 0' }}>
          <input
            className="grow mono"
            type={step.input === 'secret' ? 'password' : 'text'}
            placeholder={step.placeholder ?? ''}
            value={value}
            autoFocus
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') onSubmit() }}
          />
          {step.recommended !== undefined && (
            <button className="btn" onClick={() => onChange(step.recommended!)} title="推荐答案——一键接受（协议第 1 条）">
              用推荐：{step.recommended || '（留空）'}
            </button>
          )}
        </div>
      )}
      {step.optional && <div className="dim">可选项——留空跳过</div>}
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <div className="row wrap">
        <button className="btn primary" onClick={onSubmit}>
          {index + 1 === total ? '完成回答 → 查看计划' : '下一问 →'}
        </button>
      </div>
    </div>
  )
}

/** 先收集后计划：计划复审 + 确认执行（协议第 4 条——禁边问边执行，执行只在确认后发生） */
export function WizardPlanReview({
  title, rows, warnings, executing, onConfirm, onCancel, error, status,
}: {
  title: string
  rows: string[]
  warnings?: string[]
  executing: boolean
  onConfirm: () => void
  onCancel: () => void
  error: string | null
  status: string | null
}) {
  return (
    <div style={{ margin: '10px 0' }}>
      <div style={{ margin: '4px 0' }}>
        <b>{title}</b> <span className="dim">（先收集全部答案 → 完整计划 → 确认后才执行——协议第 4 条）</span>
      </div>
      {warnings?.map((w) => (
        <div key={w} className="banner err" style={{ margin: '6px 0' }}>
          ⚠ {w}
        </div>
      ))}
      {rows.map((r, i) => (
        <div key={i} className="banner ok" style={{ margin: '6px 0' }}>
          {r}
        </div>
      ))}
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {status && <div className="status">{status}</div>}
      <div className="row wrap">
        <button className="btn primary" disabled={executing} onClick={onConfirm}>
          {executing ? '执行中…' : '✓ 确认执行'}
        </button>
        <button className="btn" disabled={executing} onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  )
}
