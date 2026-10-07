import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AuthzPendingPush,
  AuthzResolvedPush,
  HostProbeResult,
  SessionEventDTO,
  SessionEventPush,
  SessionInfo,
  SessionUsageResult,
  WorkspaceInfo,
} from '../shared/ipc-contract'

/**
 * S2 会话主旅程（渲染薄皮，逻辑下沉宿主——D-S2-1 事件级流式：屏幕上每个字都来自
 * 落链事件；授权 120s 倒计时仅展示口径，超时判定真值在内核——D-S2-5）。
 * 错误呈现纪律：任何 Promise 拒绝落红条全文展示（fail-visible，禁静默吞错）。
 */

interface ToolCard {
  callId: string
  tool: string
  argsPreview: string
  authz: 'granted' | 'denied' | null
  result: string | null
  error: string | null
}

type ChatItem =
  | { kind: 'msg'; role: 'user' | 'agent'; text: string }
  | { kind: 'tool'; card: ToolCard }
  | { kind: 'line'; tone: 'dim' | 'ok' | 'warn'; text: string }

const fmtTok = (n: number | null): string =>
  n == null ? '—' : n >= 10000 ? (n / 1000).toFixed(1) + 'k' : String(n)

function argsPreview(args: unknown): string {
  const p = args as Record<string, unknown> | null
  const path = p?.['path']
  return typeof path === 'string' ? path : JSON.stringify(args ?? {}).slice(0, 80)
}

function buildChatItems(events: SessionEventDTO[]): ChatItem[] {
  const items: ChatItem[] = []
  const cards = new Map<string, ToolCard>()
  for (const e of events) {
    const payload = e.payload
    const p = (payload ?? {}) as Record<string, unknown>
    if (e.kind === 'user') {
      items.push({ kind: 'msg', role: 'user', text: String(payload ?? '') })
    } else if (e.kind === 'assistant') {
      items.push({ kind: 'msg', role: 'agent', text: String(payload ?? '') })
    } else if (e.kind === 'toolCall') {
      const callId = String(p['id'] ?? '')
      const card: ToolCard = {
        callId,
        tool: String(p['tool'] ?? '?'),
        argsPreview: argsPreview(p['args']),
        authz: null,
        result: null,
        error: null,
      }
      cards.set(callId, card)
      items.push({ kind: 'tool', card })
    } else if (e.kind === 'toolResult') {
      const callId = String(p['id'] ?? '')
      const card = cards.get(callId)
      if (!card) continue
      if (p['error'] === 'authorization-denied' && p['granted'] !== undefined) {
        // 内核授权决策留痕（先落日志后放行）——执行结果另有 toolResult
        card.authz = p['granted'] === true ? 'granted' : 'denied'
        if (p['granted'] !== true) card.error = '授权拒绝（authorization-denied）'
      } else if (typeof p['error'] === 'string') {
        card.error = p['error']
      } else if (p['result'] !== undefined) {
        card.result = JSON.stringify(p['result'])
      }
    } else if (e.kind === 'turnEnd' && e.turnId.startsWith('authz:')) {
      // 内核授权审计事件（AuthzService #commit）——按 turnId 前缀区分，不当真 turn 收口
      const decision = String(p['decision'] ?? '')
      const by = String(p['decidedBy'] ?? '')
      items.push({ kind: 'line', tone: decision === 'APPROVED' ? 'ok' : 'warn', text: `授权决策 ${decision}（${by}）· ${e.turnId.slice(6, 26)}` })
    } else if (e.kind === 'turnEnd') {
      const meta = (e.meta ?? {}) as Record<string, unknown>
      const u = meta['usage'] as Record<string, number> | undefined
      items.push({
        kind: 'line',
        tone: 'dim',
        text:
          `turn 收口：${String(meta['reason'] ?? '?')}` +
          (u ? ` · 用量 in ${fmtTok(u['input'] ?? null)} / out ${fmtTok(u['output'] ?? null)} / 缓存读 ${fmtTok(u['cacheRead'] ?? null)}` : ' · 用量未采集'),
      })
    } else if (e.kind === 'system') {
      const type = String(p['type'] ?? '')
      if (type === 'session-start') items.push({ kind: 'line', tone: 'dim', text: '会话已创建（session-start 已落链）' })
      else if (type === 'model/set') items.push({ kind: 'line', tone: 'dim', text: `模型切换 → ${String(p['model'] ?? '?')}（model/set 已落链）` })
      else if (type === 'session/rename') items.push({ kind: 'line', tone: 'dim', text: `会话重命名 → ${String(p['title'] ?? '?')}` })
    }
    // kind usage：turnEnd 摘要已覆盖，不重复渲染
  }
  return items
}

