import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AuthzPendingPush,
  AuthzResolvedPush,
  HostProbeResult,
  ModelMetaDTO,
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
 * S5：布局对齐原型 v0.5——左栏三段式（导航/列表/底部）+ 输入区右下聚类
 * [上下文圆环][模型][发送] + 模型菜单（搜索/分组/✓/★默认）+ 模型池状态与降级横幅（fail-visible）。
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

/** S5（D-S5-4）：模型清单项——分组呈现（内置元数据表 / 池端点） */
interface ModelOption {
  id: string
  group: string
  contextWindow: number | null
  thinking: 'none' | 'model-level' | null
}

/** 池降级事件（routing/decide——fail-visible 横幅数据源） */
interface RoutingEvent {
  seq: number
  selected: string | null
  reason: string
  retries: number
}

function buildChatItems(events: SessionEventDTO[]): { items: ChatItem[]; routing: RoutingEvent[] } {
  const items: ChatItem[] = []
  const cards = new Map<string, ToolCard>()
  const routing: RoutingEvent[] = []
  for (const e of events) {
    const payload = e.payload
    const p = (payload ?? {}) as Record<string, unknown>
    if (e.kind === 'user') {
      items.push({ kind: 'msg', role: 'user', text: String(payload ?? '') })
    } else if (e.kind === 'assistant') {
      items.push({ kind: 'msg', role: 'agent', text: String(payload ?? '') })
    } else if (e.kind === 'routing') {
      // S5（D-S5-1）：模型池路由决策——降级 fail-visible（禁静默换模型）
      routing.push({ seq: e.seq, selected: p['selected'] as string | null, reason: String(p['reason'] ?? '?'), retries: Number(p['retries'] ?? 0) })
      if (p['reason'] === 'fallback' || p['reason'] === 'exhausted') {
        items.push({
          kind: 'line',
          tone: 'warn',
          text:
            p['reason'] === 'exhausted'
              ? `模型池全部候选不可用（重试 ${String(p['retries'] ?? 0)} 次）——本轮已停止`
              : `模型池降级 → ${String(p['selected'] ?? '?')}（fallback · 重试 ${String(p['retries'] ?? 0)}——routing/decide 已落链）`,
        })
      }
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
      } else if (p['error'] === 'authorization-denied') {
        card.error = '授权拒绝（authorization-denied）'
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
      else if (type === 'compact') items.push({ kind: 'line', tone: 'dim', text: `历史已压缩（context/compact 已落链，seq=${String(e.seq)}）` })
    }
    // kind usage：turnEnd 摘要已覆盖，不重复渲染
  }
  return { items, routing }
}

