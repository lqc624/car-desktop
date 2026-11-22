import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AuthzPendingPush,
  AuthzResolvedPush,
  BashOutputResultDTO,
  HostProbeResult,
  ModelMetaDTO,
  AttachmentRowDTO,
  BrowserHitlPush,
  CapabilityEntryDTO,
  SessionDeltaPush,
  SessionEventDTO,
  SessionEventPush,
  SessionInfo,
  SessionPolicyDTO,
  SessionUsageResult,
  UpdateStatusPush,
  WorkspaceInfo,
} from '../shared/ipc-contract'
import { ABORTED_AT_LABEL, failureKindLabel } from '../shared/failure-kinds'
import { settlementRow, type SettlementLite } from '../shared/settlement-rows'
import { browserRow } from '../shared/browser-rows'
import { AuditView } from './views/AuditView'
import { CapabilityView } from './views/CapabilityView'
import { DashView } from './views/DashView'
import { McpView } from './views/McpView'
import { MemoryView } from './views/MemoryView'
import { PersonalizationView } from './views/PersonalizationView'
import { RepoWikiView } from './views/RepoWikiView'
import { DeployView } from './views/DeployView'
import { PluginsView } from './views/PluginsView'
import { SecurityView } from './views/SecurityView'
import { SettingsView } from './views/SettingsView'
import { FileViewer, type ViewerTarget } from './FileViewer'
import { LineagePanel } from './LineagePanel'
import { forkPointFromEvents, type ForkPoint } from './lineage'
import { resolveViewerPath } from '../shared/file-preview'
import { taskRowsFrom, formatDuration, type TaskRow } from './task-rows'

/**
 * S2 会话主旅程（渲染薄皮，逻辑下沉宿主——D-S2-1 事件级流式：屏幕上每个字都来自
 * 落链事件；1.19.0 起生成中的临时增量除外——内核脱敏后的流式渲染提示，assistant
 * 事件到达即收口清零，收敛后仍以落链事件为唯一事实源）。授权 120s 倒计时仅展示口径，
 * 超时判定真值在内核——D-S2-5）。
 * 错误呈现纪律：任何 Promise 拒绝落红条全文展示（fail-visible，禁静默吞错）。
 * S5：布局对齐原型 v0.5——左栏三段式（导航/列表/底部）+ 输入区右下聚类
 * [上下文圆环][模型][发送] + 模型菜单（搜索/分组/✓/★默认）+ 模型池状态与降级横幅（fail-visible）。
 */

/** 1.19.0：流式增量缓冲（按 turn 归组——assistant/turnEnd 事件到达即清零该 turn） */
/** v0.9.0：StreamBuf/applyStreamDelta/thinkingRowsFrom 迁纯函数模块（stream-thinking——可测面） */
import { applyStreamDelta, thinkingRowsFrom, type StreamBuf } from './stream-thinking'

interface ToolCard {
  callId: string
  tool: string
  argsPreview: string
  /** T-FV：fs_* 工具的原始 path 参数（可点开文件查看器——相对路径由调用方按工作区 root 解析） */
  argsPath?: string
  authz: 'granted' | 'denied' | null
  result: string | null
  error: string | null
}

/** T-FV：内置文件三工具（toolcard 目标路径可点开查看器的工具面） */
const FS_TOOLS = new Set(['fs_read', 'fs_write', 'fs_delete'])

type ChatItem =
  | { kind: 'msg'; role: 'user' | 'agent'; text: string; pending?: boolean; seq?: number }
  | { kind: 'tool'; card: ToolCard }
  | { kind: 'line'; tone: 'dim' | 'ok' | 'warn'; text: string; subagentLink?: string; auditJump?: true }

const fmtTok = (n: number | null): string =>
  n == null ? '—' : n >= 10000 ? (n / 1000).toFixed(1) + 'k' : String(n)

/** T-FV：叙事行只显文件名（路径值不打印——路径本体在链上 payload，屏面留痕同原型 sys-note 口径） */
const baseNameOf = (p: string): string => p.split(/[\\/]/).pop() || p

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

/** T-24：当轮活跃能力引用集（引用态扫描——与宿主 session-handle 同口径：add/remove 链序收敛） */
function activeCapabilityRefs(events: SessionEventDTO[]): string[] {
  const state = new Map<string, boolean>()
  for (const e of events) {
    if (e.kind !== 'system') continue
    const m = e.meta as Record<string, unknown> | null
    if (!m || m['injection'] !== 'capability') continue
    if (m['op'] !== 'add' && m['op'] !== 'remove') continue
    state.set(String(m['refId']), m['op'] === 'add')
  }
  return [...state.entries()].filter(([, on]) => on).map(([id]) => id)
}

/** @提及引用触发形态：输入以 @query 结尾（query 允许空——刚敲下 @ 即弹菜单） */
const MENTION_RE = /@([a-zA-Z0-9_-]*)$/

/** T-25：会话附件态（file/attach + file/attach-remove 链序收敛——与宿主同口径） */
function activeAttachments(events: SessionEventDTO[]): AttachmentRowDTO[] {
  const state = new Map<string, AttachmentRowDTO>()
  for (const e of events) {
    if (e.kind !== 'system') continue
    const p = e.payload as Record<string, unknown> | null
    if (!p) continue
    if (p['type'] === 'file/attach') {
      state.set(String(p['path']), {
        path: String(p['path']),
        mode: p['mode'] === 'fulltext' ? 'fulltext' : 'path-ref',
        size: Number(p['size'] ?? 0),
        mime: String(p['mime'] ?? ''),
      })
    } else if (p['type'] === 'file/attach-remove') {
      state.delete(String(p['path']))
    }
  }
  return [...state.values()]
}

