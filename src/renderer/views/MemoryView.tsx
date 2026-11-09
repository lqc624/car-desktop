import { useCallback, useEffect, useState } from 'react'
import type { MemoryEntryDTO, SessionEventDTO, WorkspaceInfo } from '../../shared/ipc-contract'
import {
  memoryPressureOf,
  evolutionRowsFrom,
  evolutionPendingFrom,
  EVOLVE_AUTO_PCT,
  EVOLVE_REVIEW_TIMEOUT_MS,
  MEMORY_PRESSURE_CAP_CHARS,
} from '../../shared/memory-evolution'

/**
 * S6 白盒记忆面板（K-MEM-1 消费面 / D-S6-4；内核 1.15 MemoryStore）+ T-ME 记忆进化（手动 + auto）
 *
 * 口径：
 *  - 列表（updatedAt 降序）/ 内联编辑 / 删除 / 回滚（内核 undo 栈单步时间回退——返回 null =
 *    已回退到删除态）；rollback/delete = 补偿事件追加，已落链事件零改写（审计链不可变红线）；
 *  - **落链承载 = 操作时活跃会话**（D-46 ② 宿主指定会话语义）：无活跃会话 = 操作禁用 +
 *    提示（宿主侧 requireAliveHandle 双保险显式拒绝）；每条记忆的 write/edit/delete/rollback
 *    事件在来源会话的审计流水页可查（memory kind 渲染分支联动）；
 *  - 新建记忆需活跃会话（sourceSession = 当前会话 id——可溯性辅助字段）；
 *  - secrets 不入记忆通道（内核零凭据路径 + 工作区本地边界）；
 *  - **进化**：立即进化 = 宿主 LLM 直调（一次性内存 log——候选落链 memory/evolution + usage
 *    计量）；候选复核 = 人审门语义（批准落盘走 MemoryStore 落 kind='memory' 事件；拒绝随
 *    feedback 留痕）；auto 模式 = 回合收口检查压力 ≥70% 自动发起，候选 120s 未复核默认放弃
 *    （timeout-default-deny 同语义）；复核区/摘要表从链事件派生（重启可重建——链即真值）；
 *    进化模式 = 端侧偏好（localStorage，不落审计链）。
 */

const fmtTime = (ts: number): string => new Date(ts).toLocaleString()

/** 进化模式 = 端侧偏好（不落审计链——★默认模型同款读写形态） */
const EVOLVE_MODE_KEY = 'car-desktop.memoryEvolveMode'
function readEvolveMode(): 'manual' | 'auto' {
  try {
    return localStorage.getItem(EVOLVE_MODE_KEY) === 'auto' ? 'auto' : 'manual'
  } catch {
    return 'manual'
  }
}
function writeEvolveMode(m: 'manual' | 'auto'): void {
  try {
    localStorage.setItem(EVOLVE_MODE_KEY, m)
  } catch {
    /* 存储不可用 = 端侧偏好降级，不阻塞 */
  }
}