/** S5（D-S5-4）：★ 默认模型 = localStorage 端侧偏好（不落审计链） */
const DEFAULT_MODEL_KEY = 'car-desktop.defaultModel'
function readDefaultModel(): string | null {
  try { return localStorage.getItem(DEFAULT_MODEL_KEY) } catch { return null }
}
function writeDefaultModel(m: string | null): void {
  try {
    if (m == null) localStorage.removeItem(DEFAULT_MODEL_KEY)
    else localStorage.setItem(DEFAULT_MODEL_KEY, m)
  } catch { /* 存储不可用 = 端侧偏好降级，不阻塞 */ }
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
  const [meta, setMeta] = useState<Record<string, ModelMetaDTO>>({})
  const [poolMembers, setPoolMembers] = useState<Array<{ id: string; baseUrl: string; model: string; adapterId: string }>>([])
  const [defaultModel, setDefaultModelState] = useState<string | null>(() => readDefaultModel())
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
  const [showModelMenu, setShowModelMenu] = useState(false)
  const [modelSearch, setModelSearch] = useState('')
  const [view, setView] = useState<'chat' | 'audit' | 'dash' | 'security' | 'plugins' | 'mcp' | 'settings'>('chat')
  const [policy, setPolicy] = useState<SessionPolicyDTO>('default')
  const [showPolicy, setShowPolicy] = useState(false)
  const [windowSel, setWindowSel] = useState<number | null>(null) // S4-S3 受控版：null = 跟随元数据/端点
  const [contextWindow, setContextWindow] = useState<number | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const openRef = useRef<{ wsId: string; sessionId: string } | null>(null)

  const fail = useCallback((e: unknown) => setError(e instanceof Error ? e.message : String(e)), [])

  const setDefaultModel = useCallback((m: string | null) => {
    setDefaultModelState(m)
    writeDefaultModel(m)
  }, [])

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
    // S5（D-S5-4）：模型菜单数据面（内置元数据表——池端点随会话装配另取）
    window.car
      .modelsMeta()
      .then((r) => setMeta(r.meta))
      .catch(() => setMeta({}))
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
      // S5（D-S5-3）：会话级思考档位 = 链上最近一次 model/set 的 reasoning 键
      const reEvent = [...r.events].reverse().find((e) => e.kind === 'system' && (e.payload as Record<string, unknown>)['type'] === 'model/set' && typeof (e.payload as Record<string, unknown>)['reasoning'] === 'string')
      setSessionReasoning(reEvent ? ((reEvent.payload as Record<string, unknown>)['reasoning'] as 'off' | 'low' | 'medium' | 'high') : null)
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
        // S5（D-S5-4）：新建会话默认应用 ★ 模型（偏好本身不落链；应用为会话级 model/set 落链可解释）
        const target = defaultModel
        if (target && openRef.current) {
          try {
            await window.car.setSessionModel(openRef.current.wsId, openRef.current.sessionId, target, undefined, sessionReasoning ?? undefined)
            setSessionModel(target)
          } catch { /* 默认模型不可用 = 保留装配锚点，不阻塞 */ }
        }
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

  const [sessionReasoning, setSessionReasoning] = useState<'off' | 'low' | 'medium' | 'high' | null>(null)

  const switchModel = async (m: string) => {
    if (!selected || !openId || !m.trim()) return
    try {
      await window.car.setSessionModel(selected.id, openId, m.trim(), windowSel ?? undefined, sessionReasoning ?? undefined)
      setSessionModel(m.trim())
      if (windowSel) setContextWindow(windowSel)
      setShowModelMenu(false)
      setModelSearch('')
    } catch (e) {
      fail(e)
    }
  }

  const switchReasoning = async (e: 'off' | 'low' | 'medium' | 'high') => {
    if (!selected || !openId) return
    try {
      await window.car.setSessionModel(selected.id, openId, sessionModel ?? '', windowSel ?? undefined, e)
      setSessionReasoning(e)
      setStatus(`思考程度 → ${e === 'off' ? '关（不下发 reasoning_effort）' : e}（model/set 已落链）`)
    } catch (err) {
      fail(err)
    }
  }

  const compactSession = async () => {
    if (!selected || !openId) return
    setError(null)
    try {
      const r = await window.car.compactNow(selected.id, openId)
      setStatus(`历史已压缩：seq=${r.seq}，折叠 ${r.compactedEvents} 条事件（context/compact 已落链）`)
      void window.car.sessionUsage(selected.id, openId).then(setUsage).catch(fail)
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
  const { items, routing } = buildChatItems(events)
  // S5（D-S5-1）：最近的池降级/耗尽事件 → 顶部横幅（fail-visible，禁静默换模型）
  const lastRouting = routing.at(-1) ?? null
  const showRoutingBanner = lastRouting != null && (lastRouting.reason === 'fallback' || lastRouting.reason === 'exhausted')
  // S5（D-S5-4）：模型菜单数据面 = 内置元数据表 + 池端点，搜索过滤
  const builtinOptions: ModelOption[] = Object.entries(meta).map(([id, m]) => ({
    id,
    group: '内置模型',
    contextWindow: m.contextWindow,
    thinking: m.thinking,
  }))
  const poolOptions: ModelOption[] = poolMembers.map((m) => ({ id: m.model, group: `池端点 ${m.id}`, contextWindow: null, thinking: null }))
  const seenModels = new Set<string>()
  const allOptions = [...poolOptions, ...builtinOptions].filter((o) => {
    if (seenModels.has(o.id)) return false
    seenModels.add(o.id)
    return modelSearch.trim() ? o.id.toLowerCase().includes(modelSearch.trim().toLowerCase()) : true
  })
  const groups = [...new Set(allOptions.map((o) => o.group))]
  const lastUsed = (usage?.lastInput ?? 0) + (usage?.lastOutput ?? 0)
  const pct = contextWindow ? Math.min(100, (lastUsed / contextWindow) * 100) : null
  const pctColor = pct == null ? 'var(--accent, #5e6ad2)' : pct > 92 ? 'var(--danger, #d24949)' : pct > 78 ? 'var(--warn, #b97d10)' : 'var(--accent, #5e6ad2)'

  return (
    <div className="app">
      <aside className="sidebar">
        {/* ── 段一：视图导航 ─────────────────────────────── */}
        <div className="brand">
          <span className="logo">◈</span>
          <b>CAR Desktop</b>
        </div>
        <div className="sec">运行</div>
        <button className={`item ${view === 'plugins' ? 'sel' : ''}`} onClick={() => setView('plugins')}><span className="ico">⧉</span><span><b>插件</b><small>装载报告 · 工具清单</small></span></button>
        <button className={`item ${view === 'mcp' ? 'sel' : ''}`} onClick={() => setView('mcp')}><span className="ico">⇄</span><span><b>MCP 服务</b><small>双传输 · 工具过授权门</small></span></button>
        <div className="sec">治理</div>
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
        <button className={`item ${view === 'settings' ? 'sel' : ''}`} onClick={() => setView('settings')}><span className="ico">◐</span><span><b>设置 / 诊断</b><small>doctor · 自定义端点</small></span></button>

        {/* ── 段二：工作区/会话列表 ───────────────────────── */}
        <div className="sec">
          工作区
          <button className="mini" onClick={() => void pickWorkspace()}>
            ＋ 注册
          </button>
        </div>
        <div className="list">
          {workspaces.length === 0 && <div className="empty">尚未注册工作区</div>}
          {workspaces.map((w) => (
            <button key={w.id} className={`item ${selected?.id === w.id ? 'sel' : ''}`} onClick={() => void selectWorkspace(w)} title={w.path}>
              <span className="ico">◆</span>
              <span>
                <b>{w.name}</b>
                <small>{w.configPath ? 'config 已装载' : '无 car.config'}</small>
              </span>
            </button>
          ))}
        </div>
        <div className="manual">
          <input
            placeholder="按绝对路径注册…"
            value={manualPath}
            onChange={(e) => setManualPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && manualPath.trim()) void addByPath()
            }}
          />
        </div>
        <div className="sec">
          会话
          <button className="mini" disabled={!selected} onClick={() => void newSession()}>
            ＋ 新建
          </button>
        </div>
        <div className="list grow">
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

        {/* ── 段三：底部 ─────────────────────────────────── */}
        <div className="side-foot">
          {view !== 'chat' && (
            <button className="btn" onClick={() => setView('chat')}>
              ← 返回会话
            </button>
          )}
          <div className="foot">事件级流式 · 与审计 JSONL 同源同序</div>
        </div>
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
              {showRoutingBanner && lastRouting && (
                <div className={`routing-banner ${lastRouting.reason === 'exhausted' ? 'danger' : ''}`} role="status">
                  {lastRouting.reason === 'exhausted'
                    ? `⚠ 模型池全部候选不可用（重试 ${lastRouting.retries} 次）——已按序降级尝试，fail-visible 落链`
                    : `⚠ 模型池降级 → ${lastRouting.selected}（fallback · 重试 ${lastRouting.retries}——routing/decide 已落链）`}
                </div>
              )}
              {busy && <span className="live">● turn 进行中</span>}
            </div>
            {showCtx && usage && (
              <div className="ctx-pop ctx-up">
                <div className="ctx-title-row"><b>上下文容量</b><span className="mono">{pct != null ? Math.round(pct) + '%' : '—'}</span></div>
                <div className="ctx-segbar"><i style={{ width: (pct ?? 0) + '%', background: pctColor }} /></div>
                {usage.segments && (
                  <div className="cp-row"><span>思考输出（reasoning_tokens，provider 真实细分）</span><b>{fmtTok(usage.segments.reasoningTokens)}</b></div>
                )}
                <div className="cp-row"><span>最近请求占用{contextWindow ? `（窗口 ${Math.round(contextWindow / 1000)}k · 紧急阈值 78%）` : '（窗口未声明——百分比不显示，D-C5）'}</span><b>{fmtTok(lastUsed)}</b></div>
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
            {/* ── S5：输入区右下聚类 [上下文圆环][模型][发送]（原型 v0.5 同构，弹层向上） ── */}
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
              <div className="input-cluster">
                <div className="cluster-item" style={{ position: 'relative' }}>
                  <button className="ctx-ring" onClick={() => setShowCtx((v) => !v)} title="上下文容量">
                    <svg viewBox="0 0 36 36" width="30" height="30">
                      <circle cx="18" cy="18" r="15.5" fill="none" stroke="var(--line, #2a2f3a)" strokeWidth="3.5" />
                      {pct != null && (
                        <circle
                          cx="18"
                          cy="18"
                          r="15.5"
                          fill="none"
                          stroke={pctColor}
                          strokeWidth="3.5"
                          strokeLinecap="round"
                          strokeDasharray={`${(pct / 100) * 97.4} 97.4`}
                          transform="rotate(-90 18 18)"
                        />
                      )}
                    </svg>
                  </button>
                </div>
                <div className="cluster-item" style={{ position: 'relative' }}>
                  <button className="pill" onClick={() => setShowModelMenu((v) => !v)} title="模型选择与参数（会话级，model/set 落链）">
                    {sessionModel ?? '未配置'} ▾
                  </button>
                  {showModelMenu && (
                    <div className="ctx-pop model-menu ctx-up">
                      <input
                        className="mm-search"
                        placeholder="搜索模型…"
                        value={modelSearch}
                        autoFocus
                        onChange={(e) => setModelSearch(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && allOptions.length > 0) void switchModel(allOptions[0]!.id)
                          if (e.key === 'Escape') setShowModelMenu(false)
                        }}
                      />
                      {defaultModel && <div className="mm-default">★ 默认：{defaultModel}（端侧偏好，不落链）</div>}
                      {groups.map((g) => (
                        <div key={g} className="mm-group">
                          <div className="mm-sec">{g}</div>
                          {allOptions
                            .filter((o) => o.group === g)
                            .map((o) => (
                              <button key={o.id} className={`mm-item${sessionModel === o.id ? ' sel' : ''}`} onClick={() => void switchModel(o.id)}>
                                <span className="mm-check">{sessionModel === o.id ? '✓' : ''}</span>
                                <span className="mm-name">
                                  {defaultModel === o.id ? '★ ' : ''}
                                  {o.id}
                                </span>
                                <small className="dim">
                                  {o.contextWindow ? Math.round(o.contextWindow / 1000) + 'k' : ''}
                                  {o.thinking === 'model-level' ? ' · 思考绑定模型' : o.thinking === 'none' ? ' · 非思考档' : ''}
                                </small>
                              </button>
                            ))}
                        </div>
                      ))}
                      {allOptions.length === 0 && <div className="empty">无匹配模型</div>}
                      <div className="mm-sec" style={{ borderTop: '1px solid var(--line, #2a2f3a)', marginTop: 6, paddingTop: 8 }}>思考程度（reasoning_effort，关 = 不下发）</div>
                      <div className="mm-row">
                        {(['off', 'low', 'medium', 'high'] as const).map((e) => (
                          <button key={e} className={'btn' + (sessionReasoning === e ? ' primary' : '')} onClick={() => void switchReasoning(e)}>
                            {e === 'off' ? '关' : e}
                          </button>
                        ))}
                      </div>
                      <div className="mm-sec">上下文窗口声明（D-C5：无值不显示百分比）</div>
                      <div className="mm-row">
                        {(
                          [
                            [null, '跟随'],
                            [32000, '32k'],
                            [64000, '64k'],
                            [128000, '128k'],
                            [256000, '256k'],
                          ] as const
                        ).map(([v, label]) => (
                          <button
                            key={String(v)}
                            className={'btn' + (windowSel === v ? ' primary' : '')}
                            onClick={() => {
                              setWindowSel(v as number | null)
                              if (selected && openId && sessionModel) void window.car.setSessionModel(selected.id, openId, sessionModel, v as number | undefined, sessionReasoning ?? undefined)
                              if (v != null) setContextWindow(v as number)
                            }}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                      <div className="mm-sec">自动压缩（阈值在 car.config llm.compaction；缺省关）</div>
                      <button className="btn" onClick={() => void compactSession()}>立即压缩（context/compact 落链）</button>
                    </div>
                  )}
                </div>
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
            </div>
          </section>
        ) : (
          <section className="card">
            <h2>会话主旅程</h2>
            <p className="dim">
              选择/新建会话开始。S5 能力：chat 事件级流式 · M3 授权门三档（120s 超时默认拒绝）·
              模型菜单（搜索/分组/★默认）· 思考程度（reasoning_effort）· 模型池（降级 fail-visible）·
              立即压缩（context/compact 落链）· 文件安全规则 · 自动备份 · 会话策略三档 ·
              审计流水 · 计量仪表盘 · 跨运行续写。
            </p>
          </section>
        )}
      </main>
    </div>
  )
}
