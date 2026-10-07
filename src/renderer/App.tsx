import { useCallback, useEffect, useState } from 'react'
import type { HostProbeResult, SessionInfo, WorkspaceInfo } from '../shared/ipc-contract'

/**
 * S1 最小首窗（壳基座）：左栏工作区 + 会话骨架（空态 + 新建动作接 IPC）+
 * probe 展示位。会话主旅程（流式/授权门/ctx-pop）随 S2 接入——立项书 §4 迭代拆解。
 * 错误呈现纪律：任何 Promise 拒绝落红条全文展示（fail-visible，禁静默吞错）。
 */
export function App() {
  const [probe, setProbe] = useState<HostProbeResult | null>(null)
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([])
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [selected, setSelected] = useState<WorkspaceInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [manualPath, setManualPath] = useState('')

  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e))

  const refreshWorkspaces = useCallback(async () => {
    const [p, ws] = await Promise.all([window.car.probe(), window.car.listWorkspaces()])
    setProbe(p)
    setWorkspaces(ws)
    return ws
  }, [])

  useEffect(() => {
    refreshWorkspaces().catch(fail)
  }, [refreshWorkspaces])

  const selectWorkspace = useCallback(async (w: WorkspaceInfo) => {
    setSelected(w)
    setStatus(null)
    try {
      setSessions(await window.car.listSessions(w.id))
    } catch (e) {
      fail(e)
    }
  }, [])

  const pickWorkspace = async () => {
    setError(null)
    try {
      const w = await window.car.pickAndRegisterWorkspace()
      if (!w) {
        setStatus('已取消选择')
        return
      }
      await refreshWorkspaces()
      await selectWorkspace(w)
      setStatus(`已注册工作区：${w.name}${w.configPath ? '（config 已装载）' : '（无 car.config，正常态）'}`)
    } catch (e) {
      fail(e)
    }
  }

  const addByPath = async () => {
    setError(null)
    try {
      const w = await window.car.registerWorkspaceByPath(manualPath.trim())
      setManualPath('')
      await refreshWorkspaces()
      await selectWorkspace(w)
      setStatus(`已注册工作区：${w.name}`)
    } catch (e) {
      fail(e)
    }
  }

  const newSession = async () => {
    if (!selected) return
    setError(null)
    try {
      const s = await window.car.createSession(selected.id)
      setSessions(await window.car.listSessions(selected.id))
      setStatus(`已新建会话 ${s.sessionId}（session-start 已落链，${s.eventCount} 事件）`)
    } catch (e) {
      fail(e)
    }
  }

  const openSession = async (s: SessionInfo) => {
    if (!selected) return
    setError(null)
    try {
      const r = await window.car.openSession(selected.id, s.sessionId)
      setStatus(`会话 ${r.sessionId}：${r.eventCount} 事件在链（内容呈现随 S2）`)
    } catch (e) {
      fail(e)
    }
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="logo">CR</span>
          <b>CAR Desktop</b>
          <span className="ver">{probe ? `seam ${probe.seamVersion}` : '…'}</span>
        </div>

        <div className="sec">工作区</div>
        <div className="list">
          {workspaces.length === 0 && <div className="empty">尚未注册工作区</div>}
          {workspaces.map((w) => (
            <button
              key={w.id}
              className={`item ${selected?.id === w.id ? 'sel' : ''}`}
              onClick={() => void selectWorkspace(w)}
              title={w.path}
            >
              <span className="ico">◈</span>
              <span>
                <b>{w.name}</b>
                <small>{w.configPath ? 'config 已装载' : '无 car.config'}</small>
              </span>
            </button>
          ))}
        </div>
        <div className="ws-actions">
          <button className="btn" onClick={() => void pickWorkspace()}>
            ＋ 选择文件夹注册…
          </button>
          <div className="manual">
            <input
              placeholder="或输入绝对路径…"
              value={manualPath}
              onChange={(e) => setManualPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && manualPath.trim()) void addByPath()
              }}
            />
            <button className="btn" disabled={!manualPath.trim()} onClick={() => void addByPath()}>
              注册
            </button>
          </div>
        </div>

        <div className="sec">
          会话<button className="mini" disabled={!selected} onClick={() => void newSession()}>
            ＋ 新建
          </button>
        </div>
        <div className="list">
          {!selected && <div className="empty">先选择工作区</div>}
          {selected && sessions.length === 0 && <div className="empty">此工作区暂无会话</div>}
          {sessions.map((s) => (
            <button key={s.sessionId} className="item" onClick={() => void openSession(s)}>
              <span className="ico">◇</span>
              <span>
                <b>{s.sessionId}</b>
                <small>
                  {new Date(s.createdAt).toLocaleString()} · {s.eventCount} 事件
                </small>
              </span>
            </button>
          ))}
        </div>

        <div className="foot">会话挂工作区作用域 · session-start 事件落 JSONL 链 · S1 壳基座</div>
      </aside>

      <main className="main">
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        {status && <div className="status">{status}</div>}

        <section className="card">
          <h2>seam 探测（doctor 展示位）</h2>
          {probe ? (
            <ul>
              <li>
                内核 seam：<b>{probe.seamVersion}</b>
              </li>
              <li>
                宿主 Node：<b>{probe.nodeVersion}</b>
              </li>
              <li>
                导出符号：<b>{probe.symbolCount}</b>
                {probe.typeCount != null && <> · 类型 {probe.typeCount}</>}
              </li>
              <li className="dim">宿主消费符号在位：SessionLog / SessionFileStore / loadCarConfig / warmCarConfig</li>
            </ul>
          ) : (
            <p className="dim">探测中…</p>
          )}
        </section>

        <section className="card">
          <h2>会话主旅程</h2>
          <p className="dim">
            S2 接入：chat 流式 · M3 授权门三档（120s 超时默认拒绝）· ctx-pop 上下文用量 · 会话切换保留现场。
            S1 范围 = 壳基座与安全基线（立项书 §4 迭代拆解）。
          </p>
        </section>
      </main>
    </div>
  )
}
