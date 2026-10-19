import { useCallback, useEffect, useState } from 'react'
import type { AuditExportResult, AuditReport, SessionInfo, WorkspaceInfo } from '../../shared/ipc-contract'

/**
 * S3-S4 审计流水页（渲染薄皮）：数据源 = audit:report（内核载入面——链校验单一权威），
 * 断链定位 brokenAt 可视化 + 授权审计行高亮 + 取证包导出（断链即锁定）。
 * 错误呈现纪律：fail-visible 红条全文展示。
 */

const ts = (n: number): string => new Date(n).toLocaleTimeString('sv-SE')
const preview = (v: unknown): string => JSON.stringify(v ?? null).slice(0, 96)

export function AuditView({ selected, sessions }: { selected: WorkspaceInfo | null; sessions: SessionInfo[] }) {
  const [sid, setSid] = useState<string | null>(null)
  const [report, setReport] = useState<AuditReport | null>(null)
  const [exported, setExported] = useState<AuditExportResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    setSid(null)
    setReport(null)
    setExported(null)
    setError(null)
  }, [selected?.id])

  const load = useCallback(async () => {
    if (!selected || !sid) return
    setError(null)
    setStatus(null)
    setLoading(true)
    try {
      setReport(await window.car.auditReport(selected.id, sid))
      setExported(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [selected, sid])

  const doExport = useCallback(async () => {
    if (!selected || !sid) return
    setError(null)
    setStatus(null)
    try {
      const r = await window.car.auditExport(selected.id, sid)
      setExported(r)
      setStatus(`取证包已导出并读回重验 PASS · ${r.files.length} 文件`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [selected, sid])

  const intact = report?.chain.intact ?? false

  return (
    <section className="card viewcard">
      <h2>审计流水</h2>
      <p className="dim">会话 JSONL 哈希链校验（内核载入面单点权威）· 断链定位到 brokenAt · 取证包导出（断链即锁定）</p>

      {!selected && <p className="dim">先在侧栏选择工作区。</p>}
      {selected && (
        <>
          <div className="row">
            <select value={sid ?? ''} onChange={(e) => setSid(e.target.value || null)}>
              <option value="">选择会话…</option>
              {sessions.map((s) => (
                <option key={s.sessionId} value={s.sessionId}>
                  {s.title}（{s.sessionId}）
                </option>
              ))}
            </select>
            <button className="btn" disabled={!sid || loading} onClick={() => void load()}>
              {loading ? '载入中…' : '载入审计报告'}
            </button>
            <button className="btn primary" disabled={!report || !intact} onClick={() => void doExport()} title={intact ? '断链即中止' : '链校验未通过——导出锁定'}>
              ⬇ 导出取证包
            </button>
          </div>
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          {status && <div className="status">{status}</div>}

          {report && (
            <>
              <div className={`banner ${intact ? 'ok' : 'err'}`}>
                {intact ? (
                  <>✓ 哈希链校验通过 · {report.eventCount} 事件{report.tornTail ? ' · ⚠ 检出撕裂尾（崩溃半行已丢弃）' : ''}</>
                ) : (
                  <>✕ 哈希链断裂 @seq {report.chain.brokenAt} —— 导出与续写已锁定（先修审计面）</>
                )}
              </div>
              <table className="mtable">
                <thead>
                  <tr>
                    <th>seq</th>
                    <th>时间</th>
                    <th>kind</th>
                    <th>turn</th>
                    <th>载荷预览</th>
                  </tr>
                </thead>
                <tbody>
                  {report.events.map((e) => {
                    const isAuthz = e.turnId.startsWith('authz:')
                    // S6（D-S6-4）：记忆操作行高亮（memory/write·edit·delete·rollback——落链可查联动）
                    const isMemory = e.kind === 'memory'
                    const memType = isMemory ? String((e.payload as Record<string, unknown> | null)?.['type'] ?? '?') : null
                    const memId = isMemory ? String((e.payload as Record<string, unknown> | null)?.['id'] ?? '?') : null
                    return (
                      <tr key={e.seq} className={isAuthz ? 'hl-authz' : isMemory ? 'hl-memory' : ''}>
                        <td>{e.seq}</td>
                        <td className="mono">{ts(e.ts)}</td>
                        <td>{isMemory ? `memory·${memType}` : e.kind}</td>
                        <td className="mono">{isAuthz ? 'authz:*' : e.turnId}</td>
                        <td className="mono dim2">{isMemory ? `${memId} · ${preview(e.payload)}` : preview(e.payload)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </>
          )}

          {exported && (
            <div className="card inner">
              <b>取证包 · 读回重验 {exported.verify.ok ? 'PASS' : `FAIL（${exported.verify.brokenFile ?? '?'}）`}</b>
              <div className="dim">目录：<code>{exported.dir}</code></div>
              <div className="dim">
                文件：{exported.files.join(' · ')} · 事件数 {exported.eventCount} · 链校验 {exported.chainIntact ? 'PASS' : 'FAIL'}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  )
}
