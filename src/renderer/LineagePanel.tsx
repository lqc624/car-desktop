/**
 * Z-1 延伸（0.15.0 / D-Z15-1~4）· 谱系抽屉面板（渲染薄皮）
 *
 * 数据源：SessionInfo.forkedFrom（D-Z15-2 透传）构树（buildLineage 纯函数）；分叉点
 * （D-Z15-3）按需读链——audit:report 现成通道逐节点提取 fork-in 标记（单节点失败容错
 * 不阻塞整树）；对比（D-Z15-4）= pickComparePair 同父校验 + alignBranches 确定性对齐
 * （零 LLM 零估算）。执行拓扑域（parentSessionId）不混入——本面板只做 Z-1 分叉谱系。
 */
import { useEffect, useState } from 'react'
import type { SessionInfo } from '../shared/ipc-contract'
import { buildLineage, pickComparePair, forkPointFromEvents, type LineageNode } from './lineage'
import { alignBranches, type BranchDiff, type DiffSegment } from './branch-diff'

interface ForkPointLite {
  upToSeq: number
  fromSessionId: string
}

interface DiffState {
  a: SessionInfo
  b: SessionInfo
  result: BranchDiff
}

function NodeRow(props: {
  node: LineageNode
  depth: number
  currentId: string | null
  forkPoint: ForkPointLite | null
  picked: boolean
  onPick: (sid: string) => void
  onJump: (sid: string) => void
  forkPointOf: (sid: string) => ForkPointLite | null
  pickedOf: (sid: string) => boolean
}): React.JSX.Element {
  const { node, depth, currentId, forkPoint, picked, onPick, onJump } = props
  const s = node.session
  const selectable = Boolean(s.forkedFrom)
  return (
    <>
      <div className={`lg-row${s.sessionId === currentId ? ' cur' : ''}${picked ? ' picked' : ''}`} style={{ paddingLeft: 12 + depth * 18 }}>
        <label className="lg-pick" title={selectable ? '勾选两个同父分支做对比' : '对比仅限分叉出的子会话'}>
          <input
            type="checkbox"
            data-testid={`lg-pick-${s.sessionId}`}
            disabled={!selectable}
            checked={picked}
            onChange={() => onPick(s.sessionId)}
          />
        </label>
        <button
          className="item-main lg-jump"
          data-testid={`lg-jump-${s.sessionId}`}
          onClick={() => onJump(s.sessionId)}
          title={node.orphaned ? '源会话已删/不存在——谱系孤儿节点如实呈现（R-1）' : `打开会话${forkPoint ? `（⎇ 从父第 ${forkPoint.upToSeq} 条消息分出）` : ''}`}
        >
          <span className="lg-title">{s.forkedFrom ? '⎇ ' : ''}{s.title}</span>
          <span className="lg-meta">{s.eventCount} 件{node.orphaned ? ' · 源已删' : ''}</span>
        </button>
        {forkPoint && (
          <div className="lg-forkpoint">⎇ 从父第 {forkPoint.upToSeq} 条消息分出</div>
        )}
      </div>
      {node.children.map((c) => (
        <NodeRow key={c.session.sessionId} node={c} depth={depth + 1} currentId={currentId} forkPoint={props.forkPointOf(c.session.sessionId)} picked={props.pickedOf(c.session.sessionId)} onPick={onPick} onJump={onJump} forkPointOf={props.forkPointOf} pickedOf={props.pickedOf} />
      ))}
    </>
  )
}

function SegmentRow(props: { seg: DiffSegment }): React.JSX.Element {
  const { seg } = props
  const aOnly = seg.kind === 'a-only'
  const bOnly = seg.kind === 'b-only'
  return (
    <div className={`lg-seg ${seg.kind}`} data-testid={`lg-seg-${seg.kind}`}>
      <div className="lg-seg-user">
        {aOnly ? '⟦ 仅分支 A 改问 ⟧ ' : bOnly ? '⟦ 仅分支 B 改问 ⟧ ' : ''}
        {seg.userText}
      </div>
      <div className="lg-seg-cols">
        <div className="lg-col">
          <div className="lg-col-head">分支 A</div>
          {seg.aItems.length === 0 && <div className="lg-empty">（无回答）</div>}
          {seg.aItems.map((it, k) => (
            <div className="lg-item" key={k}>{it.text}</div>
          ))}
        </div>
        <div className="lg-col">
          <div className="lg-col-head">分支 B</div>
          {seg.bItems.length === 0 && <div className="lg-empty">{bOnly ? '（本段不在此分支——锚点错位如实标注，R-4）' : '（无回答）'}</div>}
          {seg.bItems.map((it, k) => (
            <div className="lg-item" key={k}>{it.text}</div>
          ))}
        </div>
      </div>
    </div>
  )
}