export function MemoryView({
  selected,
  openId,
  events,
  onFail,
  onStatus,
}: {
  selected: WorkspaceInfo | null
  openId: string | null
  /** 当前打开会话的链事件（进化摘要/复核区派生源——无会话 = 空数组） */
  events: SessionEventDTO[]
  onFail: (e: unknown) => void
  onStatus: (s: string) => void
}) {
  const [entries, setEntries] = useState<MemoryEntryDTO[] | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [newText, setNewText] = useState('')
  const [newTags, setNewTags] = useState('')
  const [creating, setCreating] = useState(false)
  /** 已删除条目（本次面板会话内）——delete 后列表行消失，undelete 入口靠此留存（rollback 恢复链上删除前正文） */
  const [tombstones, setTombstones] = useState<string[]>([])
  // T-ME：进化面（运行态 / 模式端侧偏好 / 拒绝 feedback 单开态 / auto 倒计时 ticker）
  const [evolving, setEvolving] = useState(false)
  const [evolveMode, setEvolveMode] = useState<'manual' | 'auto'>(() => readEvolveMode())
  const [rejectFor, setRejectFor] = useState<string | null>(null)
  const [rejectFeedback, setRejectFeedback] = useState('')
  const [nowTick, setNowTick] = useState(() => Date.now())

  const pending = evolutionPendingFrom(events)
  const summaries = evolutionRowsFrom(events).slice().reverse()

  // auto 候选倒计时（复核区有 auto 未决时 1s tick——展示口径，真值 = 宿主计时器）
  useEffect(() => {
    if (!pending.some((p) => p.auto)) return
    setNowTick(Date.now())
    const t = setInterval(() => setNowTick(Date.now()), 1000)
    return () => clearInterval(t)
  }, [pending])

  // 进化模式同步到宿主（workspace 级内存态——端侧 localStorage 权威；切工作区/挂载即同步）
  useEffect(() => {
    if (!selected) return
    window.car.memoryEvolveMode(selected.id, readEvolveMode()).catch(() => { /* 同步失败 = 宿主保持 manual 缺省 */ })
  }, [selected])

  const load = useCallback(async () => {
    if (!selected) return
    try {
      setEntries(await window.car.memoryList(selected.id))
    } catch (e) {
      onFail(e)
    }
  }, [selected, onFail])

  // T-34（v0.3 终验 D7）：list 乱序守卫——切工作区时慢响应后到覆盖新表（偶现空表）；
  // effect 内联拉取 + cancelled 闭包丢弃 stale 响应，依赖收敛 [selected]（onFail 不稳定不再触发重跑）
  useEffect(() => {
    setEntries(null)
    setCreating(false)
    setEditingId(null)
    setTombstones([])
    if (!selected) return
    let cancelled = false
    ;(async () => {
      try {
        const r = await window.car.memoryList(selected.id)
        if (!cancelled) setEntries(r)
      } catch (e) {
        if (!cancelled) onFail(e)
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected])

  const create = async (): Promise<void> => {
    if (!selected || !openId || !newText.trim()) return
    try {
      const tags = newTags
        .split(/[,，;；\s]+/)
        .map((t) => t.trim())
        .filter(Boolean)
      const e = await window.car.memoryWrite(selected.id, openId, { text: newText.trim(), ...(tags.length ? { tags } : {}) })
      setNewText('')
      setNewTags('')
      setCreating(false)
      onStatus(`记忆已创建（${e.id}）——memory/write 已落当前会话链`)
      await load()
    } catch (err) {
      onFail(err)
    }
  }

  const saveEdit = async (id: string): Promise<void> => {
    if (!selected || !openId) return
    try {
      await window.car.memoryEdit(selected.id, openId, id, editText)
      setEditingId(null)
      onStatus(`记忆已修改（${id}）——memory/edit 落链（before/after 全文 = rollback 数据源）`)
      await load()
    } catch (err) {
      onFail(err)
    }
  }

  const remove = async (id: string): Promise<void> => {
    if (!selected || !openId) return
    if (!window.confirm(`删除记忆 ${id}？（memory/delete 补偿事件落链——rollback 可恢复）`)) return
    try {
      await window.car.memoryRemove(selected.id, openId, id)
      setTombstones((t) => (t.includes(id) ? t : [...t, id]))
      onStatus(`记忆已删除（${id}）——delete 落链，链上留痕可 rollback 恢复`)
      await load()
    } catch (err) {
      onFail(err)
    }
  }

  const rollback = async (id: string): Promise<void> => {
    if (!selected || !openId) return
    try {
      const r = await window.car.memoryRollback(selected.id, openId, id)
      setTombstones((t) => (r ? t.filter((x) => x !== id) : t.includes(id) ? t : [...t, id]))
      onStatus(r ? `记忆已回退一步（${id} → 更早版本）——rollback 落链（链即版本库）` : `记忆已回退到删除态（${id}）——条目移除，再回退可恢复更早版本`)
      await load()
    } catch (err) {
      onFail(err)
    }
  }

  const tombstonesVisible = tombstones.filter((id) => !(entries ?? []).some((m) => m.id === id))

  const writeBlocked = !openId

  // ── T-ME：进化动作面 ──

  const runEvolve = async (): Promise<void> => {
    if (!selected || !openId || evolving) return
    setEvolving(true)
    try {
      const r = await window.car.memoryEvolve(selected.id, openId)
      onStatus(
        `进化运行 ${r.runId}：候选 ${r.candidates.length} 条（压力 ${r.pressure.pct}%${r.usage ? ` · usage in ${r.usage.input}/out ${r.usage.output}` : ''}）——候选落链 memory/evolution，待复核`,
      )
      await load()
    } catch (err) {
      onFail(err)
    } finally {
      setEvolving(false)
    }
  }

  const decide = async (cid: string, approve: boolean, feedback?: string): Promise<void> => {
    if (!selected || !openId) return
    const p = pending.find((x) => x.candidate.cid === cid)
    if (!p) return
    try {
      const r = await window.car.memoryEvolveDecide(selected.id, openId, p.runId, cid, approve, feedback)
      setRejectFor(null)
      setRejectFeedback('')
      onStatus(
        approve
          ? `进化候选 ${cid} 已写入（${r.op}${r.memoryId ? ` → ${r.memoryId}` : ''}）——MemoryStore 落盘 + memory/evolution-apply 落链`
          : `进化候选 ${cid} 已放弃（${r.op}）——拒绝${feedback ? '随 feedback ' : '无 feedback '}落链`,
      )
      await load()
    } catch (err) {
      onFail(err)
    }
  }

  const toggleMode = (): void => {
    const next = evolveMode === 'auto' ? 'manual' : 'auto'
    setEvolveMode(next)
    writeEvolveMode(next)
    if (selected) void window.car.memoryEvolveMode(selected.id, next).catch(() => { /* 同步失败 = 端侧偏好保持 */ })
    onStatus(next === 'auto' ? `进化模式 → 自动（回合收口检查压力 ≥${EVOLVE_AUTO_PCT}% 自动发起；候选 ${Math.round(EVOLVE_REVIEW_TIMEOUT_MS / 1000)}s 未复核默认放弃）` : '进化模式 → 手动（仅「立即进化」按钮触发）')
  }

  const pressure = memoryPressureOf(entries ?? [])

  return (
    <section className="card viewcard">
      <h2>记忆（白盒）</h2>
      <p className="dim">
        <code className="mono">&lt;workspace&gt;/.car/memory/</code> 逐条 JSON · write/edit/delete/rollback 全落当前会话审计链
        （哈希链保护——篡改在链上可见）· rollback = 链上版本栈单步回退（链即版本库，恢复数据源 =
        事件 payload）· 注入 = 会话首轮 system 行（ctx-pop 可见）· 自动抽取/向量检索登记不做（D-V02-4）。
      </p>
      {!selected && <p className="dim">先在侧栏选择工作区（记忆按工作区分片隔离）。</p>}
      {selected && entries !== null && entries.length > 0 && (
        <div className="ev-pressure">
          <div className="ev-pressure-head">
            <b>记忆压力 {pressure.pct}%</b>
            <span className="dim">
              {pressure.chars} 字符 / {pressure.count} 条 · 满格 = {MEMORY_PRESSURE_CAP_CHARS} 字符（4× 注入预算——确定性派生禁估算）
              {pressure.pct >= EVOLVE_AUTO_PCT && evolveMode === 'auto' ? ` · ≥${EVOLVE_AUTO_PCT}%：回合收口将自动发起进化` : ''}
            </span>
          </div>
          <div className="ev-bar">
            <div className={`ev-fill${pressure.pct >= EVOLVE_AUTO_PCT ? ' hot' : ''}`} style={{ width: `${pressure.pct}%` }} />
          </div>
        </div>
      )}
      {selected && (        <>
          <div className="mem-new">
            {creating ? (
              <>
                <textarea
                  className="mem-textarea"
                  placeholder="记忆正文…（空正文会被 fail-visible 拒绝）"
                  value={newText}
                  autoFocus
                  onChange={(e) => setNewText(e.target.value)}
                />
                <input className="mem-tags" placeholder="标签（可选，逗号分隔）" value={newTags} onChange={(e) => setNewTags(e.target.value)} />
                <div className="mem-ops">
                  <button className="btn primary" disabled={!newText.trim() || writeBlocked} onClick={() => void create()}>
                    落链保存
                  </button>
                  <button className="btn" onClick={() => setCreating(false)}>
                    取消
                  </button>
                  {writeBlocked && <span className="dim">⚠ 记忆操作需要打开一个会话（落链承载 = 活跃会话）——先在侧栏打开会话</span>}
                </div>
              </>
            ) : (
              <button className="btn primary" onClick={() => setCreating(true)} disabled={!openId} title={writeBlocked ? '需要打开一个会话（落链承载）' : '新建记忆（memory/write 落链）'}>
                ＋ 新建记忆
              </button>
            )}
          </div>
          {entries !== null && entries.length === 0 && <p className="dim">此工作区暂无记忆（记忆按工作区分片——跨工作区互不可见）。</p>}
          {entries !== null && entries.length > 0 && (
            <table className="mtable">
              <thead>
                <tr>
                  <th>id</th>
                  <th>正文</th>
                  <th>标签</th>
                  <th>更新于</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((m) => (
                  <tr key={m.id}>
                    <td className="mono dim2" title={m.sourceSession ? `来源会话：${m.sourceSession}（memory 事件在其审计流水可查）` : undefined}>
                      {m.id}
                    </td>
                    <td>
                      {editingId === m.id ? (
                        <textarea
                          className="mem-textarea"
                          value={editText}
                          autoFocus
                          onChange={(e) => setEditText(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void saveEdit(m.id)
                            if (e.key === 'Escape') setEditingId(null)
                          }}
                        />
                      ) : (
                        <span className="mem-text">{m.text}</span>
                      )}
                    </td>
                    <td className="dim2">{m.tags?.length ? m.tags.join('、') : '—'}</td>
                    <td className="dim2">{fmtTime(m.updatedAt)}</td>
                    <td>
                      <span className="mem-ops">
                        {editingId === m.id ? (
                          <>
                            <button className="mini primary" disabled={!editText.trim()} onClick={() => void saveEdit(m.id)} title="Ctrl+Enter 保存">
                              ✓
                            </button>
                            <button className="mini" onClick={() => setEditingId(null)}>
                              ✕
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              className="mini"
                              title="内联编辑（memory/edit 落链，before/after 全文）"
                              disabled={writeBlocked}
                              onClick={() => {
                                setEditingId(m.id)
                                setEditText(m.text)
                              }}
                            >
                              ✎
                            </button>
                            <button className="mini" title="回滚一步（undo 栈——rollback 落链）" disabled={writeBlocked} onClick={() => void rollback(m.id)}>
                              ↩
                            </button>
                            <button className="mini danger" title="删除（补偿事件落链，rollback 可恢复）" disabled={writeBlocked} onClick={() => void remove(m.id)}>
                              ✕
                            </button>
                          </>
                        )}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {tombstonesVisible.length > 0 && (
            <div className="mem-trash">
              <div className="dim">最近删除（delete 已落链——回滚可 undelete 恢复删除前正文，恢复数据源 = 链上 payload）</div>
              {tombstonesVisible.map((id) => (
                <div className="mem-ops" key={id}>
                  <code className="mono">{id}</code>
                  <button className="mini" title="撤销删除（rollback 到删除前状态）" onClick={() => void rollback(id)}>
                    ↩ 撤销删除
                  </button>
                </div>
              ))}
            </div>
          )}
          {/* ── T-ME：记忆进化（手动 + auto）——LLM 直调候选 → 人审门语义复核 → MemoryStore 落盘落链 ── */}
          <div className="ev-card">
            <div className="ev-head">
              <b>记忆进化</b>
              <button
                className={`ev-pill${evolveMode === 'auto' ? ' auto' : ''}`}
                onClick={toggleMode}
                title={
                  evolveMode === 'auto'
                    ? '自动：回合收口后检查记忆压力，≥70% 自动发起进化（候选 120s 未复核默认放弃）。点击切回手动。'
                    : '手动：仅「立即进化」按钮触发。点击切为自动（回合收口检查压力 ≥70% 自动发起）。'
                }
              >
                进化：{evolveMode === 'auto' ? '自动' : '手动'}
              </button>
            </div>
            <p className="dim">
              进化 = 全量记忆交会话模型重组（合并重复 / 修正过时 / 删除失效 / 补缺口）→ 变更候选逐条复核 →
              批准写入落盘落链（memory kind 审计行）。运行本身落链 + usage 计量；候选进模型上下文前过脱敏。
            </p>
            <div className="mem-ops">
              <button
                className="btn primary"
                disabled={!openId || evolving || !entries || entries.length === 0}
                onClick={() => void runEvolve()}
                title={
                  !openId
                    ? '需要打开一个会话（落链承载 + 会话模型）'
                    : !entries || entries.length === 0
                      ? '记忆为空——无可进化的对象'
                      : '全量记忆 → 模型重组候选（落链 + usage 计量）'
                }
              >
                {evolving ? '运行中…（LLM 直调）' : '⚡ 立即进化'}
              </button>
              {writeBlocked && <span className="dim">⚠ 进化需要打开一个会话（落链承载 + 会话模型）</span>}
            </div>
            {pending.length > 0 && (
              <div className="ev-pending">
                <div className="dim">
                  待复核候选 {pending.length} 条（复核 = 人审门语义——批准落盘落链，拒绝随 feedback 留痕；来源 = 链上 memory/evolution 派生，重启可重建）
                </div>
                {pending.map(({ runId, startedTs, auto, candidate }) => {
                  const left = auto ? Math.max(0, Math.ceil((startedTs + EVOLVE_REVIEW_TIMEOUT_MS - nowTick) / 1000)) : null
                  return (
                    <div key={runId + '::' + candidate.cid} className="ev-cand">
                      <span className={`ev-opbadge ${candidate.op}`}>{candidate.op === 'add' ? '新增' : candidate.op === 'update' ? '更新' : '删除'}</span>
                      <div className="ev-cand-body">
                        <div className="ev-cand-text">
                          {candidate.op !== 'add' && <code className="mono">{candidate.targetId}</code>}
                          {candidate.op !== 'delete' && <span>{candidate.text}</span>}
                          {candidate.tags && candidate.tags.length > 0 && <small className="dim2">（{candidate.tags.join('、')}）</small>}
                        </div>
                        <div className="dim2">
                          {candidate.reason || '（无理由）'}
                          {' · '}
                          {auto ? (
                            left != null && left > 0 ? (
                              <span className="ev-timer">{left}s 后超时默认放弃</span>
                            ) : (
                              <span className="ev-timer hot">即将超时</span>
                            )
                          ) : (
                            '手动运行 · 不超时'
                          )}
                        </div>
                        {rejectFor === candidate.cid ? (
                          <div className="ev-reject">
                            <textarea
                              className="mem-textarea"
                              placeholder="拒绝原因 / 修改意见（随复核落链留痕；可留空）"
                              value={rejectFeedback}
                              autoFocus
                              onChange={(e) => setRejectFeedback(e.target.value)}
                            />
                            <div className="mem-ops">
                              <button className="mini danger" onClick={() => void decide(candidate.cid, false, rejectFeedback)}>
                                提交拒绝
                              </button>
                              <button className="mini" onClick={() => { setRejectFor(null); setRejectFeedback('') }}>
                                返回
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="mem-ops">
                            <button className="mini primary" disabled={writeBlocked} onClick={() => void decide(candidate.cid, true)}>
                              ✓ 批准写入
                            </button>
                            <button className="mini danger" disabled={writeBlocked} onClick={() => { setRejectFor(candidate.cid); setRejectFeedback('') }}>
                              ✕ 拒绝
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
            {summaries.length > 0 && (
              <table className="mtable ev-summaries">
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>运行</th>
                    <th>触发</th>
                    <th>候选</th>
                    <th>已写入</th>
                    <th>已放弃</th>
                    <th>usage</th>
                  </tr>
                </thead>
                <tbody>
                  {summaries.map((s) => (
                    <tr key={s.runId}>
                      <td className="dim2">{fmtTime(s.ts)}</td>
                      <td className="mono dim2">{s.runId}</td>
                      <td>{s.auto ? '自动' : '手动'}</td>
                      <td>{s.candidates}</td>
                      <td className="dim2">{s.applied}</td>
                      <td className="dim2">{s.rejected}</td>
                      <td className="dim2">{s.usage ? `in ${s.usage.input} / out ${s.usage.output}` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="dim ev-foot">
              auto 模式 = 回合收口（宿主空闲点）检查记忆压力 ≥{EVOLVE_AUTO_PCT}% 自动发起——无定时调度面；
              auto 候选 {Math.round(EVOLVE_REVIEW_TIMEOUT_MS / 1000)}s 未复核默认放弃（timeout-default-deny 同语义）；
              手动运行不超时。
            </p>
          </div>
        </>
      )}
    </section>
  )
}
