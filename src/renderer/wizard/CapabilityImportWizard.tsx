import { useRef, useState } from 'react'
import type { CapabilityImportPreviewRow } from '../../shared/ipc-contract'
import { createWizardTrace, type WizardTraceLog } from '../../shared/wizard'
import { WizardPlanReview, WizardTraceView } from './wizard-ui'

/**
 * C4 能力库导入向导（Super-agent T8 SETUP 协议桌面固化——SKILL.md 导入的引导层）
 *
 * 协议落点：
 *  - 探针先行：选文件后只读预览（capabilityImportPreview——解析 + id 冲突预测，零写盘零落链）；
 *  - 先收集后计划再执行：预览行 = 计划（含冲突「将新增为」预测），确认后才走 capabilityImport
 *    （写盘 + capability/write 叙事落链——持久审计仍由链承载，转录为引导层留痕）；
 *  - 全程留痕：转录 append-only（本流程无问答步骤——探针/计划/确认/执行/结果全序在案）；
 *  - 密钥面：不涉及（能力条目 = prompt 注入物，无凭据）。
 *
 * 本流程无问答步骤（协议第 1 条在此为空集——文件选择即收集完毕），计划复审是核心协议面。
 */

export function CapabilityImportWizard({
  workspaceId, sessionId, onCancel, onDone, onChanged,
}: {
  workspaceId: string
  sessionId: string
  onCancel: () => void
  onDone: (msg: string) => void
  onChanged: () => void
}) {
  const [phase, setPhase] = useState<'collect' | 'plan' | 'executing'>('collect')
  const [paths, setPaths] = useState<string[] | null>(null)
  const [preview, setPreview] = useState<CapabilityImportPreviewRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const traceRef = useRef<WizardTraceLog | null>(null)
  if (!traceRef.current) traceRef.current = createWizardTrace()
  const trace = traceRef.current

  const pick = async () => {
    setError(null)
    trace.push('probe', '探针先行：选择 SKILL.md 文件 → 只读预览（解析 + 冲突预测，零写盘）')
    try {
      const picked = await window.car.capabilityImportPick()
      if (!picked) {
        trace.push('abort', '用户取消文件选择（无副作用）')
        return
      }
      const r = await window.car.capabilityImportPreview(workspaceId, sessionId, picked)
      setPaths(picked)
      setPreview(r.results)
      const okRows = r.results.filter((x) => x.ok)
      const conflicts = r.results.filter((x) => x.ok && x.conflict)
      trace.push('probe', `预览：${okRows.length}/${r.results.length} 文件可导入（冲突预测 ${conflicts.length} 个——盘上已有同 id 条目）`)
      setPhase('plan')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      trace.push('result', `预览失败（fail-visible）：${msg}`)
      setError(msg)
    }
  }

  const execute = async () => {
    if (!paths) return
    setPhase('executing')
    setError(null)
    trace.push('confirm', '用户确认导入计划——开始执行（capabilityImport：逐文件解析→写盘→capability/write 叙事落链）')
    try {
      const r = await window.car.capabilityImport(workspaceId, sessionId, paths)
      const okN = r.results.filter((x) => x.ok).length
      const failN = r.results.length - okN
      trace.push('result', `导入完成：${okN} 成功 / ${failN} 失败（逐文件结果见列表——fail-visible）`)
      onChanged()
      onDone(`导入完成：${okN} 成功 / ${failN} 失败（capability/write 叙事已落链）`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      trace.push('result', `执行失败（fail-visible）：${msg}`)
      setError(msg)
      setPhase('plan')
    }
  }

  const planRows = (preview ?? []).map((r) =>
    r.ok
      ? `${r.name} → ${r.conflict ? `将新增为 ${r.predictedId}（${r.id} 已存在）` : `新增 ${r.id}`} · ${r.chars} 字符 ← ${r.file}`
      : `跳过：${r.error} ← ${r.file}`,
  )
  const hasImportable = (preview ?? []).some((r) => r.ok)

  return (
    <div>
      <div className="cap-title-row" style={{ margin: '6px 0' }}>
        <b>SKILL.md 导入向导</b>
        <span className="dim">（探针先行 · 先收集后计划再执行 · 全程留痕——执行走既有落链通道）</span>
      </div>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {phase === 'collect' && (
        <div style={{ margin: '10px 0' }}>
          <div className="dim">第一步只做只读探测：选文件 → 预览（解析 frontmatter + id 冲突预测），不写盘不落链；计划确认后才执行导入。</div>
          <div className="row wrap" style={{ margin: '8px 0' }}>
            <button className="btn primary" onClick={() => void pick()}>
              ① 选择 SKILL.md 文件
            </button>
            <button className="btn" onClick={() => { trace.push('abort', '用户中止向导（预览只读，零副作用）'); onCancel() }}>
              取消
            </button>
          </div>
        </div>
      )}
      {phase !== 'collect' && (
        <WizardPlanReview
          title={`导入计划（${preview?.length ?? 0} 文件）`}
          rows={planRows}
          executing={phase === 'executing'}
          onConfirm={() => void execute()}
          onCancel={() => { trace.push('abort', '用户中止向导（预览只读，零副作用）'); onCancel() }}
          error={null}
          status={phase === 'executing' ? '执行中…' : null}
        />
      )}
      {phase === 'plan' && !hasImportable && <div className="dim">无可导入文件——全部解析失败，取消后检查文件形态（frontmatter + 正文）</div>}
      <WizardTraceView entries={trace.entries} />
    </div>
  )
}
