import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AuthzPendingPush,
  AuthzResolvedPush,
  HostProbeResult,
  SessionEventDTO,
  SessionEventPush,
  SessionInfo,
  SessionPolicyDTO,
  SessionUsageResult,
  WorkspaceInfo,
} from '../shared/ipc-contract'
import { AuditView } from './views/AuditView'
import { DashView } from './views/DashView'
import { McpView } from './views/McpView'
import { PluginsView } from './views/PluginsView'
import { SecurityView } from './views/SecurityView'
import { SettingsView } from './views/SettingsView'

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
      else if (type === 'session/policy') items.push({ kind: 'line', tone: 'dim', text: `会话策略 → ${String(p['policy'] ?? '?')}（session/policy 已落链）` })
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
  const [view, setView] = useState<'chat' | 'audit' | 'dash' | 'security' | 'plugins' | 'mcp' | 'settings'>('chat')
  const [policy, setPolicy] = useState<SessionPolicyDTO>('default')
  const [showPolicy, setShowPolicy] = useState(false)
  const [showParams, setShowParams] = useState(false)
  const [windowSel, setWindowSel] = useState<number | null>(null) // S4-S3 受控版：null = 跟随元数据/端点
  const [contextWindow, setContextWindow] = useState<number | null>(null)
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
    // 启动加载已注册工作区（userData/workspaces.json——重启后侧栏不再为空）
    window.car
      .listWorkspaces()
      .then(setWorkspaces)
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
      setContextWindow(r.contextWindow ?? null)
      // 会话策略 = 链上最近一次 session/policy，无则回退安全中心默认值
      const polEvent = [...r.events].reverse().find((e) => e.kind === 'system' && (e.payload as Record<string, unknown>)['type'] === 'session/policy')
      if (polEvent) {
        setPolicy((polEvent.payload as Record<string, unknown>)['policy'] as SessionPolicyDTO)
      } else {
        window.car
          .securitySettingsGet()
          .then((s) => setPolicy(s.sessionDefaultPolicy))
          .catch(() => setPolicy('default'))
      }
      setUsage(await window.car.sessionUsage(selected.id, sessionId))
      setPending(null)
      setBusy(false)
      if (r.modelError) setError(`模型未装配（turn 发送将被拒绝）：${r.modelError}`)
    } catch (e) {
      fail(e)
    }
  }

  const newSession = async () => {
    if (!selected) return
    setError(null)
    try {
      const info = await window.car.createSession(selected.id)
      await refreshSessions(selected.id)
      setContextWindow(info.contextWindow ?? null)
      if (info.modelError) {
        setError(`会话已创建，但模型未装配（turn 发送将被拒绝）：${info.modelError}`)
      } else {
        setStatus('已新建会话（session-start 已落链）')
      }
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
      await window.car.setSessionModel(selected.id, openId, m.trim(), windowSel ?? undefined)
      setSessionModel(m.trim())
      if (windowSel) setContextWindow(windowSel)
      setShowModelInput(false)
    } catch (e) {
      fail(e)
    }
  }

  const switchPolicy = async (p: SessionPolicyDTO) => {
    if (!selected || !openId) return
    setError(null)
    setShowPolicy(false)
    try {
      await window.car.setSessionPolicy(selected.id, openId, p)
      setPolicy(p)
      setStatus(`会话策略 → ${p === 'default' ? '默认安全' : p === 'session' ? '会话内放行' : '只读模式'}（session/policy 已落链）`)
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

        <div className="sec">运行</div>
        <button className={`item ${view === 'plugins' ? 'sel' : ''}`} onClick={() => setView('plugins')}><span className="ico">⧉</span><span><b>插件</b><small>装载报告 · 工具清单</small></span></button>
        <button className={`item ${view === 'mcp' ? 'sel' : ''}`} onClick={() => setView('mcp')}><span className="ico">⇄</span><span><b>MCP 服务</b><small>双传输 · 工具过授权门</small></span></button>
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

        <button className={`item ${view === 'settings' ? 'sel' : ''}`} onClick={() => setView('settings')}><span className="ico">◐</span><span><b>设置 / 诊断</b><small>doctor · 自定义端点</small></span></button>
        <div className="foot">事件级流式 · 与审计 JSONL 同源同序 · S2 会话主旅程</div>

        <div className="sec">治理</div>
        <div className="nav">
          <button className={`item ${view === 'audit' ? 'sel' : ''}`} onClick={() => setView('audit')}>
            <span className="ico">≡</span>
            <span>
              <b>审计流水</b>
              <small>链校验 · 断链定位 · 取证</small>
            </span>
          </button>
          <button className={`item ${view === 'dash' ? 'sel' : ''}`} onClick={() => setView('dash')}>
            <span className="ico">▦</span>
            <span>
              <b>仪表盘</b>
              <small>计量 · 按模型 · turn 明细</small>
            </span>
          </button>
          <button className={`item ${view === 'security' ? 'sel' : ''}`} onClick={() => setView('security')}>
            <span className="ico">⛨</span>
            <span>
              <b>安全中心</b>
              <small>文件规则 · 备份 · 策略</small>
            </span>
          </button>
        </div>
        {view !== 'chat' && (
          <button className="btn" style={{ margin: '8px 10px' }} onClick={() => setView('chat')}>
            ← 返回会话
          </button>
        )}
      </aside>

      <main className="main">
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        {status && <div className="status">{status}</div>}

        {view === 'plugins' ? (
          <PluginsView selected={selected} />
        ) : view === 'mcp' ? (
          <McpView selected={selected} />
        ) : view === 'settings' ? (
          <SettingsView selected={selected} onEndpointChanged={() => setStatus('自定义端点已更新——新会话生效')} />
        ) : view === 'audit' ? (
          <AuditView selected={selected} sessions={sessions} />
        ) : view === 'dash' ? (
          <DashView selected={selected} />
        ) : view === 'security' ? (
          <SecurityView />
        ) : openId && selected ? (
          <section className="chat">
            <div className="chat-toolbar">
              <div style={{ position: 'relative' }}>
                <button className="pill" onClick={() => setShowPolicy((v) => !v)} title="会话授权策略（切换落链 session/policy）">
                  🛡 {policy === 'default' ? '默认安全' : policy === 'session' ? '会话内放行' : '只读模式'} ▾
                </button>
                {showPolicy && (
                  <div className="ctx-pop policy-menu">
                    {(
                      [
                        ['default', '默认安全', '规则外操作弹审批门 · 120s 超时默认拒绝'],
                        ['session', '会话内放行', '工具调用自动批准（拒绝红线仍先决）· 逐次 policy 落链'],
                        ['readonly', '只读模式', '写/删一律拒绝留痕 · 查询类照常（凭据目录询问档不削弱）'],
                      ] as const
                    ).map(([p, label, desc]) => (
                      <button key={p} className={`btn ${policy === p ? 'primary' : ''}`} onClick={() => void switchPolicy(p)}>
                        {label}
                        <small className="dim" style={{ display: 'block', fontWeight: 400 }}>
                          {desc}
                        </small>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <button className="pill" onClick={() => setShowParams((v) => !v)} title="模型参数（会话级——model/set 落链）">
                窗口：{windowSel ? Math.round(windowSel / 1000) + 'k · 手动' : '跟随元数据'} ▾
              </button>
              {showParams && (
                <div className="ctx-pop policy-menu">
                  <div className="mm-sec" style={{ fontSize: '.7rem', opacity: 0.6, padding: '0 0 6px' }}>上下文窗口声明（D-C5：无值不显示百分比，禁估算）</div>
                  {[
                    [null, '跟随元数据 / 端点声明'],
                    [32000, '32k · 手动'],
                    [64000, '64k · 手动'],
                    [128000, '128k · 手动'],
                    [256000, '256k · 手动'],
                  ].map(([v, label]) => (
                    <button key={String(v)} className={'btn' + (windowSel === v ? ' primary' : '')} onClick={() => { setWindowSel(v as number | null); setShowParams(false) }}>
                      {label as string}
                    </button>
                  ))}
                  <div className="dim" style={{ fontSize: '.68rem', padding: '6px 2px 0' }}>内置模型窗口取元数据表；自定义端点可手动声明。声明随 model/set 落链。</div>
                </div>
              )}
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
                <div className="ctx-title-row"><b>上下文容量</b><span className="mono">{contextWindow ? Math.round(((usage.lastInput ?? 0) + (usage.lastOutput ?? 0)) / contextWindow * 100) + '%' : '—'}</span></div>
                <div className="ctx-segbar"><i style={{ width: contextWindow ? Math.min(100, ((usage.lastInput ?? 0) + (usage.lastOutput ?? 0)) / contextWindow * 100) + '%' : '0%', background: contextWindow && ((usage.lastInput ?? 0) + (usage.lastOutput ?? 0)) / contextWindow > 0.92 ? 'var(--danger, #d24949)' : contextWindow && ((usage.lastInput ?? 0) + (usage.lastOutput ?? 0)) / contextWindow > 0.78 ? 'var(--warn, #b97d10)' : 'var(--accent, #5e6ad2)' }} /></div>
                <div className="cp-row"><span>最近请求占用{contextWindow ? '（窗口 ' + Math.round(contextWindow / 1000) + 'k · 紧急阈值 78%）' : '（窗口未声明——百分比不显示，D-C5）'}</span><b>{fmtTok((usage.lastInput ?? 0) + (usage.lastOutput ?? 0))}</b></div>
                <div className="cp-row"><span>平均缓存命中率</span><b>{usage.input + usage.cacheRead > 0 ? Math.round(usage.cacheRead / (usage.input + usage.cacheRead) * 100) + '%' : '—'}</b></div>
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
              选择/新建会话开始。S3 能力：chat 事件级流式 · M3 授权门三档（120s 超时默认拒绝）·
              文件安全规则（安全中心）· 自动备份 · 会话策略三档 · 审计流水（链校验/取证导出）·
              计量仪表盘 · 跨运行续写。
            </p>
          </section>
        )}
      </main>
    </div>
  )
}