function buildChatItems(events: SessionEventDTO[], busy = false): { items: ChatItem[]; routing: RoutingEvent[] } {
  const items: ChatItem[] = []
  const cards = new Map<string, ToolCard>()
  const routing: RoutingEvent[] = []
  // S6（D-S6-6）：待执行判定 = user 事件其 turnId 无 turnEnd（引导排队消息——turnEnd 到达即消隐）
  const closed = new Set(events.filter((e) => e.kind === 'turnEnd').map((e) => e.turnId))
  const pendingTurnIds = new Set(
    events
      .filter((e) => e.kind === 'user' && !closed.has(e.turnId) && /^T\d+$/.test(e.turnId))
      .map((e) => e.turnId),
  )
  // 执行中的 turn 不是「排队」：busy 时 seq 最靠前的未闭合 turn = 正在跑，其消息不挂待执行徽标
  // （徽标语义 = 引导排队；此前 T1 自身也挂徽标，S6 终验③ 实测量到 3 条而非 2 条）
  const runningTurnId = busy ? [...pendingTurnIds][0] : undefined
  // v0.9.0（D-SD4）：thinking 叙事 chip——同 turn 聚合（内核一块一事件）；主面零原文（D-C1），
  // chip 只显计数，点击跳审计页看原文
  const thinkRowByFirstSeq = new Map(thinkingRowsFrom(events).map((r) => [r.firstSeq, r]))
  for (const e of events) {
    const payload = e.payload
    const p = (payload ?? {}) as Record<string, unknown>
    if (e.kind === 'user') {
      // 0.13.0（Z-1 / D-Z13-3）：user 行携带链 seq（fork 入口绑定链 seq 非显示序——R-3 防错位）
      items.push({ kind: 'msg', role: 'user', text: String(payload ?? ''), pending: (pendingTurnIds.has(e.turnId) && e.turnId !== runningTurnId) || undefined, seq: e.seq })
    } else if (e.kind === 'assistant') {
      items.push({ kind: 'msg', role: 'agent', text: String(payload ?? '') })
    } else if (e.kind === 'thinking') {
      const row = thinkRowByFirstSeq.get(e.seq)
      if (row) items.push({ kind: 'line', tone: 'dim', text: `已思考 ~${row.chars} 字 · ${row.blocks} 块（原文审计可见）`, auditJump: true })
      // 非 firstSeq 的 thinking 事件 = 同 turn 后续块（chip 已聚合计数）——零行
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
      const tool = String(p['tool'] ?? '?')
      const rawArgs = p['args'] as Record<string, unknown> | null | undefined
      const rawPath = rawArgs?.['path']
      const card: ToolCard = {
        callId,
        tool,
        argsPreview: argsPreview(p['args']),
        ...(FS_TOOLS.has(tool) && typeof rawPath === 'string' ? { argsPath: rawPath } : {}),
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
      // C2（W-1c）：失败细类消费——turnEnd meta.kind 九类中文标签 + 处置动作；abortedAt 取消时机；
      // kind 缺失 = 1.22 旧事件（不带键，回退原文 reason——向后兼容）
      const reason = String(meta['reason'] ?? '?')
      const kindLabel = failureKindLabel(typeof meta['kind'] === 'string' ? (meta['kind'] as string) : null)
      const abortedLabel = ABORTED_AT_LABEL[String(meta['abortedAt'] ?? '')] ?? null
      const isError = reason === 'error'
      const kindSuffix = kindLabel ? ` · 失败细类：${kindLabel}` : typeof meta['kind'] === 'string' ? ` · 失败细类：${String(meta['kind'])}（未知类别——原样呈现）` : ''
      const abortSuffix = abortedLabel ? ` · ${abortedLabel}` : ''
      items.push({
        kind: 'line',
        tone: isError ? 'warn' : 'dim',
        text:
          `turn 收口：${reason}${abortSuffix}${kindSuffix}` +
          (u ? ` · 用量 in ${fmtTok(u['input'] ?? null)} / out ${fmtTok(u['output'] ?? null)} / 缓存读 ${fmtTok(u['cacheRead'] ?? null)}` : ' · 用量未采集'),
      })
    } else if (e.kind === 'system') {
      const type = String(p['type'] ?? '')
      // S6（D-S6-5 / D-C3 转真值）：记忆注入行——meta.injection==='memory'（宿主装配层落链）
      const meta = (e.meta ?? {}) as Record<string, unknown>
      if (meta['injection'] === 'memory') {
        items.push({ kind: 'line', tone: 'dim', text: `记忆注入 ${String(meta['count'] ?? '?')} 条（${String(meta['chars'] ?? '?')} 字符——loadMemoryForInjection 确定性拼装）` })
        continue
      }
      // T-MP：个性化指令注入行（快照随会话——压缩重注即新事件）
      if (meta['injection'] === 'persona') {
        const ts = String(meta['toneStyle'] ?? '')
        items.push({ kind: 'line', tone: 'dim', text: `回复风格已应用${ts && ts !== 'default' ? `：${ts}` : ''}（persona 注入落链 · ${String(meta['chars'] ?? '?')} 字符——新会话快照，压缩后重注）` })
        continue
      }
      if (type === 'session-start') items.push({ kind: 'line', tone: 'dim', text: '会话已创建（session-start 已落链）' })
      else if (type === 'model/set') items.push({ kind: 'line', tone: 'dim', text: `模型切换 → ${String(p['model'] ?? '?')}（model/set 已落链）` })
      else if (type === 'session/rename') items.push({ kind: 'line', tone: 'dim', text: `会话重命名 → ${String(p['title'] ?? '?')}` })
      else if (type === 'session/policy') items.push({ kind: 'line', tone: 'dim', text: `会话策略 → ${String(p['policy'] ?? '?')}（session/policy 已落链）` })
      // T-FV：文件查看器动作留痕（file/preview / file/open——屏面只显文件名，路径值不打印）
      else if (type === 'file/preview') items.push({ kind: 'line', tone: 'dim', text: `已打开预览 ${baseNameOf(String(p['path'] ?? '?'))}（file/preview 已落链 · 路径值不打印）` })
      else if (type === 'file/open')
        items.push({
          kind: 'line',
          tone: 'dim',
          text: `已用${String(p['how'] ?? 'system') === 'browser' ? '浏览器' : '系统程序'}打开 ${baseNameOf(String(p['path'] ?? '?'))}（file/open 已落链 · 路径值不打印）`,
        })
      // T-ME：记忆进化叙事行（run/apply/reject/failed——candidates 明细在记忆页复核区，屏面只留痕）
      else if (type === 'memory/evolution') {
        const n = Array.isArray(p['candidates']) ? (p['candidates'] as unknown[]).length : 0
        const u = p['usage'] as Record<string, number> | undefined
        items.push({
          kind: 'line',
          tone: 'dim',
          text: `记忆进化运行 ${String(p['runId'] ?? '?')} · 候选 ${n} 条（${p['auto'] === true ? '自动' : '手动'} · 压力 ${String((p['pressure'] as Record<string, number> | undefined)?.['pct'] ?? '?')}%${u ? ` · usage in ${u['input']}/out ${u['output']}` : ''}——memory/evolution 落链）`,
        })
      } else if (type === 'memory/evolution-apply') {
        items.push({ kind: 'line', tone: 'ok', text: `进化候选 ${String(p['cid'] ?? '?')} 已写入（${String(p['op'] ?? '?')}${p['memoryId'] ? ` → ${String(p['memoryId'])}` : ''}）——memory/evolution-apply 落链` })
      } else if (type === 'memory/evolution-reject') {
        items.push({
          kind: 'line',
          tone: 'dim',
          text: `进化候选 ${String(p['cid'] ?? '?')} 已放弃（${String(p['op'] ?? '?')}${p['reason'] === 'review-timeout' ? ' · 复核超时默认放弃' : p['feedback'] ? ' · feedback 留痕' : ''}）`,
        })
      } else if (type === 'memory/evolution-failed') {
        items.push({ kind: 'line', tone: 'warn', text: `自动进化失败：${String(p['reason'] ?? '?')}` })
      }
      else if (type === 'compact') items.push({ kind: 'line', tone: 'dim', text: `历史已压缩（context/compact 已落链，seq=${String(e.seq)}）` })
      // K2（1.16 子 Agent）：编排叙事行（复用 system 叙事渲染——零新 IPC）
      // v0.4（T-29）：subagentLink = 子链审计跳转（子链文件 = {sessionsDir}/{subagentId}.jsonl，审计页可开）
      else if (type === 'subagent/spawn') {
        items.push({ kind: 'line', tone: 'ok', text: `子 Agent 派生 · ${String(p['subagentId'] ?? '?')}（任务：${String(p['task'] ?? '').slice(0, 60)}——subagent/spawn 已落链）`, subagentLink: String(p['subagentId'] ?? '') || undefined })
      } else if (type === 'subagent/join') {
        items.push({ kind: 'line', tone: 'ok', text: `子 Agent 汇合 · ${String(p['subagentId'] ?? '?')}（reason=${String(p['reason'] ?? '?')} · 摘要 ${String(p['summaryChars'] ?? '?')} 字符——子链 assistant 流即全文）`, subagentLink: String(p['subagentId'] ?? '') || undefined })
      } else if (type === 'subagent/kill') {
        items.push({ kind: 'line', tone: 'warn', text: `子 Agent 终止 · ${String(p['subagentId'] ?? '?')}（subagent/kill 已落链）`, subagentLink: String(p['subagentId'] ?? '') || undefined })
      }
      // 1.24-W2（D-B2-9）：回合结算行——hasUnknownOutcomes 显式 warn = fail-visible（方案 B 终验项）
      else if (type === 'settlement') {
        const row = settlementRow(p as unknown as SettlementLite)
        items.push({ kind: 'line', tone: row.tone, text: row.text })
      }
      // C3-B2（D-B2-8）：browser/* 叙事主面分支（B-1 仅审计页可见的缺口补齐；行面零页面内容）
      else {
        const row = browserRow(type, p)
        if (row) items.push({ kind: 'line', tone: row.tone, text: row.text })
      }
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

/** T-MP：显示文件修改过程（渲染显示偏好——fs_write/fs_delete 工具卡显隐；全局键，端侧不落链） */
const SHOW_FS_CARDS_KEY = 'car-desktop.showFsCards'
function readShowFsCards(): boolean {
  try { return localStorage.getItem(SHOW_FS_CARDS_KEY) !== '0' } catch { return true }
}

/** T-FV-2：状态面板展开策略（auto=有任务运行时自动展开 / always / collapsed——端侧偏好不落审计链） */
const TASK_PANEL_KEY = 'car-desktop.taskPanel'
type TaskPanelPolicy = 'auto' | 'always' | 'collapsed'
const TASK_PANEL_LABEL: Record<TaskPanelPolicy, string> = { auto: '自动展开', always: '始终展开', collapsed: '始终收起' }
function readTaskPanelPolicy(): TaskPanelPolicy {
  try {
    const v = localStorage.getItem(TASK_PANEL_KEY)
    return v === 'always' || v === 'collapsed' ? v : 'auto'
  } catch { return 'auto' }
}
function writeTaskPanelPolicy(p: TaskPanelPolicy): void {
  try { localStorage.setItem(TASK_PANEL_KEY, p) } catch { /* 存储不可用 = 端侧偏好降级，不阻塞 */ }
}

// K5-F：退役 K5-E 自由模型清单（模型归属端点 URL——设置面板模型列表维护）；挂载时清理遗留键
function clearLegacyCustomModels(): void {
  try { localStorage.removeItem('car-desktop.customModels') } catch { /* 存储不可用 = 无遗留可清 */ }
}

/** v0.3-R1：工作区分组展开态（端侧偏好，不落链）——null = 从未设置（默认全展开） */
const EXPANDED_WS_KEY = 'car-desktop.expandedWs'
function readExpandedWs(): string[] | null {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(EXPANDED_WS_KEY) ?? 'null')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null
  } catch { return null }
}
function writeExpandedWs(ids: string[]): void {
  try { localStorage.setItem(EXPANDED_WS_KEY, JSON.stringify(ids)) } catch { /* 存储不可用 = 端侧偏好降级，不阻塞 */ }
}

export function App() {
  const [probe, setProbe] = useState<HostProbeResult | null>(null)
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([])
  // v0.3-R1：会话按工作区分桶（侧栏工作区为分组头，展开后各自嵌套展示——跨工作区并行可见）
  const [sessionsByWs, setSessionsByWs] = useState<Record<string, SessionInfo[]>>({})
  // v0.3-R1：工作区分组展开态（端侧偏好持久化——null = 从未设置，默认全展开）
  const [expandedWs, setExpandedWs] = useState<string[] | null>(() => readExpandedWs())
  const [selected, setSelected] = useState<WorkspaceInfo | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [events, setEvents] = useState<SessionEventDTO[]>([])
  const [usage, setUsage] = useState<SessionUsageResult | null>(null)
  const [sessionModel, setSessionModel] = useState<string | null>(null)
  const [meta, setMeta] = useState<Record<string, ModelMetaDTO>>({})
  const [poolMembers, setPoolMembers] = useState<Array<{ id: string; baseUrl: string; model: string; adapterId: string }>>([])
  // K5-D-R2：端点面（models:meta endpoint——模型菜单「自定义端点」组 + 窗口声明随选带入）
  const [endpointMeta, setEndpointMeta] = useState<{ baseUrl: string; adapterId: string; models: Array<{ id: string; contextWindow: number | null }> } | null>(null)
  const [defaultModel, setDefaultModelState] = useState<string | null>(() => readDefaultModel())
  // R-K2-1：授权 pending 改队列（K2 并发子 Agent——多请求并发在途，单槽会顶掉先到的弹窗，
  // 用户只见最新一条、其余静默等超时默认拒；队列化后各弹窗独立倒计时、按 requestId 应答）
  const [pendings, setPendings] = useState<AuthzPendingPush[]>([])
  // 0.12.0（D-V12-3）：同意面结构化——批量勾选集 + 逐卡附注 + 批量共享附注（≤500 字符，内核 1.25.1 落链）
  const [authzSel, setAuthzSel] = useState<Set<string>>(new Set())
  const [authzNotes, setAuthzNotes] = useState<Record<string, string>>({})
  const [authzBatchNote, setAuthzBatchNote] = useState('')
  const [nowTick, setNowTick] = useState(() => Date.now())
  const [update, setUpdate] = useState<UpdateStatusPush | null>(null)
  /** B-2（D-B2-4）：HITL 接管卡（detect 建 / resolved/timeout/aborted 收——受控窗口人工完成语义） */
  const [hitl, setHitl] = useState<BrowserHitlPush | null>(null)
  const [busy, setBusy] = useState(false)
  // 1.19.0：流式增量缓冲（发送后不空等——生成中实时上屏；assistant/turnEnd 事件收口清零）
  const [stream, setStream] = useState<StreamBuf | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [manualPath, setManualPath] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [showCtx, setShowCtx] = useState(false)
  // Z-1 延伸（0.15.0 / D-Z15-1）：谱系抽屉开关 + 当前会话 fork-in 分叉点（open 返回 events 零额外请求提取）
  const [showLineage, setShowLineage] = useState(false)
  const [openForkPoint, setOpenForkPoint] = useState<ForkPoint | null>(null)
  const [showModelMenu, setShowModelMenu] = useState(false)
  const [modelSearch, setModelSearch] = useState('')
  const [view, setView] = useState<'chat' | 'audit' | 'dash' | 'security' | 'plugins' | 'mcp' | 'settings' | 'memory' | 'caps' | 'persona' | 'repowiki' | 'deploy'>('chat')
  // v0.4（T-29）：子链审计跳转目标——叙事行「查看子链」→ 审计页预选该子链
  const [auditFocus, setAuditFocus] = useState<string | null>(null)
  // T-FV：文件查看器（会话产出/附件点击预览——toolcard fs_* 目标路径与附件 chip 两入口）
  const [viewer, setViewer] = useState<ViewerTarget | null>(null)
  // T-FV-2：任务进程条（展开策略三态 + auto 态手动覆盖 + bash 输出行单开态）
  const [taskPanelPolicy, setTaskPanelPolicy] = useState<TaskPanelPolicy>(() => readTaskPanelPolicy())
  // C7（AD-2）：后台完成自动唤醒开关（宿主 userData store——缺省关 deny-by-default；null = 未加载）
  const [bashWakeup, setBashWakeup] = useState<boolean | null>(null)
  const [taskPanelOpen, setTaskPanelOpen] = useState<boolean | null>(null)
  const [bashOutFor, setBashOutFor] = useState<string | null>(null)
  // T-MP：显示文件修改过程（个性化视图开关——chat 流 fs_write/fs_delete 卡显隐）
  const [showFsCards, setShowFsCards] = useState<boolean>(() => readShowFsCards())
  const [bashOutData, setBashOutData] = useState<BashOutputResultDTO | null>(null)
  // T-24：能力库数据面（引用菜单 / chips / ctx 行）
  const [caps, setCaps] = useState<CapabilityEntryDTO[]>([])
  const [showCapMenu, setShowCapMenu] = useState(false)
  const [capSearch, setCapSearch] = useState('')
  // @提及引用：菜单由输入尾 @query 触发时置位——关闭/选中即剥离触发串（@ 非消息内容）
  const [mentionArmed, setMentionArmed] = useState(false)
  const [policy, setPolicy] = useState<SessionPolicyDTO>('default')
  const [showPolicy, setShowPolicy] = useState(false)
  const [windowSel, setWindowSel] = useState<number | null>(null) // S4-S3 受控版：null = 跟随元数据/端点
  const [contextWindow, setContextWindow] = useState<number | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const openRef = useRef<{ wsId: string; sessionId: string } | null>(null)
  // C8（AD-3）：会话投影缓存（key = ws::sid → 全量事件；重开经 afterSeq 游标增量——链 append-only 纪律下安全）
  const openCacheRef = useRef<Map<string, SessionEventDTO[]>>(new Map())
  // T-33（v0.3 终验 D2）：恢复横幅已显会话集（进程内幂等——重开不复显）
  const recoveryShownRef = useRef<Set<string>>(new Set())

  const fail = useCallback((e: unknown) => setError(e instanceof Error ? e.message : String(e)), [])

  const setDefaultModel = useCallback((m: string | null) => {
    setDefaultModelState(m)
    writeDefaultModel(m)
  }, [])

  const refreshSessions = useCallback(
    async (wsId: string) => {
      const list = await window.car.listSessions(wsId)
      setSessionsByWs((prev) => ({ ...prev, [wsId]: list }))
    },
    [],
  )

  // T-24：能力库数据面刷新（视图 CRUD / 引用菜单共用）
  const refreshCaps = useCallback(
    async (wsId: string) => {
      try {
        setCaps((await window.car.capabilityList(wsId)).entries)
      } catch {
        setCaps([]) // 无工作区/载入失败 = 空清单（视图内 onFail 已可见，菜单面不阻塞）
      }
    },
    [],
  )
  // 视图 CRUD 后刷新数据面（稳定引用——防 CapabilityView 副作用因闭包身份变化而循环重载）
  const capsChanged = useCallback(() => {
    if (selected) void refreshCaps(selected.id)
  }, [selected, refreshCaps])
  // ── 初始化 + 推送订阅（一次挂载，按 openRef 过滤当前会话） ──────────────
  useEffect(() => {
    window.car
      .probe()
      .then(setProbe)
      .catch(fail)
    // 启动加载已注册工作区（userData/workspaces.json——重启后侧栏不再为空）
    // v0.3-R1：首次（无端侧偏好）默认全展开；按工作区并行预载会话清单（展开即可见，N 个工作区量小）
    window.car
      .listWorkspaces()
      .then(async (ws) => {
        setWorkspaces(ws)
        // 首次（无端侧偏好）且已有工作区时默认全展开——空清单不写偏好（避免把「加载空窗期」的 [] 污染成用户显式全收缩）
        if (ws.length > 0 && readExpandedWs() == null) {
          setExpandedWs(ws.map((w) => w.id))
          writeExpandedWs(ws.map((w) => w.id))
        }
        const entries = await Promise.all(
          ws.map(async (w) => [w.id, await window.car.listSessions(w.id).catch(() => [] as SessionInfo[])] as const),
        )
        setSessionsByWs(Object.fromEntries(entries))
      })
      .catch(fail)
    // K5-F：清理 K5-E 遗留自由模型清单键（模型已归属端点——设置面板维护）
    clearLegacyCustomModels()
    // S5（D-S5-4）：模型菜单数据面（内置元数据表——池端点随工作区选择刷新）
    window.car
      .modelsMeta()
      .then((r) => { setMeta(r.meta); setPoolMembers(r.pool); setEndpointMeta(r.endpoint) })
      .catch(() => setMeta({}))
    // C7（AD-2）：接回开关初始态（宿主 store——缺省关 deny-by-default）
    window.car
      .bashWakeupGet()
      .then((s) => setBashWakeup(s.autoWakeup))
      .catch(() => setBashWakeup(false))
    const offEvent = window.car.onSessionEvent((p: SessionEventPush) => {
      const cur = openRef.current
      if (!cur || p.workspaceId !== cur.wsId || p.sessionId !== cur.sessionId) return
      setEvents((prev) => [...prev, p.event])
      // C8：推送事件同步进投影缓存（重开时游标增量与现场推送两侧一致）
      const ck = p.workspaceId + '::' + p.sessionId
      const c = openCacheRef.current.get(ck)
      if (c) openCacheRef.current.set(ck, [...c, p.event])
      if (p.event.kind === 'assistant') {
        // 1.19.0：全文事件到达 = 流式缓冲收口（增量之和 ≡ 落链全文，屏幕无第二事实源）
        setStream((s) => (s && s.turnId === p.event.turnId ? null : s))
      }
      if (p.event.kind === 'system') {
        // T-ME：进化运行到达 → 状态条提示（候选明细在记忆页复核区——auto 运行用户可能不在记忆页）
        const ep = p.event.payload as Record<string, unknown> | null
        if (ep?.['type'] === 'memory/evolution') {
          const n = Array.isArray(ep['candidates']) ? (ep['candidates'] as unknown[]).length : 0
          setStatus(`记忆进化 ${String(ep['runId'] ?? '')}：候选 ${n} 条待复核（记忆页）`)
        }
      }
      if (p.event.kind === 'turnEnd' && !p.event.turnId.startsWith('authz:')) {
        // 1.19.0：turn 收口（含 aborted/error）清残留增量——中断态不留下半截临时文本
        setStream((s) => (s && s.turnId === p.event.turnId ? null : s))
        setBusy(false)
        void window.car.sessionUsage(cur.wsId, cur.sessionId).then(setUsage).catch(fail)
        // T-33（v0.3 终验 D2）：turn 收口即刷会话列表——eventCount 不再 stale
        void window.car
          .listSessions(cur.wsId)
          .then((list) => setSessionsByWs((prev) => ({ ...prev, [cur.wsId]: list })))
          .catch(() => {})
      }
    })
    // 1.19.0：流式增量订阅（渲染提示面——按当前打开会话过滤；子链增量随 sessionId 过滤自然丢弃）
    const offDelta = window.car.onSessionDelta((p: SessionDeltaPush) => {
      const cur = openRef.current
      if (!cur || p.workspaceId !== cur.wsId || p.sessionId !== cur.sessionId) return
      setStream((prev) => applyStreamDelta(prev, p))
    })
    const offPending = window.car.onAuthzPending((p: AuthzPendingPush) => {
      const cur = openRef.current
      if (!cur || p.workspaceId !== cur.wsId || p.sessionId !== cur.sessionId) return
      // R-K2-1：队列化（requestId 幂等去重——多子 Agent/父请求并发在途各自成卡）
      setPendings((prev) => (prev.some((x) => x.requestId === p.requestId) ? prev : [...prev, p]))
    })
    const offResolved = window.car.onAuthzResolved((p: AuthzResolvedPush) => {
      setPendings((prev) => {
        if (!prev.some((x) => x.requestId === p.requestId)) return prev
        if (p.outcome === 'timeout') setStatus('授权超时——内核默认拒绝（timeout-default-deny）')
        if (p.outcome === 'cancelled') setStatus('授权请求已取消（会话关闭）')
        return prev.filter((x) => x.requestId !== p.requestId)
      })
    })
    // B-2（D-B2-4）：HITL 接管卡订阅——detect 建/其余收卡；超时显式留痕（任务转 waiting 由模型报告）
    const offHitl = window.car.onBrowserHitl((p: BrowserHitlPush) => {
      if (p.phase === 'detect') setHitl(p)
      else {
        setHitl(null)
        if (p.phase === 'timeout') setStatus('浏览器接管超时（5 分钟）——结果已报告模型（hitl-timeout，不静默重试）')
      }
    })
    // T-23：自动更新状态机（available/downloaded/error 横幅 fail-visible；disabled = dev 形态不显）
    const offUpdate = window.car.onUpdateStatus((s: UpdateStatusPush) => setUpdate(s))
    return () => {
      offEvent()
      offDelta()
      offPending()
      offResolved()
      offHitl()
      offUpdate()
    }
  }, [fail])

  // 自动滚底
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [events, pendings.length, stream])

  // ── 工作区/会话 ────────────────────────────────────────────────────────
  const pickWorkspace = async () => {
    setError(null)
    try {
      const w = await window.car.pickAndRegisterWorkspace()
      if (!w) return
      const all = await window.car.listWorkspaces()
      setWorkspaces(all)
      // v0.3-R1：新注册即展开（否则选中后在收起组里看不到会话）
      const next = [...new Set([...(expandedWs ?? all.map((x) => x.id)), w.id])]
      setExpandedWs(next)
      writeExpandedWs(next)
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
      const all = await window.car.listWorkspaces()
      const next = [...new Set([...(expandedWs ?? all.map((x) => x.id)), w.id])]
      setExpandedWs(next)
      writeExpandedWs(next)
      await selectWorkspace(w)
    } catch (e) {
      fail(e)
    }
  }

  const selectWorkspace = async (w: WorkspaceInfo) => {
    setSelected(w)
    setOpenId(null)
    setEvents([])
    setStream(null) // 1.19.0：换工作区清流式缓冲（跨会话临时态禁串）
    setUsage(null)
    setPendings([])
    setBusy(false)
    try {
      const list = await window.car.listSessions(w.id)
      setSessionsByWs((prev) => ({ ...prev, [w.id]: list }))
      void refreshCaps(w.id)
      // S5（D-S5-4）：池端点分组数据面（car.config modelPool——随工作区切换刷新）
      const m = await window.car.modelsMeta(w.id)
      setMeta(m.meta)
      setPoolMembers(m.pool)
      setEndpointMeta(m.endpoint)
    } catch (e) {
      fail(e)
    }
  }

  // v0.3-R1：工作区分组展开/收缩——收缩是纯展示态（不打断当前会话/选中）；
  // 展开 = 补拉该工作区会话数据 + 未选中时选中（载入模型面/能力库）
  const updateExpanded = (ids: string[]): void => {
    setExpandedWs(ids)
    writeExpandedWs(ids)
  }
  const toggleWs = async (w: WorkspaceInfo) => {
    const base = expandedWs ?? workspaces.map((x) => x.id)
    if (base.includes(w.id)) {
      updateExpanded(base.filter((x) => x !== w.id))
    } else {
      updateExpanded([...base, w.id])
      if (!sessionsByWs[w.id]) void refreshSessions(w.id).catch(fail)
      if (selected?.id !== w.id) await selectWorkspace(w)
    }
  }

  // Z-1（0.13.0 / D-Z13-3）：会话内分叉——upToSeq 缺省 = 整链（会话头入口）；成功后刷新侧栏 + 自动打开子会话
  const forkSession = async (upToSeq?: number) => {
    if (!selected || !openId) return
    try {
      const r = await window.car.sessionFork(selected.id, openId, upToSeq)
      await refreshSessions(selected.id)
      setStatus(`已分叉 → ${r.childSessionId}（迁移 ${r.migrated} 件——父链 fork-out 已落链；子会话回到分叉点重新问，原链不动）`)
      await openSessionById(selected, r.childSessionId)
    } catch (e) {
      fail(e)
    }
  }

  const openSessionById = async (ws: WorkspaceInfo, sessionId: string) => {
    setError(null)
    try {
      // v0.3-R1：会话可从任意展开的工作区分组点开——跨工作区先切换选中（数据/模型面随组载入）
      if (selected?.id !== ws.id) await selectWorkspace(ws)
      // C8（AD-3）：游标装载——缓存命中 = afterSeq 增量段（eventCount 恒 = 链全长；链 append-only 下合并 ≡ 全量重放）
      const cacheKey = ws.id + '::' + sessionId
      const cached = openCacheRef.current.get(cacheKey)
      const afterSeq = cached && cached.length > 0 ? cached[cached.length - 1]!.seq : undefined
      const r = await window.car.openSession(ws.id, sessionId, afterSeq)
      const delta = afterSeq != null && r.events.length > 0 && r.events[0]!.seq > afterSeq && r.eventCount >= (cached?.length ?? 0)
      const mergedEvents = afterSeq != null && cached && r.eventCount >= cached.length ? (delta ? [...cached, ...r.events] : cached) : r.events
      openCacheRef.current.set(cacheKey, mergedEvents)
      openRef.current = { wsId: ws.id, sessionId }
      setView('chat')
      setOpenId(sessionId)
      setEvents(mergedEvents)
      setStream(null) // 1.19.0：换会话清流式缓冲（回放/重开会话不带上一会话临时态）
      // Z-1 延伸（0.15.0 / D-Z15-3）：子会话头分叉点行——fork-in 标记就在 open 返回 events 里，零额外请求
      setOpenForkPoint(forkPointFromEvents(mergedEvents))
      setSessionModel(r.model)
      setContextWindow(r.contextWindow ?? null)
      // 会话策略 = 链上最近一次 session/policy，无则回退安全中心默认值
      const polEvent = [...mergedEvents].reverse().find((e) => e.kind === 'system' && (e.payload as Record<string, unknown>)['type'] === 'session/policy')
      if (polEvent) {
        setPolicy((polEvent.payload as Record<string, unknown>)['policy'] as SessionPolicyDTO)
      } else {
        window.car
          .securitySettingsGet()
          .then((s) => setPolicy(s.sessionDefaultPolicy))
          .catch(() => setPolicy('default'))
      }
      // S5（D-S5-3）：会话级思考档位 = 链上最近一次 model/set 的 reasoning 键
      const reEvent = [...mergedEvents].reverse().find((e) => e.kind === 'system' && (e.payload as Record<string, unknown>)['type'] === 'model/set' && typeof (e.payload as Record<string, unknown>)['reasoning'] === 'string')
      setSessionReasoning(reEvent ? ((reEvent.payload as Record<string, unknown>)['reasoning'] as 'off' | 'low' | 'medium' | 'high') : null)
      setUsage(await window.car.sessionUsage(ws.id, sessionId))
      setPendings([])
      setBusy(false)
      // T-22（D-S6-7）：打开即恢复明示（禁静默补记——恢复报告随 open 返回，动作落 session/recover 叙事）
      // T-33（v0.3 终验 D2）：恢复横幅仅本进程首次打开显示——重开同会话幂等回显不重复打扰（链真值不变）
      if (r.recovery && (r.recovery.interruptedTurns > 0 || r.recovery.pendingSteers > 0)) {
        if (!recoveryShownRef.current.has(sessionId)) {
          recoveryShownRef.current.add(sessionId)
          setStatus(
            `打开即恢复：补记 interrupted turn ×${r.recovery.interruptedTurns}（合成 toolResult ×${r.recovery.syntheticToolResults}）——待执行引导 ${r.recovery.pendingSteers} 条（session/recover 已落链）`,
          )
        }
      }
      if (r.modelError) setError(`模型未装配（turn 发送将被拒绝）：${r.modelError}`)
    } catch (e) {
      fail(e)
    }
  }

  const newSession = async (ws: WorkspaceInfo) => {
    setError(null)
    try {
      const info = await window.car.createSession(ws.id)
      await refreshSessions(ws.id)
      setContextWindow(info.contextWindow ?? null)
      if (info.modelError) {
        setError(`会话已创建，但模型未装配（turn 发送将被拒绝）：${info.modelError}`)
      } else {
        setStatus('已新建会话（session-start 已落链）')
      }
      // 新建即打开（S5：会话绑定模型恢复语义 + ★ 默认模型应用面；非选中工作区先随组切换）
      await openSessionById(ws, info.sessionId)
      // S5（D-S5-4）：★ 默认模型 → 新会话应用（偏好本身不落链；应用 = 会话级 model/set 落链可解释）
      // K5-D-R1：默认值必须仍在当前有效选项内（端点/池/内置）——过期遗留默认不再覆盖装配锚点
      const target = defaultModelValid ? defaultModel : null
      if (target && !info.modelError) {
        try {
          await window.car.setSessionModel(ws.id, info.sessionId, target, undefined, sessionReasoning ?? undefined)
          setSessionModel(target)
        } catch { /* 默认模型不可用 = 保留装配锚点，不阻塞 */ }
      }
    } catch (e) {
      fail(e)
    }
  }

  const commitRename = async (ws: WorkspaceInfo, sessionId: string) => {
    setEditingId(null)
    const title = editTitle.trim()
    if (!title) return
    try {
      await window.car.renameSession(ws.id, sessionId, title)
      await refreshSessions(ws.id)
    } catch (e) {
      fail(e)
    }
  }

  const removeSession = async (ws: WorkspaceInfo, sessionId: string) => {
    setError(null)
    try {
      await window.car.deleteSession(ws.id, sessionId)
      openCacheRef.current.delete(ws.id + '::' + sessionId) // C8：删除即弃投影缓存
      if (openId === sessionId) {
        setOpenId(null)
        setEvents([])
        setStream(null)
      }
      await refreshSessions(ws.id)
      setStatus('会话已删除（delete 留痕，JSONL 保留）')
    } catch (e) {
      fail(e)
    }
  }

  // ── turn / 授权 / 模型 ────────────────────────────────────────────────
  // S6（D-S6-2）：会话级记忆注入开关（localStorage 端侧偏好，默认开——与 ★ 默认模型同手法）
  const memInjectKey = openId ? `mem-inject:${openId}` : ''
  const memoryInjectOn = openId ? localStorage.getItem(memInjectKey) !== '0' : false
  const toggleMemoryInject = (): void => {
    if (!openId) return
    localStorage.setItem(memInjectKey, memoryInjectOn ? '0' : '1')
    setStatus(memoryInjectOn ? '记忆注入已关（本会话后续新 turn 不再注入——已注入行保留在链）' : '记忆注入已开（下个 turn 首次注入生效）')
    setMemInjectTick((v) => v + 1)
  }
  const [memInjectTick, setMemInjectTick] = useState(0)
  void memInjectTick

  const send = async () => {
    if (!selected || !openId || !input.trim()) return
    setError(null)
    const text = input.trim()
    setInput('')
    try {
      if (!busy) setBusy(true)
      const r = await window.car.sendTurn(selected.id, openId, text, memoryInjectOn)
      if (r.steer) setStatus('引导会话，消息将被发出但模型不会中断（待当前 turn 收口后自动续跑）')
    } catch (e) {
      if (!busy) setBusy(false)
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

  const respond = async (decision: 'once' | 'session' | 'deny', requestId: string, note?: string) => {
    if (!selected || !openId) return
    try {
      // 0.12.0（D-V12-3）：附注随决策（内核 1.25.1 决策事件 payload +note 单事件审计面）
      await window.car.respondAuthz(selected.id, openId, requestId, decision, note)
      setPendings((prev) => prev.filter((x) => x.requestId !== requestId))
      setAuthzSel((prev) => { const n = new Set(prev); n.delete(requestId); return n })
      setAuthzNotes((prev) => { const n = { ...prev }; delete n[requestId]; return n })
    } catch (e) {
      fail(e)
    }
  }

  // 0.12.0（D-V12-3）：批量多选扇出——单会话队列内勾选，逐卡顺序 respondAuthz（链上恒逐卡决策事件）；
  // 首败 fail-visible 停扇红条（剩余卡保持 pending 逐卡重决）
  const respondBatch = async (decision: 'once' | 'session' | 'deny') => {
    if (!selected || !openId || authzSel.size === 0) return
    const ids = pendings.filter((p) => authzSel.has(p.requestId)).map((p) => p.requestId)
    const note = authzBatchNote.trim() ? authzBatchNote.trim().slice(0, 500) : undefined
    for (const id of ids) {
      try {
        await respond(decision, id, note)
      } catch (e) {
        fail(e)
        return
      }
    }
    setAuthzBatchNote('')
    setAuthzSel(new Set())
  }

  const [sessionReasoning, setSessionReasoning] = useState<'off' | 'low' | 'medium' | 'high' | null>(null)

  const switchModel = async (m: string, winOverride?: number | null) => {
    if (!selected || !openId || !m.trim()) return
    // winOverride 显式传入（条目声明窗口）优先；未传 = 手选窗口声明（windowSel）
    const win = winOverride !== undefined ? winOverride : windowSel
    try {
      await window.car.setSessionModel(selected.id, openId, m.trim(), win ?? undefined, sessionReasoning ?? undefined)
      setSessionModel(m.trim())
      if (win) setContextWindow(win)
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
  // v0.3-R1：派生——选中工作区的会话（审计页等视图数据源）+ 展开集合
  const sessions = selected ? (sessionsByWs[selected.id] ?? []) : []
  const expandedSet = new Set(expandedWs ?? workspaces.map((w) => w.id))
  const { items, routing } = buildChatItems(events, busy)
  // T-MP：显示文件修改过程——过滤 fs_write/fs_delete 工具卡（fs_read 保留；pendingCount 只数 msg 不受影响）
  const visibleItems = showFsCards ? items : items.filter((it) => !(it.kind === 'tool' && (it.card.tool === 'fs_write' || it.card.tool === 'fs_delete')))
  // S5（D-S5-1）：最近的池降级/耗尽事件 → 顶部横幅（fail-visible，禁静默换模型）
  const lastRouting = routing.at(-1) ?? null
  const showRoutingBanner = lastRouting != null && (lastRouting.reason === 'fallback' || lastRouting.reason === 'exhausted')
  // S5（D-S5-4）：模型菜单数据面 = 内置元数据表 + 池端点，搜索过滤
  // K5-D-R2：端点模型进菜单（「自定义端点」组——K5-F 起为模型列表，一 URL 多模型；选中即带窗口声明，sessionWindow 武装 token 阈值）
  const endpointOptions: ModelOption[] = (endpointMeta?.models ?? []).map((m) => ({ id: m.id, group: '自定义端点', contextWindow: m.contextWindow, thinking: null }))
  const builtinOptions: ModelOption[] = Object.entries(meta).map(([id, m]) => ({
    id,
    group: '内置模型',
    contextWindow: m.contextWindow,
    thinking: m.thinking,
  }))
  const poolOptions: ModelOption[] = poolMembers.map((m) => ({ id: m.model, group: `池端点 ${m.id}`, contextWindow: null, thinking: null }))
  const seenModels = new Set<string>()
  const allOptions = [...endpointOptions, ...poolOptions, ...builtinOptions].filter((o) => {
    if (seenModels.has(o.id)) return false
    seenModels.add(o.id)
    return modelSearch.trim() ? o.id.toLowerCase().includes(modelSearch.trim().toLowerCase()) : true
  })
  // K5-D-R1：★ 默认有效性判定——不在当前选项（端点/池/内置）的旧默认（如换端点/删池后的遗留）
  // 不再自动应用（此前 S5 测试遗留的 defaultModel 会覆盖端点锚点模型成乱值）
  const defaultModelValid = defaultModel !== null && allOptions.some((o) => o.id === defaultModel)
  const groups = [...new Set(allOptions.map((o) => o.group))]
  const lastUsed = (usage?.lastInput ?? 0) + (usage?.lastOutput ?? 0)
  const pct = contextWindow ? Math.min(100, (lastUsed / contextWindow) * 100) : null
  const pctColor = pct == null ? 'var(--accent, #5e6ad2)' : pct > 92 ? 'var(--danger, #d24949)' : pct > 78 ? 'var(--warn, #b97d10)' : 'var(--accent, #5e6ad2)'
  // S6（D-S6-6）：待执行队列（user 事件无对应 turnEnd = 引导排队中）→ 提示条显隐 + ctx-pop 记忆注入行数据
  const pendingCount = items.filter((it) => it.kind === 'msg' && it.role === 'user' && it.pending).length
  const lastInjectionEvent = [...events].reverse().find((e) => e.kind === 'system' && (e.meta as Record<string, unknown> | null)?.['injection'] === 'memory')
  // T-MP：个性化指令注入行（ctx-pop「风格指令」——快照随会话，压缩重注即新事件）
  const lastPersonaEvent = [...events].reverse().find((e) => e.kind === 'system' && (e.meta as Record<string, unknown> | null)?.['injection'] === 'persona')
  // T-24：能力引用态（chips + cap-menu ✓ 数据源）+ 最近注入行（ctx-pop D-C3 行位真值）
  const activeRefs = activeCapabilityRefs(events)
  const lastCapInjection = [...events]
    .reverse()
    .find((e) => e.kind === 'system' && (e.meta as Record<string, unknown> | null)?.['injection'] === 'capability' && (e.meta as Record<string, unknown>)['op'] === 'inject')
  const capsById = new Map(caps.map((c) => [c.id, c]))
  const filteredCaps = caps.filter((c) => (capSearch.trim() ? (c.name + c.id + (c.tags ?? []).join(' ')).toLowerCase().includes(capSearch.trim().toLowerCase()) : true))
  // T-25：附件态（chips + ctx 行数据源）+ 登记/撤销/选择器
  const attachments = activeAttachments(events)
  const attachFulltextInjected = events
    .filter((e) => e.kind === 'system' && (e.meta as Record<string, unknown> | null)?.['injection'] === 'attachment')
    .reduce((s, e) => s + Number((e.meta as Record<string, unknown>)['chars'] ?? 0), 0)
  const attachPathRefCount = attachments.filter((a) => a.mode === 'path-ref').length
  // K2（1.16 子 Agent）：ctx-pop 汇总行数据（活跃 ≈ 已派生未 join/kill；累计 = 链上 spawn 事件数——链即真值）
  const subagentSpawns = events.filter((e) => e.kind === 'system' && (e.payload as Record<string, unknown> | null)?.['type'] === 'subagent/spawn')
  const subagentClosed = events.filter((e) => {
    const t = (e.payload as Record<string, unknown> | null)?.['type']
    return e.kind === 'system' && (t === 'subagent/join' || t === 'subagent/kill')
  }).length
  const subagentActive = Math.max(0, subagentSpawns.length - subagentClosed)
  // T-FV-2：任务进程条行数据——统一派生（task-rows.ts：subagent/* + bash/* 合并，链即真值）
  const taskRows = taskRowsFrom(events)
  const activeTaskCount = taskRows.filter((r) => r.state === 'active').length
  // 秒表数据源：busy 时回合起点 = 最近 user 事件 ts（steer 追加即换道——最后一条即当前回合）
  const turnStartTs = busy ? (events.filter((e) => e.kind === 'user').at(-1)?.ts ?? null) : null
  const taskPanelExpanded = taskPanelPolicy === 'always' ? true : taskPanelPolicy === 'collapsed' ? false : taskPanelOpen ?? (busy || activeTaskCount > 0)

  // 秒表/倒计时统一 ticker（展示口径；真值在内核）——R-K2-1 队列态 + T-FV-2 任务秒表/回合用时
  useEffect(() => {
    if (pendings.length === 0 && !busy && activeTaskCount === 0) return
    setNowTick(Date.now())
    const t = setInterval(() => setNowTick(Date.now()), 500)
    return () => clearInterval(t)
  }, [pendings.length, busy, activeTaskCount])

  /** T-FV-2：bash 输出行单开态（拉取即读——tail 已在宿主过 redact） */
  const toggleBashOut = async (taskId: string): Promise<void> => {
    if (bashOutFor === taskId) {
      setBashOutFor(null)
      setBashOutData(null)
      return
    }
    if (!selected || !openId) return
    setBashOutFor(taskId)
    setBashOutData(null)
    try {
      setBashOutData(await window.car.bashOutput(selected.id, openId, taskId))
    } catch (e) {
      fail(e)
    }
  }
  const attachFiles = async (): Promise<void> => {
    if (!selected || !openId) return
    try {
      const paths = await window.car.attachmentPick()
      if (!paths?.length) return
      const rows = await window.car.attachmentAdd(selected.id, openId, paths)
      setStatus(
        `附件已登记（file/attach 落链）：全文注入 ${rows.filter((r) => r.mode === 'fulltext').length} 个 · 路径登记 ${rows.filter((r) => r.mode === 'path-ref').length} 个`,
      )
    } catch (e) {
      fail(e)
    }
  }
  const detachFile = async (path: string): Promise<void> => {
    if (!selected || !openId) return
    try {
      await window.car.attachmentRemove(selected.id, openId, path)
      setStatus(`附件已撤销（file/attach-remove 补偿事件落链）`)
    } catch (e) {
      fail(e)
    }
  }

  /** T-FV：打开文件查看器（相对路径按工作区 root 词法解析——与宿主 fsReadTool 同口径） */
  const openFileViewer = (rawPath: string, source: 'produced' | 'attach'): void => {
    if (!selected || !openId) return
    setViewer({ workspaceId: selected.id, sessionId: openId, path: resolveViewerPath(selected.path, rawPath), source })
  }
  const toggleRef = async (refId: string): Promise<void> => {
    if (!selected || !openId) return
    try {
      if (activeRefs.includes(refId)) await window.car.capabilityRefRemove(selected.id, openId, refId)
      else await window.car.capabilityRefAdd(selected.id, openId, refId)
    } catch (e) {
      fail(e)
    }
  }

  // ── @提及引用（T-24 增强）：输入尾 @query 触发引用菜单——与 ◆ 菜单同源数据面/同落链语义 ──
  // 触发 = 输入以 @query 结尾（首尾打字主流形态；句中 @ 不触发，走 ◆ 菜单）；关闭即剥离触发串
  // （@ 为交互触发器非消息内容）；选中 = 引用落链 + 剥离；@态 Enter = 收菜单不发送。
  const onInputChange = (v: string): void => {
    setInput(v)
    const m = MENTION_RE.exec(v)
    if (m && openId) {
      setMentionArmed(true)
      setShowCapMenu(true)
      setCapSearch(m[1])
    } else if (mentionArmed && showCapMenu) {
      setMentionArmed(false)
      setShowCapMenu(false)
      setCapSearch('')
    }
  }
  const stripMention = (): void => {
    setInput((v) => v.replace(MENTION_RE, ''))
    setMentionArmed(false)
    setCapSearch('')
  }
  const closeCapMenu = (): void => {
    setShowCapMenu(false)
    if (mentionArmed) stripMention()
    else setCapSearch('')
  }
  const pickCap = (id: string): void => {
    void toggleRef(id)
    setShowCapMenu(false)
    if (mentionArmed) stripMention()
    else setCapSearch('')
  }

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
        <button className={`item ${view === 'memory' ? 'sel' : ''}`} onClick={() => setView('memory')}>
          <span className="ico">❏</span>
          <span>
            <b>记忆</b>
            <small>白盒 CRUD · 落链可查</small>
          </span>
        </button>
        <button className={`item ${view === 'caps' ? 'sel' : ''}`} onClick={() => setView('caps')}>
          <span className="ico">◆</span>
          <span>
            <b>能力库</b>
            <small>专家/技能/知识包 · 引用注入</small>
          </span>
        </button>
        <button className={`item ${view === 'settings' ? 'sel' : ''}`} onClick={() => setView('settings')}><span className="ico">◐</span><span><b>设置 / 诊断</b><small>doctor · 自定义端点</small></span></button>
        <button className={`item ${view === 'persona' ? 'sel' : ''}`} onClick={() => setView('persona')}><span className="ico">✦</span><span><b>个性化</b><small>回复风格 · 自定义指令</small></span></button>
        <button className={`item ${view === 'repowiki' ? 'sel' : ''}`} onClick={() => setView('repowiki')}><span className="ico">⬡</span><span><b>RepoWiki</b><small>仓库文档 · 本地零上传</small></span></button>
        <button className={`item ${view === 'deploy' ? 'sel' : ''}`} onClick={() => setView('deploy')}><span className="ico">⇩</span><span><b>部署</b><small>版本面 · 发布渠道</small></span></button>

        {/* ── 段二：工作区分组（v0.3-R1：点击展开/收缩，会话嵌套展示在各组下） ── */}
        <div className="sec">
          工作区
          <button className="mini" onClick={() => void pickWorkspace()}>
            ＋ 注册
          </button>
        </div>
        <div className="list grow">
          {workspaces.length === 0 && <div className="empty">尚未注册工作区</div>}
          {workspaces.map((w) => {
            const wsSessions = sessionsByWs[w.id] ?? []
            const isOpen = expandedSet.has(w.id)
            return (
              <div key={w.id} className="ws-group">
                <div className={`item ws-head ${selected?.id === w.id ? 'sel' : ''}`} title={w.path}>
                  <button
                    className={`ws-chev${isOpen ? ' open' : ''}`}
                    title={isOpen ? '收起会话' : '展开会话'}
                    onClick={() => void toggleWs(w)}
                  >
                    ▶
                  </button>
                  <button className="item-main" onClick={() => void toggleWs(w)}>
                    <span className="ico">◆</span>
                    <span>
                      <b>{w.name}</b>
                      <small>{w.configPath ? 'config 已装载' : '无 car.config'} · {wsSessions.length} 会话</small>
                    </span>
                  </button>
                  <span className="ws-ops">
                    <button className="mini" title="在此工作区新建会话" onClick={() => void newSession(w)}>
                      ＋
                    </button>
                    <button
                      className="mini"
                      title="RepoWiki：生成/查看"
                      onClick={(e) => {
                        e.stopPropagation()
                        setView('repowiki')
                      }}
                    >
                      ⬡
                    </button>
                  </span>
                </div>
                {isOpen && (
                  <div className="ws-sessions">
                    {wsSessions.length === 0 && <div className="empty">此工作区暂无会话</div>}
                    {wsSessions.map((s) => (
                      <div key={s.sessionId} className={`item sess ${openId === s.sessionId ? 'sel' : ''}`}>
                        {editingId === s.sessionId ? (
                          <input
                            className="rename"
                            value={editTitle}
                            autoFocus
                            onChange={(e) => setEditTitle(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') void commitRename(w, s.sessionId)
                              if (e.key === 'Escape') setEditingId(null)
                            }}
                          />
                        ) : (
                          <button className="item-main" onClick={() => void openSessionById(w, s.sessionId)}>
                            <span className="ico">◇</span>
                            <span>
                              <b>{s.title}{s.parentSessionId ? <span className="subagent-badge" title={`子 Agent（父会话 ${s.parentSessionId}——独立链，授权门经父弹窗）`}>子 Agent</span> : null}</b>
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
                          <button className="mini danger" title="删除（留痕，JSONL 保留）" onClick={() => void removeSession(w, s.sessionId)}>
                            ✕
                          </button>
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
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
        {/* T-23：自动更新横幅（三段显式——下载/安装均为用户动作；error = 降级发布页手动下载入口） */}
        {update && (update.state === 'available' || update.state === 'downloading' || update.state === 'downloaded' || update.state === 'error') && (
          <div className={`update-banner ${update.state === 'error' ? 'danger' : ''}`} role="status">
            {update.state === 'available' && (
              <>
                <span>发现新版本 v{update.version}</span>
                <button className="btn" onClick={() => void window.car.downloadUpdate()}>
                  下载更新
                </button>
              </>
            )}
            {update.state === 'downloading' && <span>正在下载更新{update.version ? ` v${update.version}` : ''}… {update.percent ?? 0}%</span>}
            {update.state === 'downloaded' && (
              <>
                <span>更新 v{update.version} 已下载——安装后生效</span>
                <button className="btn primary" onClick={() => void window.car.installUpdate()}>
                  重启并安装
                </button>
              </>
            )}
            {update.state === 'error' && <span>更新失败：{update.message ?? '未知错误'}</span>}
            {(update.state === 'error' || update.state === 'available') && (
              <button className="btn" onClick={() => void window.car.openReleases()}>
                打开发布页（手动下载）
              </button>
            )}
          </div>
        )}

        {view === 'plugins' ? (
          <PluginsView selected={selected} />
        ) : view === 'mcp' ? (
          <McpView selected={selected} />
        ) : view === 'settings' ? (
          <SettingsView selected={selected} onEndpointChanged={() => setStatus('自定义端点已更新——新会话生效')} />
        ) : view === 'audit' ? (
          <AuditView selected={selected} sessions={sessions} focusSid={auditFocus} onFocused={() => setAuditFocus(null)} />
        ) : view === 'dash' ? (
          <DashView selected={selected} />
        ) : view === 'security' ? (
          <SecurityView />
  ) : view === 'memory' ? (
    <MemoryView selected={selected} openId={openId} events={events} onFail={fail} onStatus={setStatus} />
  ) : view === 'persona' ? (
    <PersonalizationView
      showFsCards={showFsCards}
      onShowFsCardsChange={(next) => {
        setShowFsCards(next)
        try { localStorage.setItem(SHOW_FS_CARDS_KEY, next ? '1' : '0') } catch { /* 端侧偏好降级 */ }
      }}
      onStatus={setStatus}
      onFail={fail}
    />
        ) : view === 'repowiki' ? (
          <RepoWikiView workspaces={workspaces} selected={selected} openId={openId} onStatus={setStatus} onFail={fail} />
        ) : view === 'deploy' ? (
          <DeployView update={update} probe={probe} onStatus={setStatus} onFail={fail} />
        ) : view === 'caps' ? (
          <CapabilityView selected={selected} openId={openId} onFail={fail} onStatus={setStatus} onChanged={capsChanged} />
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
              {openForkPoint && (
                <div className="forkpoint-line" data-testid="forkpoint-line" role="status">
                  ⎇ 从父会话第 {openForkPoint.upToSeq} 条消息分出（源 {openForkPoint.fromSessionId}——公共历史 = 分叉点之前；父链分叉后仍可写）
                </div>
              )}
              {pendingCount > 0 && (
                <div className="steer-banner" role="status">
                  引导会话，消息将被发出但模型不会中断——待执行 {pendingCount} 条（当前 turn 收口后 FIFO 续跑）
                </div>
              )}
            </div>
            {showCtx && usage && (
              <div className="ctx-pop ctx-up ctx-float">
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
                {lastInjectionEvent && (
                  <div className="cp-row">
                    <span>记忆注入（D-C3 行位真值——system 落链，Model-visible means logged）</span>
                    <b>
                      {String((lastInjectionEvent.meta as Record<string, unknown>)['count'] ?? '?')} 条 · {String((lastInjectionEvent.meta as Record<string, unknown>)['chars'] ?? '?')} 字符
                    </b>
                  </div>
                )}
                {lastCapInjection && (
                  <div className="cp-row">
                    <span>能力引用注入（D-C3 行位真值——当轮活跃引用集渲染）</span>
                    <b>
                      {String((lastCapInjection.meta as Record<string, unknown>)['count'] ?? '?')} 条 · {String((lastCapInjection.meta as Record<string, unknown>)['chars'] ?? '?')} 字符
                    </b>
                  </div>
                )}
                {lastCapInjection && Array.isArray((lastCapInjection.meta as Record<string, unknown>)['warnings']) && (
                  <div className="cp-row" style={{ color: 'var(--warn, #b97d10)' }}>
                    {((lastCapInjection.meta as Record<string, unknown>)['warnings'] as unknown[]).map((w, i) => (
                      <div key={i}>{String(w)}</div>
                    ))}
                  </div>
                )}
                {(attachFulltextInjected > 0 || attachPathRefCount > 0) && (
                  <div className="cp-row">
                    <span>附件注入（D-C3 行位真值——file/attach 落链，D-C6 实测字符计）</span>
                    <b>
                      {attachFulltextInjected > 0 ? `全文 ${attachFulltextInjected} 字符` : ''}
                      {attachFulltextInjected > 0 && attachPathRefCount > 0 ? ' · ' : ''}
                      {attachPathRefCount > 0 ? `路径登记 ${attachPathRefCount} 个（按需读取）` : ''}
                    </b>
                  </div>
                )}
                {lastPersonaEvent && (
                  <div className="cp-row">
                    <span>风格指令（persona 注入——新会话快照，压缩后重注）</span>
                    <b>{String((lastPersonaEvent.meta as Record<string, unknown>)['chars'] ?? '?')} 字符</b>
                  </div>
                )}
                {subagentSpawns.length > 0 && (
                  <div className="cp-row">
                    <span>子 Agent（subagent/spawn 链上真值——活跃 ≈ 未 join/kill）</span>
                    <b>活跃 {subagentActive} · 累计 {subagentSpawns.length}</b>
                  </div>
                )}
              </div>
            )}
            {showLineage && selected && (
              <LineagePanel
                sessions={sessionsByWs[selected.id] ?? []}
                currentId={openId}
                onClose={() => setShowLineage(false)}
                onJump={(sid) => {
                  setShowLineage(false)
                  void openSessionById(selected, sid)
                }}
              />
            )}
            {authzSel.size > 0 && (
              <div className="authz batch" data-testid="authz-batch-bar">
                <div className="authz-head">
                  <b>批量决策（{authzSel.size} 项已选）</b>
                  <button className="btn sm" onClick={() => setAuthzSel(new Set())}>清除勾选</button>
                </div>
                <input
                  className="authz-note"
                  placeholder="批量附注（可选，≤500 字符——随每卡决策落审计链）"
                  maxLength={500}
                  value={authzBatchNote}
                  onChange={(e) => setAuthzBatchNote(e.target.value)}
                />
                <div className="authz-actions">
                  <button className="btn primary" onClick={() => void respondBatch('once')}>
                    批准所选（本次）
                  </button>
                  <button className="btn" onClick={() => void respondBatch('session')}>
                    批准所选（会话内）
                  </button>
                  <button className="btn danger" onClick={() => void respondBatch('deny')}>
                    拒绝所选
                  </button>
                </div>
              </div>
            )}
            {pendings.map((p) => {
              const cd = Math.max(0, Math.ceil((p.ts + p.timeoutMs - nowTick) / 1000))
              return (
                <div className="authz" key={p.requestId}>
                  <div className="authz-head">
                    <label className="authz-sel">
                      <input
                        type="checkbox"
                        checked={authzSel.has(p.requestId)}
                        onChange={(e) => {
                          setAuthzSel((prev) => {
                            const n = new Set(prev)
                            if (e.target.checked) n.add(p.requestId)
                            else n.delete(p.requestId)
                            return n
                          })
                        }}
                      />
                      <b>M3 授权门</b>
                    </label>
                    <span className={`timer ${cd <= 10 ? 'hot' : ''}`}>{cd}s 后超时默认拒绝</span>
                  </div>
                  <div className="authz-body">
                    工具 <code>{p.tool}</code> · 目标 <code>{p.resource}</code>（{p.capability}）
                  </div>
                  <input
                    className="authz-note"
                    placeholder="附注（可选，≤500 字符——批准/拒绝理由随决策落审计链）"
                    maxLength={500}
                    value={authzNotes[p.requestId] ?? ''}
                    onChange={(e) => setAuthzNotes((prev) => ({ ...prev, [p.requestId]: e.target.value }))}
                  />
                  <div className="authz-actions">
                    <button className="btn primary" onClick={() => void respond('once', p.requestId, authzNotes[p.requestId])}>
                      批准本次
                    </button>
                    <button className="btn" onClick={() => void respond('session', p.requestId, authzNotes[p.requestId])}>
                      本次会话内始终允许
                    </button>
                    <button className="btn danger" onClick={() => void respond('deny', p.requestId, authzNotes[p.requestId])}>
                      拒绝
                    </button>
                  </div>
          </div>
        )
      })}
            {hitl && hitl.phase === 'detect' && (
              <div className="authz" data-testid="browser-hitl-card">
                <div className="authz-head">
                  <b>浏览器接管</b>
                  <span className="timer hot">{hitl.deadlineTs ? `${Math.max(0, Math.ceil((hitl.deadlineTs - nowTick) / 1000))}s` : ''} 后转 waiting</span>
                </div>
                <div className="authz-body">
                  检测到登录/验证特征（{hitl.reason ?? '确定性规则'}）——请在受控窗口完成
                  <code>{hitl.url.slice(0, 60)}</code>
                </div>
                <div className="authz-actions">
                  <button className="btn primary" onClick={() => void window.car.browserFocus()}>
                    去受控窗口
                  </button>
                </div>
              </div>
            )}
            {/* T-FV-2：任务进程条（原型 summaryPanel 同构——胶囊头 spinner/秒表/N 后台/展开策略三态 +
                任务行 [bash|子代理] 类型徽标/停止按钮/输出尾部；底注 = 语义口径） */}
            {(busy || taskRows.length > 0) && (
              <div className="subagent-panel">
                <div
                  className="sp-head"
                  onClick={() => setTaskPanelOpen(!taskPanelExpanded)}
                  title={taskPanelExpanded ? '收起状态面板' : '展开状态面板'}
                >
                  {(busy || activeTaskCount > 0) && <span className="sp-spin" />}
                  <b>状态</b>
                  {busy && turnStartTs != null && <span className="sp-elapsed">{formatDuration(nowTick - turnStartTs)}</span>}
                  {activeTaskCount > 0 && <span className="sp-badge">{activeTaskCount} 后台</span>}
                  {pendings.length > 0 && <span className="sp-badge warn">授权等待 {pendings.length}</span>}
                  <span className="sp-flex" />
                  <button
                    className="sp-strategy"
                    title={`状态面板展开策略：${TASK_PANEL_LABEL[taskPanelPolicy]}（点击切换）`}
                    onClick={(e) => {
                      e.stopPropagation()
                      const next: TaskPanelPolicy = taskPanelPolicy === 'auto' ? 'always' : taskPanelPolicy === 'always' ? 'collapsed' : 'auto'
                      setTaskPanelPolicy(next)
                      writeTaskPanelPolicy(next)
                      setTaskPanelOpen(null)
                    }}
                  >
                    ⛶ {TASK_PANEL_LABEL[taskPanelPolicy]}
                  </button>
                  <button
                    className="sp-strategy"
                    title="后台任务完成自动唤醒（缺省关=徽标提醒档；开启后任务自然退出将自动追加引导，下一回合交付模型消费——花 token 的自动行为显式开关）"
                    onClick={(e) => {
                      e.stopPropagation()
                      const next = !(bashWakeup === true)
                      setBashWakeup(next)
                      window.car
                        .bashWakeupSet(next)
                        .then((s) => setBashWakeup(s.autoWakeup))
                        .catch(fail)
                    }}
                  >
                    {bashWakeup === true ? '自动唤醒 开' : '自动唤醒 关'}
                  </button>
                  <span className={`sp-caret${taskPanelExpanded ? ' open' : ''}`}>▾</span>
                </div>
                {taskPanelExpanded && (
                  <div className="sp-body">
                    {taskRows.map((r: TaskRow) => (
                      <div key={r.kind + r.id} className={`sp-row ${r.state}`}>
                        <span className={`sp-type ${r.kind}`}>{r.kind === 'bash' ? 'bash' : '子代理'}</span>
                        <span className={`sp-state ${r.state}`}>
                          {r.state === 'active'
                            ? `运行中 ${formatDuration(nowTick - r.startedTs)}`
                            : r.state === 'joined'
                              ? '已汇合'
                              : r.state === 'killed'
                                ? '已终止'
                                : r.state === 'stopped'
                                  ? '已停止'
                                  : `已完成 exit=${r.exitCode ?? '—'}${r.durationMs != null ? ` · ${formatDuration(r.durationMs)}` : ''}`}
                        </span>
                        <span className="sp-task" title={r.title}>{r.title.slice(0, 56) || '(无描述)'}</span>
                        {/* C7（AD-2）：完成徽标（提醒档缺省面——收口后无 user 事件 = 结果待取回） */}
                        {r.kind === 'bash' && r.state === 'done' && !r.consumed && <span className="tag ok">结果待取回</span>}
                        {r.kind === 'bash' && r.state === 'done' && r.exitCode != null && r.exitCode !== 0 && <span className="dim">exit={r.exitCode}</span>}
                        {r.joinReason && <span className="dim">reason={r.joinReason}</span>}
                        {r.state === 'active' && selected && openId && (
                          <button
                            className="sp-stop"
                            onClick={() => {
                              const call = r.kind === 'bash' ? window.car.bashKill(selected.id, openId, r.id) : window.car.killSubagent(selected.id, openId, r.id)
                              void call
                                .then(() => setStatus(r.kind === 'bash' ? `后台任务已发终止信号（bash/kill 落链）` : `子 Agent 已发终止信号（subagent/kill 落链）`))
                                .catch(fail)
                            }}
                          >
                            停止
                          </button>
                        )}
                        {r.kind === 'subagent' && (
                          <button className="link-btn" onClick={() => { setAuditFocus(r.id); setView('audit') }}>子链 ↗</button>
                        )}
                        {r.kind === 'bash' && (
                          <button className="link-btn" onClick={() => void toggleBashOut(r.id)}>
                            {bashOutFor === r.id ? '收起输出' : '输出 ↗'}
                          </button>
                        )}
                      </div>
                    ))}
                    {bashOutFor && bashOutData && bashOutData.taskId === bashOutFor && (
                      <div className="sp-out-wrap">
                        <pre className="sp-out">{bashOutData.tail || '（无输出）'}</pre>
                        <div className="dim sp-out-meta">
                          {bashOutData.running ? '运行中' : bashOutData.stopped ? '已停止' : `退出码 ${bashOutData.exitCode ?? '—'}`}
                          {' · '}输出 {bashOutData.outputBytes}B{bashOutData.truncated ? ' · 尾部窗口（超出已截除）' : ''}
                          {' · '}读取面已脱敏（K-FS-4）
                        </div>
                      </div>
                    )}
                    {taskRows.length === 0 && <div className="dim sp-empty">本轮暂无后台任务——bash_run / 子代理派生后将在此实时呈现</div>}
                  </div>
                )}
                <div className="sp-foot">
                  后台任务 = agent 工具调用：派生 / 汇合 / 终止与 bash 启动 / 退出 / 停止均落审计链 ·
                  bash 经 M3 授权门（只读模式一律拒）· 子面白名单仅 fs_read · 停止 = 终止信号，子链 / 进程以 aborted 收口
                </div>
              </div>
            )}
            <div className="chat-scroll" ref={scrollRef}>
              {visibleItems.map((it, i) => {
                if (it.kind === 'msg') {
                  return (
                    <div key={i} className={`msg ${it.role}`}>
                      <div className="who">
                        {it.role === 'user' ? '我' : 'CR'}
                        {it.pending && <span className="pending-badge">待执行</span>}
                        {it.role === 'user' && it.seq !== undefined && (
                          <button
                            className="mini fork-btn"
                            data-testid={`fork-at-${it.seq}`}
                            title="从此分叉（子会话回到这条消息之前——重新问/改问法，原链不动；⎇ 谱系后缀自动）"
                            onClick={() => void forkSession(it.seq)}
                          >
                            ⎇ 分叉
                          </button>
                        )}
                      </div>
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
                            目标{' '}
                            {it.card.argsPath ? (
                              <code
                                className="file-path"
                                title="点击打开文件查看器（fs_read 同管线预览 · 动作落链）"
                                onClick={() => openFileViewer(it.card.argsPath!, 'produced')}
                              >
                                {it.card.argsPreview}
                              </code>
                            ) : (
                              <code>{it.card.argsPreview}</code>
                            )}
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
                    {it.subagentLink && (
                      <button className="link-btn" onClick={() => { setAuditFocus(it.subagentLink!); setView('audit') }}>查看子链 ↗</button>
                    )}
                    {it.auditJump && (
                      <button className="link-btn" onClick={() => { if (openId) setAuditFocus(openId); setView('audit') }}>审计原文 ↗</button>
                    )}
                  </div>
                )
              })}
              {/* v0.9.0（D-SD3）：思考条——掩蔽流滚动呈现（内核侧已脱敏，D-C1 主面纪律；即时态，
                  assistant/turnEnd 到达清零由叙事 chip 接管） */}
              {stream && stream.thinking && (
                <div className="msg agent thinking-live">
                  <div className="who">CR</div>
                  <div className="bubble">
                    <span className="think-label">思考中</span>
                    {stream.thinking}
                    <span className="stream-cursor" aria-hidden />
                  </div>
                </div>
              )}
              {/* 1.19.0：流式增量气泡（生成中实时上屏——内核脱敏放行段；assistant 事件到达即被事件全文取代） */}
              {stream && (stream.text || stream.toolName) && (
                <div className="msg agent streaming">
                  <div className="who">CR</div>
                  <div className="bubble">
                    {stream.text ? (
                      <>
                        {stream.text}
                        <span className="stream-cursor" aria-hidden />
                      </>
                    ) : (
                      <span className="dim">正在调用工具 <code>{stream.toolName}</code>…（参数流式生成中）</span>
                    )}
                  </div>
                </div>
              )}
            </div>
            {/* T-24/T-25：已引用条 + 已附文件（输入区上方——✕ 撤销 = 补偿事件落链） */}
            {(activeRefs.length > 0 || attachments.length > 0) && (
              <div className="ref-chips">
                {activeRefs.map((id) => (
                  <span key={id} className="ref-chip" title={capsById.get(id)?.spec.slice(0, 120)}>
                    ◆ {capsById.get(id)?.name ?? id}
                    {capsById.get(id)?.status === 'maintain' && <small>（维护中）</small>}
                    {capsById.get(id)?.status === 'retired' && <small>（已退役）</small>}
                    <button className="ref-x" onClick={() => void toggleRef(id)} title="撤销引用（remove 补偿事件落链）">
                      ✕
                    </button>
                  </span>
                ))}
                {attachments.map((a) => (
                  <span
                    key={a.path}
                    className={`ref-chip att-chip${a.mode === 'path-ref' ? ' att-ref' : ''}`}
                    title={`${a.path}（${a.mime} · ${a.size}B · ${a.mode === 'fulltext' ? '全文注入' : '路径登记，fs_read 按需读取'}）· 点击打开文件查看器`}
                    onClick={() => openFileViewer(a.path, 'attach')}
                  >
                    📎 {a.path.split(/[\\/]/).pop()}
                    {a.mode === 'path-ref' && <small>（按需读取）</small>}
                    <button
                      className="ref-x"
                      onClick={(e) => {
                        e.stopPropagation()
                        void detachFile(a.path)
                      }}
                      title="撤销附件（file/attach-remove 补偿事件落链）"
                    >
                      ✕
                    </button>
                  </span>
                ))}
              </div>
            )}
            {/* ── S5：输入区右下聚类 [上下文圆环][模型][发送]（原型 v0.5 同构，弹层向上） ── */}
            <div className="chat-input">
              <input
                placeholder={busy ? '引导发出：当前 turn 收口后自动续跑（不打断）…' : '给 Agent 布置任务…（Enter 发送 · @ 引用技能）'}
                value={input}
                onChange={(e) => onInputChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && input.trim()) {
                    if (showCapMenu && mentionArmed) {
                      closeCapMenu() // @ 触发态 Enter = 收菜单剥离触发串（不把 @query 发进消息）
                      return
                    }
                    void send()
                  }
                }}
              />
              <div className="input-cluster">
                {openId && (
                  <div className="cluster-item">
                    <button className="pill" onClick={() => void attachFiles()} title="添加附件（文本类 ≤200KB 全文注入；其余路径登记——fs_read 按需读取走授权门）">
                      📎 附件{attachments.length > 0 ? ` · ${attachments.length}` : ''}
                    </button>
                  </div>
                )}
                {openId && (
                  <div className="cluster-item" style={{ position: 'relative' }}>
                    <button
                      className="pill"
                      onClick={() => (showCapMenu ? closeCapMenu() : (setMentionArmed(false), setShowCapMenu(true)))}
                      title="引用能力（专家/技能/知识包——prompt 注入，选中即落链；输入 @ 亦可触发）"
                    >
                      ◆ 引用{activeRefs.length > 0 ? ` · ${activeRefs.length}` : ''}
                    </button>
                    {showCapMenu && (
                      <div className="ctx-pop cap-menu ctx-up">
                        <input
                          className="mm-search"
                          placeholder="搜索能力条目…"
                          value={capSearch}
                          autoFocus
                          onChange={(e) => setCapSearch(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Escape') closeCapMenu()
                          }}
                        />
                        {filteredCaps.length === 0 && <div className="empty">无条目（能力库视图可新建）</div>}
                        {filteredCaps.map((c) => (
                          <button key={c.id} className="mm-pick" onClick={() => pickCap(c.id)}>
                            <span className="mm-check">{activeRefs.includes(c.id) ? '✓' : ''}</span>
                            <span className="mm-name">
                              {c.name}
                              {c.status !== 'active' && <small className={`cap-status cap-status-${c.status}`}>（{c.status === 'maintain' ? '维护中' : '已退役'}）</small>}
                            </span>
                            <small className="dim">{c.kind}</small>
                          </button>
                        ))}
                        <div className="mm-sec" style={{ borderTop: '1px solid var(--line, #2a2f3a)', marginTop: 6, paddingTop: 8 }}>
                          引用 = prompt 注入（不装载代码）· 撤销 = 补偿事件落链
                        </div>
                      </div>
                    )}
                  </div>
                )}
                {openId && (
                  <div className="cluster-item">
                    <button
                      className={`pill mem-pill${memoryInjectOn ? '' : ' off'}`}
                      onClick={toggleMemoryInject}
                      title="会话级记忆注入开关（端侧偏好，不落链）——注入发生在会话首轮，须在首条消息前设定"
                    >
                      记忆·{memoryInjectOn ? '开' : '关'}
                    </button>
                  </div>
                )}
                {openId && (
                  <div className="cluster-item">
                    <button
                      className="pill"
                      data-testid="fork-session-btn"
                      onClick={() => void forkSession()}
                      title="分叉会话（整链复制为新会话——回到起点重新问/换模型重试，原链不动；子会话标题 ⎇ 谱系后缀）"
                    >
                      ⎇ 分叉
                    </button>
                  </div>
                )}
                {openId && (
                  <div className="cluster-item">
                    <button
                      className={`pill${showLineage ? ' on' : ''}`}
                      data-testid="lineage-btn"
                      onClick={() => setShowLineage((v) => !v)}
                      title="分叉谱系（工作区级树——分叉点/子会话数/同父分支对比；D-Z15-1）"
                    >
                      ⎇ 谱系
                    </button>
                  </div>
                )}
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
                          if (e.key === 'Enter' && allOptions.length > 0) void switchModel(allOptions[0]!.id, windowSel ?? allOptions[0]!.contextWindow ?? undefined)
                          if (e.key === 'Escape') setShowModelMenu(false)
                        }}
                      />
                      {defaultModel && <div className="mm-default">★ 默认：{defaultModel}{defaultModelValid ? '' : '（不在当前模型选项——未应用，点 ☆ 取消或换选有效模型设默认）'}（端侧偏好，不落链）</div>}
                      {groups.map((g) => (
                        <div key={g} className="mm-group">
                          <div className="mm-sec">{g}</div>
                          {allOptions
                            .filter((o) => o.group === g)
                            .map((o) => (
                              <div key={o.id} className={`mm-item${sessionModel === o.id ? ' sel' : ''}`}>
                                <button
                                  className="mm-star"
                                  title="设为默认模型（端侧偏好，不落审计链）"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    setDefaultModel(defaultModel === o.id ? null : o.id)
                                  }}
                                >
                                  {defaultModel === o.id ? '★' : '☆'}
                                </button>
                                <button className="mm-pick" onClick={() => void switchModel(o.id, windowSel ?? o.contextWindow ?? undefined)} title={o.contextWindow ? `选中即声明窗口 ${Math.round(o.contextWindow / 1000)}k（ctx 百分比 + 压缩 token 阈值真值）` : undefined}>
                                  <span className="mm-check">{sessionModel === o.id ? '✓' : ''}</span>
                                  <span className="mm-name">{o.id}</span>
                                  <small className="dim">
                                    {o.contextWindow ? Math.round(o.contextWindow / 1000) + 'k' : ''}
                                    {o.thinking === 'model-level' ? ' · 思考绑定模型' : o.thinking === 'none' ? ' · 非思考档' : ''}
                                  </small>
                                </button>
                              </div>
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
                  <>
                    <button className="btn danger" onClick={() => void stop()} title="中断当前 turn（pending 引导消息不删除，收口后不再自动续跑）">
                      ■ 停止
                    </button>
                    <button className="btn primary send-steer" disabled={!input.trim()} onClick={() => void send()} title="引导发出（不打断当前 turn——收口后 FIFO 续跑）">
                      ↣ 引导
                    </button>
                  </>
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
      {/* T-FV：文件查看器弹层（全屏遮罩——Esc/遮罩点击/✕ 关闭） */}
      {viewer && <FileViewer target={viewer} onClose={() => setViewer(null)} />}
    </div>
  )
}