export function App() {
  const [probe, setProbe] = useState<HostProbeResult | null>(null)
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([])
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [selected, setSelected] = useState<WorkspaceInfo | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [events, setEvents] = useState<SessionEventDTO[]>([])
  const [usage, setUsage] = useState<SessionUsageResult | null>(null)
  const [sessionModel, setSessionModel] = useState<string | null>(null)
  const [pending, setPending] = useState<AuthzPendingPush | null>(null)
  const [countdown, setCountdown] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [manualPath, setManualPath] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [showCtx, setShowCtx] = useState(false)
  const [showModelInput, setShowModelInput] = useState(false)
  const [modelInput, setModelInput] = useState('')
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const openRef = useRef<{ wsId: string; sessionId: string } | null>(null)

  const fail = useCallback((e: unknown) => setError(e instanceof Error ? e.message : String(e)), [])

  const refreshSessions = useCallback(
    async (wsId: string) => {
      setSessions(await window.car.listSessions(wsId))
    },
    [],
  )

  // ── 初始化 + 推送订阅（一次挂载，按 openRef 过滤当前会话） ──────────────
  useEffect(() => {
    window.car
      .probe()
      .then(setProbe)
      .catch(fail)
    const offEvent = window.car.onSessionEvent((p: SessionEventPush) => {
      const cur = openRef.current
      if (!cur || p.workspaceId !== cur.wsId || p.sessionId !== cur.sessionId) return
      setEvents((prev) => [...prev, p.event])
      if (p.event.kind === 'turnEnd' && !p.event.turnId.startsWith('authz:')) {
        setBusy(false)
        void window.car.sessionUsage(cur.wsId, cur.sessionId).then(setUsage).catch(fail)
      }
    })
    const offPending = window.car.onAuthzPending((p: AuthzPendingPush) => {
      const cur = openRef.current
      if (!cur || p.workspaceId !== cur.wsId || p.sessionId !== cur.sessionId) return
      setPending(p)
      setCountdown(Math.max(0, Math.ceil((p.ts + p.timeoutMs - Date.now()) / 1000)))
    })
    const offResolved = window.car.onAuthzResolved((p: AuthzResolvedPush) => {
      setPending((cur) => {
        if (cur?.requestId !== p.requestId) return cur
        if (p.outcome === 'timeout') setStatus('授权超时——内核默认拒绝（timeout-default-deny）')
        if (p.outcome === 'cancelled') setStatus('授权请求已取消（会话关闭）')
        return null
      })
    })
    return () => {
      offEvent()
      offPending()
      offResolved()
    }
  }, [fail])

  // 倒计时（展示口径；真值在内核）
  useEffect(() => {
    if (!pending) return
    const t = setInterval(() => {
      setCountdown(Math.max(0, Math.ceil((pending.ts + pending.timeoutMs - Date.now()) / 1000)))
    }, 250)
    return () => clearInterval(t)
  }, [pending])

  // 自动滚底
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [events, pending])

  // ── 工作区/会话 ────────────────────────────────────────────────────────
  const pickWorkspace = async () => {
    setError(null)
    try {
      const w = await window.car.pickAndRegisterWorkspace()
      if (!w) return
      const all = await window.car.listWorkspaces()
      setWorkspaces(all)
      await selectWorkspace(all.find((x) => x.id === w.id) ?? w)
    } catch (e) {
      fail(e)
    }
  }

  const addByPath = async () => {
    setError(null)
    try {
      const w = await window.car.registerWorkspaceByPath(manualPath.trim())
      setManualPath('')
      setWorkspaces(await window.car.listWorkspaces())
      await selectWorkspace(w)
    } catch (e) {
      fail(e)
    }
  }

  const selectWorkspace = async (w: WorkspaceInfo) => {
    setSelected(w)
    setOpenId(null)
    setEvents([])
    setUsage(null)
    setPending(null)
    setBusy(false)
    try {
      setSessions(await window.car.listSessions(w.id))
    } catch (e) {
      fail(e)
    }
  }

  const openSessionById = async (sessionId: string) => {
    if (!selected) return
    setError(null)
    try {
      const r = await window.car.openSession(selected.id, sessionId)
      openRef.current = { wsId: selected.id, sessionId }
      setOpenId(sessionId)
      setEvents(r.events)
      setSessionModel(r.model)
      setUsage(await window.car.sessionUsage(selected.id, sessionId))
      setPending(null)
      setBusy(false)
    } catch (e) {
      fail(e)
    }
  }

  const newSession = async () => {
    if (!selected) return
    setError(null)
    try {
      await window.car.createSession(selected.id)
      await refreshSessions(selected.id)
      setStatus('已新建会话（session-start 已落链）')
    } catch (e) {
      fail(e)
    }
  }

  const commitRename = async (sessionId: string) => {
    if (!selected) return
    setEditingId(null)
    const title = editTitle.trim()
    if (!title) return
    try {
      await window.car.renameSession(selected.id, sessionId, title)
      await refreshSessions(selected.id)
    } catch (e) {
      fail(e)
    }
  }

  const removeSession = async (sessionId: string) => {
    if (!selected) return
    setError(null)
    try {
      await window.car.deleteSession(selected.id, sessionId)
      if (openId === sessionId) {
        setOpenId(null)
        setEvents([])
      }
      await refreshSessions(selected.id)
      setStatus('会话已删除（delete 留痕，JSONL 保留）')
    } catch (e) {
      fail(e)
    }
  }

  // ── turn / 授权 / 模型 ────────────────────────────────────────────────
  const send = async () => {
    if (!selected || !openId || !input.trim()) return
    setError(null)
    const text = input.trim()
    setInput('')
    try {
      setBusy(true)
      await window.car.sendTurn(selected.id, openId, text)
    } catch (e) {
      setBusy(false)
      fail(e)
    }
  }

  const stop = async () => {
    if (!selected || !openId) return
    try {
      await window.car.abortTurn(selected.id, openId)
      setStatus('已请求停止——等待内核 abort 收口')
    } catch (e) {
      fail(e)
    }
  }

  const respond = async (decision: 'once' | 'session' | 'deny') => {
    if (!selected || !openId || !pending) return
    try {
      await window.car.respondAuthz(selected.id, openId, pending.requestId, decision)
      setPending(null)
    } catch (e) {
      fail(e)
    }
  }

  const switchModel = async (m: string) => {
    if (!selected || !openId || !m.trim()) return
    try {
      await window.car.setSessionModel(selected.id, openId, m.trim())
      setSessionModel(m.trim())
      setShowModelInput(false)
    } catch (e) {
      fail(e)
    }
  }

  // ── 渲染 ──────────────────────────────────────────────────────────────
  const items = buildChatItems(events)

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
            <button key={w.id} className={`item ${selected?.id === w.id ? 'sel' : ''}`} onClick={() => void selectWorkspace(w)} title={w.path}>
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
          会话
          <button className="mini" disabled={!selected} onClick={() => void newSession()}>
            ＋ 新建
          </button>
        </div>
        <div className="list">
          {!selected && <div className="empty">先选择工作区</div>}
          {selected && sessions.length === 0 && <div className="empty">此工作区暂无会话</div>}
          {sessions.map((s) => (
            <div key={s.sessionId} className={`item sess ${openId === s.sessionId ? 'sel' : ''}`}>
              {editingId === s.sessionId ? (
                <input
                  className="rename"
                  value={editTitle}
                  autoFocus
                  onChange={(e) => setEditTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void commitRename(s.sessionId)
                    if (e.key === 'Escape') setEditingId(null)
                  }}
                />
              ) : (
                <button className="item-main" onClick={() => void openSessionById(s.sessionId)}>
                  <span className="ico">◇</span>
                  <span>
                    <b>{s.title}</b>
                    <small>
                      {s.sessionId} · {s.eventCount} 事件
                    </small>
                  </span>
                </button>
              )}
              <span className="sess-ops">
                <button
                  className="mini"
                  title="重命名"
                  onClick={() => {
                    setEditingId(s.sessionId)
                    setEditTitle(s.title)
                  }}
                >
                  ✎
                </button>
                <button className="mini danger" title="删除（留痕，JSONL 保留）" onClick={() => void removeSession(s.sessionId)}>
                  ✕
                </button>
              </span>
            </div>
          ))}
        </div>

        <div className="foot">事件级流式 · 与审计 JSONL 同源同序 · S2 会话主旅程</div>
      </aside>

      <main className="main">
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        {status && <div className="status">{status}</div>}

        {openId && selected ? (
          <section className="chat">
            <div className="chat-toolbar">
              <button className="pill" onClick={() => setShowModelInput((v) => !v)} title="切换模型（model/set 落链）">
                模型：{sessionModel ?? '未配置'} ▾
              </button>
              {showModelInput && (
                <span className="manual">
                  <input
                    placeholder="同端点 Model ID…"
                    value={modelInput}
                    autoFocus
                    onChange={(e) => setModelInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void switchModel(modelInput)
                      if (e.key === 'Escape') setShowModelInput(false)
                    }}
                  />
                  <button className="btn" disabled={!modelInput.trim()} onClick={() => void switchModel(modelInput)}>
                    切换
                  </button>
                </span>
              )}
              <button className="pill" onClick={() => setShowCtx((v) => !v)}>
                上下文{usage ? `：累计 in ${fmtTok(usage.input)} / out ${fmtTok(usage.output)}` : ''}
              </button>
              {busy && <span className="live">● turn 进行中</span>}
            </div>
            {showCtx && usage && (
              <div className="ctx-pop">
                <div>turn 数：{usage.turns} · 请求：{usage.requests} · usage 覆盖率：{usage.coverage == null ? '—' : Math.round(usage.coverage * 100) + '%'}</div>
                <div>累计：in {fmtTok(usage.input)} · out {fmtTok(usage.output)} · 缓存读 {fmtTok(usage.cacheRead)} · 缓存写 {fmtTok(usage.cacheCreation)}</div>
                <div>最近请求：in {fmtTok(usage.lastInput)} / out {fmtTok(usage.lastOutput)}（usage 事件真实值，缺失不估算）</div>
              </div>
            )}
            {pending && (
              <div className="authz">
                <div className="authz-head">
                  <b>M3 授权门</b>
                  <span className={`timer ${countdown <= 10 ? 'hot' : ''}`}>{countdown}s 后超时默认拒绝</span>
                </div>
                <div className="authz-body">
                  工具 <code>{pending.tool}</code> · 目标 <code>{pending.resource}</code>（{pending.capability}）
                </div>
                <div className="authz-actions">
                  <button className="btn primary" onClick={() => void respond('once')}>
                    批准本次
                  </button>
                  <button className="btn" onClick={() => void respond('session')}>
                    本次会话内始终允许
                  </button>
                  <button className="btn danger" onClick={() => void respond('deny')}>
                    拒绝
                  </button>
                </div>
              </div>
            )}
            <div className="chat-scroll" ref={scrollRef}>
              {items.map((it, i) => {
                if (it.kind === 'msg') {
                  return (
                    <div key={i} className={`msg ${it.role}`}>
                      <div className="who">{it.role === 'user' ? '我' : 'CR'}</div>
                      <div className="bubble">{it.text}</div>
                    </div>
                  )
                }
                if (it.kind === 'tool') {
                  return (
                    <div key={i} className="msg agent">
                      <div className="who">CR</div>
                      <div className="bubble">
                        <div className="toolcard">
                          <div className="tc-head">
                            工具 <code>{it.card.tool}</code>
                            {it.card.authz === 'granted' && <span className="tag ok">已授权</span>}
                            {it.card.authz === 'denied' && <span className="tag err">授权拒绝</span>}
                          </div>
                          <div className="tc-body">
                            目标 <code>{it.card.argsPreview}</code>
                            {it.card.result && <div className="ok-line">结果：{it.card.result}</div>}
                            {it.card.error && <div className="err-line">{it.card.error}</div>}
                          </div>
                        </div>
                      </div>
                    </div>
                  )
                }
                return (
                  <div key={i} className={`line ${it.tone}`}>
                    {it.text}
                  </div>
                )
              })}
            </div>
            <div className="chat-input">
              <input
                placeholder={busy ? 'turn 进行中…（可停止）' : '给 Agent 布置任务…（Enter 发送）'}
                value={input}
                disabled={busy}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !busy) void send()
                }}
              />
              {busy ? (
                <button className="btn danger" onClick={() => void stop()}>
                  ■ 停止
                </button>
              ) : (
                <button className="btn primary" disabled={!input.trim()} onClick={() => void send()}>
                  发送
                </button>
              )}
            </div>
          </section>
        ) : (
          <section className="card">
            <h2>会话主旅程</h2>
            <p className="dim">
              选择/新建会话开始。S2 能力：chat 事件级流式 · M3 授权门三档（120s 超时默认拒绝）·
              停止 · ctx-pop 用量 · 会话重命名/删除留痕 · 模型切换（model/set 落链）。
            </p>
          </section>
        )}
      </main>
    </div>
  )
}