export function LineagePanel(props: {
  sessions: SessionInfo[]
  currentId: string | null
  onClose: () => void
  onJump: (sid: string) => void
}): React.JSX.Element {
  const { sessions, currentId, onClose, onJump } = props
  const roots = buildLineage(sessions)
  const [forkPoints, setForkPoints] = useState<Record<string, ForkPointLite | null>>({})
  const [picked, setPicked] = useState<string[]>([])
  const [warn, setWarn] = useState<string | null>(null)
  const [diff, setDiff] = useState<DiffState | null>(null)

  // D-Z15-3：面板打开即按需读链提取各子链 fork-in 分叉点（audit:report 现成通道；单节点失败容错）
  useEffect(() => {
    let alive = true
    const targets = sessions.filter((s) => s.forkedFrom)
    void Promise.all(
      targets.map(async (s) => {
        try {
          const r = await window.car.auditReport(s.workspaceId, s.sessionId)
          return [s.sessionId, forkPointFromEvents(r.events)] as const
        } catch {
          return [s.sessionId, null] as const // R-3：单节点读链失败容错——节点仍可跳转，分叉点行缺省
        }
      }),
    ).then((entries) => {
      if (alive) setForkPoints(Object.fromEntries(entries))
    })
    return () => {
      alive = false
    }
  }, [sessions])

  const forkPointOf = (sid: string): ForkPointLite | null => forkPoints[sid] ?? null
  const pickedOf = (sid: string): boolean => picked.includes(sid)
  const onPick = (sid: string): void => {
    setWarn(null)
    setPicked((prev) => {
      if (prev.includes(sid)) return prev.filter((x) => x !== sid)
      if (prev.length >= 2) return [prev[1], sid]
      return [...prev, sid]
    })
  }

  const runCompare = async (): Promise<void> => {
    const [aid, bid] = picked
    const a = sessions.find((s) => s.sessionId === aid)
    const b = sessions.find((s) => s.sessionId === bid)
    if (!a || !b) return
    const chk = pickComparePair(a, b)
    if (!chk.ok) {
      setWarn(chk.reason)
      return
    }
    try {
      const [ra, rb] = await Promise.all([
        window.car.auditReport(a.workspaceId, a.sessionId),
        window.car.auditReport(b.workspaceId, b.sessionId),
      ])
      const result = alignBranches(
        { events: ra.events, forkUpToSeq: forkPointFromEvents(ra.events)?.upToSeq ?? 0 },
        { events: rb.events, forkUpToSeq: forkPointFromEvents(rb.events)?.upToSeq ?? 0 },
      )
      setDiff({ a, b, result })
    } catch (e) {
      setWarn(e instanceof Error ? e.message : String(e))
    }
  }

  const childCount = sessions.filter((s) => s.forkedFrom === currentId).length

  return (
    <div className="lineage-pop" data-testid="lineage-panel">
      <div className="lg-head">
        <b>⎇ 分叉谱系</b>
        <span className="lg-meta">
          {currentId ? `当前会话 ${childCount > 0 ? `· ${childCount} 个子会话` : '· 无分叉'}` : '未打开会话'}
        </span>
        <button className="mini" data-testid="lineage-close" onClick={onClose}>✕</button>
      </div>
      {diff ? (
        <>
          <div className="lg-diff-head">
            <button
              className="mini"
              onClick={() => setDiff(null)}
              data-testid="lineage-back"
            >
              ← 回谱系
            </button>
            <span className="lg-meta">
              {diff.a.title} ⇄ {diff.b.title} · 公共前缀 {diff.result.commonPrefixCount} 件（{diff.result.commonPrefixUsers.length} 问）
            </span>
          </div>
          <div className="lg-common" title="公共前缀 = 两支共享的父链历史（分叉点之前）——折叠呈现">
            公共前缀 {diff.result.commonPrefixCount} 件 · 同题 {diff.result.commonPrefixUsers.map((t) => `「${t}」`).join('')}
          </div>
          {diff.result.segments.map((seg, k) => (
            <SegmentRow key={k} seg={seg} />
          ))}
          {diff.result.segments.length === 0 && <div className="lg-empty">两分支在分叉点后均无新对话。</div>}
        </>
      ) : (
        <>
          <div className="lg-tip">勾选两个同父分支 → 对比（同题不同答并排；零 LLM 确定性对齐）</div>
          <div className="lg-tree">
            {roots.map((n) => (
              <NodeRow
                key={n.session.sessionId}
                node={n}
                depth={0}
                currentId={currentId}
                forkPoint={forkPointOf(n.session.sessionId)}
                picked={pickedOf(n.session.sessionId)}
                onPick={onPick}
                onJump={onJump}
                forkPointOf={forkPointOf}
                pickedOf={pickedOf}
              />
            ))}
            {roots.length === 0 && <div className="lg-empty">本工作区暂无会话。</div>}
          </div>
          {warn && <div className="lg-warn">{warn}</div>}
          <div className="lg-actions">
            <button
              className="pill"
              data-testid="lineage-compare"
              disabled={picked.length !== 2}
              onClick={() => void runCompare()}
              title="对比两分支：公共前缀折叠 + 分叉后增量序对齐（D-Z15-4）"
            >
              ⇄ 对比{picked.length === 2 ? '' : '（勾选 2 个）'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
