import { useCallback, useEffect, useState } from 'react'
import type { MeteringSummary, WorkspaceInfo } from '../../shared/ipc-contract'

/**
 * S3-S5 仪表盘计量区（计量设计 §4.6 口径渲染）：数据源 = metrics:summary（usage 事实
 * 本体在会话 JSONL——禁估算）；价目未同步 = 金额位「价目未同步」（禁 0 禁伪造，VD4 红线）；
 * 覆盖率/缺失 turn 显性化；turn 明细关联能力列（工具集合，不跨能力求和）。
 */

const fmtTok = (n: number | null): string => (n == null ? '—' : n >= 1_000_000 ? (n / 1_000_000).toFixed(2) + 'M' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n))
const fmtCost = (n: number | null): string => (n == null ? '价目未同步' : '$' + n.toFixed(4))
const pct = (v: number | null): string => (v == null ? '—' : Math.round(v * 100) + '%')
const clock = (n: number): string => new Date(n).toLocaleTimeString('sv-SE')

export function DashView({ selected }: { selected: WorkspaceInfo | null }) {
  const [summary, setSummary] = useState<MeteringSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    if (!selected) return
    setError(null)
    setLoading(true)
    try {
      setSummary(await window.car.meteringSummary(selected.id))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [selected])

  useEffect(() => {
    setSummary(null)
    setError(null)
    if (selected) void load()
  }, [selected, load])

  if (!selected) {
    return (
      <section className="card viewcard">
        <h2>仪表盘</h2>
        <p className="dim">先在侧栏选择工作区——计量事实 = 该工作区全部会话 JSONL 的 usage 事件（含已删除会话）。</p>
      </section>
    )
  }

  const bars = summary?.dailyBars ?? []
  const maxBar = Math.max(1, ...bars.map((b) => b.input + b.output + b.cacheRead))

  return (
    <section className="card viewcard">
      <h2>仪表盘 · 计量</h2>
      <p className="dim">
        usage 事件真实值聚合（工作区全量会话）· 无价目 = 「价目未同步」（禁 0 禁估算）· 覆盖率缺失显性化
        <button className="btn" style={{ marginLeft: 12 }} disabled={loading} onClick={() => void load()}>
          {loading ? '聚合中…' : '↻ 刷新'}
        </button>
      </p>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {summary && !summary.priceSynced && (
        <div className="banner warn">价目未同步——金额列不呈现（禁 0 禁估算）；token 数是唯一事实</div>
      )}
      {summary && (
        <>
          <div className="cards">
            <div className="stat">
              <div className="k">今日 tokens（in / out）</div>
              <div className="v">
                {fmtTok(summary.cards.today.input)} / {fmtTok(summary.cards.today.output)}
              </div>
              <div className="d">缓存读 {fmtTok(summary.cards.today.cacheRead)}</div>
            </div>
            <div className="stat">
              <div className="k">今日消耗</div>
              <div className="v">{fmtCost(summary.cards.today.cost)}</div>
              <div className="d">{summary.priceSynced ? '按价目现算' : '价目未同步'}</div>
            </div>
            <div className="stat">
              <div className="k">缓存命中率</div>
              <div className="v">{pct(summary.cards.cacheHitRate)}</div>
              <div className="d">cacheRead ÷ (input + cacheRead)</div>
            </div>
            <div className="stat">
              <div className="k">usage 覆盖率</div>
              <div className="v">{pct(summary.cards.usageCoverage)}</div>
              <div className="d">缺失 {summary.cards.turnsWithoutUsage} turn（provider 未回，不估算）</div>
            </div>
          </div>

          <h3>近 7 日 tokens（in + out + 缓存读）</h3>
          <div className="bars">
            {bars.map((b) => {
              const total = b.input + b.output + b.cacheRead
              return (
                <div key={b.day} className={`bar ${total === maxBar ? 'hot' : ''}`} title={`${b.day} · in ${fmtTok(b.input)} / out ${fmtTok(b.output)} / 缓存读 ${fmtTok(b.cacheRead)} · ${fmtCost(b.cost)}`}>
                  <i style={{ height: `${Math.round((total / maxBar) * 100)}%` }} />
                  <span>{b.day.slice(5)}</span>
                </div>
              )
            })}
          </div>

          <h3>按模型聚合</h3>
          <table className="mtable">
            <thead>
              <tr>
                <th>模型</th>
                <th>请求</th>
                <th>输入</th>
                <th>输出</th>
                <th>缓存读</th>
                <th>缓存写</th>
                <th>金额</th>
              </tr>
            </thead>
            <tbody>
              {summary.byModel.length === 0 && (
                <tr>
                  <td colSpan={7} className="dim">
                    暂无 usage 事实
                  </td>
                </tr>
              )}
              {summary.byModel.map((m) => (
                <tr key={m.model}>
                  <td>
                    <b>{m.model}</b>
                  </td>
                  <td>{m.requests}</td>
                  <td>{fmtTok(m.input)}</td>
                  <td>{fmtTok(m.output)}</td>
                  <td>{fmtTok(m.cacheRead)}</td>
                  <td>{fmtTok(m.cacheCreation)}</td>
                  <td>{fmtCost(m.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3>turn 明细（最近 {Math.min(20, summary.turns.length)} / 共 {summary.turns.length}）</h3>
          <table className="mtable">
            <thead>
              <tr>
                <th>时间</th>
                <th>turn</th>
                <th>模型</th>
                <th>输入</th>
                <th>输出</th>
                <th>缓存读</th>
                <th>请求</th>
                <th>金额</th>
                <th>关联能力</th>
              </tr>
            </thead>
            <tbody>
              {summary.turns.length === 0 && (
                <tr>
                  <td colSpan={9} className="dim">
                    暂无 usage 事实
                  </td>
                </tr>
              )}
              {summary.turns.slice(0, 20).map((t) => (
                <tr key={t.sessionId + '::' + t.turnId}>
                  <td className="mono">{clock(t.ts)}</td>
                  <td className="mono">{t.turnId}</td>
                  <td>{t.model ?? '—'}</td>
                  <td>{fmtTok(t.input)}</td>
                  <td>{fmtTok(t.output)}</td>
                  <td>{fmtTok(t.cacheRead)}</td>
                  <td>{t.requests}</td>
                  <td>{fmtCost(t.cost)}</td>
                  <td>{t.tools.length ? t.tools.join('、') : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {summary.warnings.length > 0 && (
            <div className="banner warn">
              {summary.warnings.map((w, i) => (
                <div key={i}>{w}</div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  )
}
