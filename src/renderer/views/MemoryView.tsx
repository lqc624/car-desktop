import { useCallback, useEffect, useState } from 'react'
import type { MemoryEntryDTO, WorkspaceInfo } from '../../shared/ipc-contract'

/**
 * S6 白盒记忆面板（K-MEM-1 消费面 / D-S6-4；内核 1.15 MemoryStore）
 *
 * 口径：
 *  - 列表（updatedAt 降序）/ 内联编辑 / 删除 / 回滚（内核 undo 栈单步时间回退——返回 null =
 *    已回退到删除态）；rollback/delete = 补偿事件追加，已落链事件零改写（审计链不可变红线）；
 *  - **落链承载 = 操作时活跃会话**（D-46 ② 宿主指定会话语义）：无活跃会话 = 操作禁用 +
 *    提示（宿主侧 requireAliveHandle 双保险显式拒绝）；每条记忆的 write/edit/delete/rollback
 *    事件在来源会话的审计流水页可查（memory kind 渲染分支联动）；
 *  - 新建记忆需活跃会话（sourceSession = 当前会话 id——可溯性辅助字段）；
 *  - secrets 不入记忆通道（内核零凭据路径 + 工作区本地边界）。
 */

const fmtTime = (ts: number): string => new Date(ts).toLocaleString()

export function MemoryView({
  selected,
  openId,
  onFail,
  onStatus,
}: {
  selected: WorkspaceInfo | null
  openId: string | null
  onFail: (e: unknown) => void
  onStatus: (s: string) => void
}) {
  const [entries, setEntries] = useState<MemoryEntryDTO[] | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [newText, setNewText] = useState('')
  const [newTags, setNewTags] = useState('')
  const [creating, setCreating] = useState(false)

  const load = useCallback(async () => {
    if (!selected) return
    try {
      setEntries(await window.car.memoryList(selected.id))
    } catch (e) {
      onFail(e)
    }
  }, [selected, onFail])

  useEffect(() => {
    setEntries(null)
    setCreating(false)
    setEditingId(null)
    if (selected) void load()
  }, [selected, load])

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
      onStatus(r ? `记忆已回退一步（${id} → 更早版本）——rollback 落链（链即版本库）` : `记忆已回退到删除态（${id}）——条目移除，再回退可恢复更早版本`)
      await load()
    } catch (err) {
      onFail(err)
    }
  }

  const writeBlocked = !openId

  return (
    <section className="card viewcard">
      <h2>记忆（白盒）</h2>
      <p className="dim">
        <code className="mono">&lt;workspace&gt;/.car/memory/</code> 逐条 JSON · write/edit/delete/rollback 全落当前会话审计链
        （哈希链保护——篡改在链上可见）· rollback = 链上版本栈单步回退（链即版本库，恢复数据源 =
        事件 payload）· 注入 = 会话首轮 system 行（ctx-pop 可见）· 自动抽取/向量检索登记不做（D-V02-4）。
      </p>
      {!selected && <p className="dim">先在侧栏选择工作区（记忆按工作区分片隔离）。</p>}
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
        </>
      )}
    </section>
  )
}
