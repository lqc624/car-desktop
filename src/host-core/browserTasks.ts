/**
 * C3-B2 · 受控浏览器工具面（提案模块 A+B+C——宿主侧组合，内核零加法；BashTaskManager 同款）
 *
 * 口径（《浏览器操控借鉴与架构设计提案》Q-B1~B5 已裁决 + §4.6/§4.7 增补节）：
 *  - **CDP over loopback**（Q-B2）：受控 BrowserWindow 由 main 进程创建（title='CAR 受控浏览器'
 *    作 target 标记），本面经 127.0.0.1:9333 /json/list 发现 + WebSocket 直驱——驱动代码与
 *    Electron API 解耦（tools/cdp/cdp.mjs 手法，零依赖 fetch+WebSocket）；
 *  - **前台原子工具**（提案 §4.2）：browser_open（导航，readonly + 网络轴）/ browser_read
 *    （读取，readonly）/ **browser_act（B-2：click/type/select/scroll/wait，write 声明）**；
 *    多页遍历由 Agent 循环逐步调用（每步落链 = 审计粒度）；后台无头批量句柄 = P2（B-3）；
 *  - **高危确认门**（§4.3 第 2 条 / D-B2-2）：browser_act 高危子集（提交/支付/发送/删除语义——
 *    classifyActRisk 确定性词表）恒走人审门——会话策略与 grants 不短路（session-handle ⓪‴）；
 *  - **HITL 接管协议**（§4.3 第 3 条 / D-B2-4）：登录页/验证码/滑块/扫码确定性特征探测
 *    （URL 特征 + DOM 探测，非 LLM 判断）→ browser/hitl 叙事 + push:browser-hitl 接管卡 →
 *    用户在受控窗口完成 → 特征消失继续；300s 超时 = status:'hitl-timeout' 报告模型
 *    （转 waiting，不静默重试）；
 *  - **网络轴扩展**（§4.3 第 1 条 / D-B2-3）：browser_act 锚点 href 预检（decideNetwork 拒 =
 *    不点击）+ act 后最终 URL 复检——判定经 session-handle 注入 browserNetGate（审计落 authz
 *    链，policy/grants 语义同 authorize 编排）；JS 驱动导航无法预检 = 登记局限（只能事后复检）；
 *  - **落链叙事 = 父链 system kind + payload.type**（EventKind 零新增，bash/* 同款先例）：
 *    `browser/start {url}` / `browser/exit {url, reason, durationMs}` / `browser/read {url,
 *    chars, truncated}` / `browser/act {action, target, status, durationMs}` /
 *    `browser/hitl {phase, url, reason}`——**页面内容不进链**（可能含密钥/超量，bash 输出同纪律）；
 *  - **provenance 四件套强制**（T-B7）：browser_read 返回 {url, fetchedAt, sortNote, missing}
 *    ——缺一标缺失而非补全（fail-visible）；内容过内核 redact() + 256KB 截断（fs_read 纪律）；
 *  - **内容注入分层标注**（§4.3 第 4 条 / D-B2-8 / N-B1 教训制度化）：结果带 sourceNote=
 *    「页面抄录」——页面抄录与模型生成在报告中分列；
 *  - **网络轴**（Q-B3）：browser_open 目标 url 过 fileSecurity.decideNetwork——判定在
 *    session-handle.authorize ⓪″（capability 分派 browser_* = 'mcp' 同口径：readonly 声明 +
 *    网络轴，与远程 MCP 工具同款）；白名单外首次人审 + **域名粒度 grant 持久化**（B-2 §4.7
 *    consent 硬化：按 会话×域名 落盘、派发前重查、存储失败=拒绝）；
 *  - **护栏 fail-visible**：单会话导航 ≤100（CAR-E-BROWSER-NAV，act 引发导航同计入）/
 *    并发受控窗口 ≤2（§4.3 速率护栏——首版单窗口 = 实例上限）/ CDP 连接 5s / 导航 15s 超时 /
 *    读取内容 256KB 截断显式标注；
 *  - **窗口重建 + 孤儿收割**（D-B2-6）：target 失效/缺失 → ensureWindow 钩子（push:browser-need-window
 *    中继触发 main 重建）后重试一轮发现；孤儿收割 = main 启动期陈旧发现文件清理（控制面留痕）；
 *  - **partition**：'persist:car-browser'（Q-B4 按 CAR 账号分片——账号体系接入后扩展分片键，登记）；
 *  - **生命周期**：窗口 = main 进程创建（宿主启动时、设置启用态）；宿主退出销毁窗口、partition
 *    落盘保留（登录态持久复用 T-B2）；本面无后台句柄（browser_task_stop = P2/B-3——原子工具
 *    模型下无长任务可停，登记缓行）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { redact, type SessionLog } from '@lqc123qwe/car-runtime'
import type { HostToolDef } from './types.ts'

/** C3 护栏参数（B-1 常量；B-2 随系统设计定标） */
export const BROWSER_CDP_PORT = 9333
export const BROWSER_NAV_MAX = 100
export const BROWSER_TEXT_CAP = 256 * 1024
export const BROWSER_CONNECT_TIMEOUT_MS = 5_000
export const BROWSER_NAV_TIMEOUT_MS = 15_000
/** B-2：HITL 接管窗口（提案 §4.3 第 3 条——默认 5 分钟，超时转 waiting 报告不静默重试） */
export const BROWSER_HITL_TIMEOUT_MS = 300_000
/** B-2：HITL 特征消失轮询间隔 */
export const BROWSER_HITL_POLL_MS = 2_000
/** B-2：act 等待类动作超时（wait 动作上限） */
export const BROWSER_ACT_WAIT_MAX_MS = 10_000
/** B-2：act 引发导航后的加载等待（短窗——click 后 loadEventFired 观测） */
export const BROWSER_ACT_NAV_TIMEOUT_MS = 8_000
/** B-2：并发受控窗口上限（§4.3 速率护栏——首版单窗口 = 实例上限，常量先立） */
export const BROWSER_WINDOW_CONC_MAX = 2
/** main 进程受控窗口标记（/json/list title 过滤——零耦合发现） */
export const BROWSER_TARGET_TITLE = 'CAR 受控浏览器'

// ── B-2 · browser_act 类型与高危分类 ──────────────────────────────────────

export type BrowserActAction = 'click' | 'type' | 'select' | 'scroll' | 'wait'

export interface BrowserActResult {
  action: BrowserActAction
  status: 'done' | 'timeout' | 'hitl-timeout' | 'aborted'
  /** act 后页面 url（HITL/跨域审计锚点） */
  url: string | null
  /** HITL 接管事实（仅接管发生时带键） */
  hitl?: { triggered: boolean; resolved: boolean; timedOut: boolean; reason?: string }
  /** 跨域导航复检标注（post-nav 未命中白名单——不可撤销性登记） */
  crossNav?: { from: string; to: string; adjudication: string }
  /** D-B2-8 内容注入分层标注（N-B1 教训制度化：页面抄录 ≠ 模型生成） */
  sourceNote: string
}

/** HITL 接管推送载荷（push:browser-hitl——接管卡生命周期锚点） */
export interface BrowserHitlPayload {
  phase: 'detect' | 'resolved' | 'timeout' | 'aborted'
  url: string
  reason?: string
  deadlineTs?: number
}

/** 网络轴判定结果（session-handle 注入 browserNetGate 的返回） */
export interface BrowserNetGateResult {
  tier: 'allow' | 'deny'
  /** post-nav 未命中白名单放行时的标注（审计留痕已在 authz 链） */
  note?: string
}

/**
 * B-2 高危动作子集判定（§4.3 第 2 条——确定性词表，非 LLM 判断）：click 目标命中
 * 提交/支付/下单/发送/删除/确认类语义即高危。登记局限：词表覆盖显式语义，结构化
 * selector（如 .btn-primary）逃逸词表 = HITL 特征探测为第二道网（两道网均确定性规则）。
 */
const HIGH_RISK_PATTERN =
  /(提交|支付|付款|下单|结算|发送|删除|销毁|撤回|确认|授权|同意|submit|pay|payment|checkout|purchase|order|send|delete|remove|destroy|confirm|approve|authorize)/i

/** browser_act 高危分类（纯函数——session-handle ⓪‴ 授权编排消费；只看 args 不看页面） */
export function classifyActRisk(args: Record<string, unknown>): boolean {
  if (String(args?.['action'] ?? '') !== 'click') return false
  const hay = [args['selector'], args['text']].filter((v) => typeof v === 'string').join(' ')
  return HIGH_RISK_PATTERN.test(hay)
}

/** act 目标描述（授权卡/审计资源文案——selector/text 前 60 字） */
export function describeActTarget(args: Record<string, unknown>): string {
  const sel = typeof args?.['selector'] === 'string' ? String(args['selector']) : ''
  const text = typeof args?.['text'] === 'string' ? String(args['text']) : ''
  const target = sel || text || '(未指定)'
  return `${String(args?.['action'] ?? '?')} → ${target.slice(0, 60)}`
}

export interface BrowserReadResult {
  /** provenance 四件套（T-B7——缺一标缺失禁补全） */
  url: string
  fetchedAt: string
  sortNote: string
  missing: string[]
  title: string | null
  /** 已过内核 redact + 256KB 截断（fs_read 纪律） */
  content: string
  truncated: boolean
  linksCount: number
}

export interface BrowserManagerDeps {
  parentLog: SessionLog
  /** userData 目录（target 发现文件 browser-target.json——main 进程写入） */
  userDataDir: string
  /** CDP 端口（缺省 9333 惯例——main 进程 --remote-debugging-port 启用时生效） */
  cdpPort?: number
  /** 注入缝：fetch（CDP HTTP 面）——测试假 /json 服务 */
  fetchImpl?: typeof fetch
  /** 注入缝：WebSocket 工厂（CDP ws 面）——测试假 target */
  wsFactory?: (url: string) => Promise<WebSocket>
  /** 注入缝：CDP 连接发现窗口（缺省 BROWSER_CONNECT_TIMEOUT_MS——测试提速） */
  connectTimeoutMs?: number
  /** 注入缝：HITL 特征轮询间隔（缺省 BROWSER_HITL_POLL_MS——测试提速） */
  hitlPollMs?: number
  /** 注入缝：HITL 接管窗口（缺省 BROWSER_HITL_TIMEOUT_MS——测试提速） */
  hitlTimeoutMs?: number
}

/** B-2 会话级钩子（session-handle attachBrowserTasks 晚绑定——构造时不可知的会话上下文） */
export interface BrowserHooks {
  /** 窗口重建触发——push:browser-need-window 中继（main 重建受控窗口，fire-and-forget） */
  ensureWindow?: () => void
  /** turn 取消态（HITL 等待中途取消即退出——不与内核 abort 语义竞争） */
  isAborted?: () => boolean
  /** HITL 接管推送（service emit → push:browser-hitl → 渲染层接管卡） */
  emitHitl?: (p: BrowserHitlPayload) => void
  /** act 导航网络轴（session-handle 构造——decideNetwork + policy 语义 + authz 审计落链） */
  browserNetGate?: (callId: string, url: string, phase: 'pre' | 'post') => BrowserNetGateResult
}

interface CdpConn {
  send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>
  waitEvent(method: string, timeoutMs: number): Promise<Record<string, unknown>>
  close(): void
}

/** 落链叙事（bash/* 同款：父链 system kind + payload.type——EventKind 零新增） */
function narrate(log: SessionLog, type: string, extra: Record<string, unknown> = {}): void {
  log.append('runtime', 'system', 'session', { type, ...extra })
}

/** evaluate 返回值宽容解析（字符串 JSON / returnByValue 对象双形态——注入缝测试假直返对象） */
function parseEvaluateValue<T>(v: unknown): T | null {
  if (v == null) return null
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as T
    } catch {
      return null
    }
  }
  return v as T
}

export class BrowserTasks {
  private navCount = 0
  private conn: CdpConn | null = null
  private readonly fetchImpl: typeof fetch
  private readonly wsFactory: (url: string) => Promise<WebSocket>
  private readonly cdpPort: number
  private readonly connectTimeoutMs: number
  private readonly hitlPollMs: number
  private readonly hitlTimeoutMs: number
  /** B-2 会话级钩子（晚绑定——attachBrowserTasks 注入；缺省全空 = 零推送零重建零网络轴） */
  private hookState: BrowserHooks = {}

  constructor(private readonly deps: BrowserManagerDeps) {
    this.cdpPort = deps.cdpPort ?? BROWSER_CDP_PORT
    this.fetchImpl = deps.fetchImpl ?? fetch
    this.wsFactory = deps.wsFactory ?? (async (url) => new WebSocket(url))
    this.connectTimeoutMs = deps.connectTimeoutMs ?? BROWSER_CONNECT_TIMEOUT_MS
    this.hitlPollMs = deps.hitlPollMs ?? BROWSER_HITL_POLL_MS
    this.hitlTimeoutMs = deps.hitlTimeoutMs ?? BROWSER_HITL_TIMEOUT_MS
  }

  /** B-2：会话级钩子注入（session-handle attach；幂等覆盖） */
  hooks(h: BrowserHooks): void {
    this.hookState = { ...this.hookState, ...h }
  }

  tools(): HostToolDef[] {
    return [this.openTool(), this.readTool(), this.actTool()]
  }

  // ── CDP 连接（懒建 + target 发现） ──────────────────────────────────────

  /**
   * 受控窗口 target 发现（双路径）：
   *  ① 发现文件 userData/browser-target.json（main 进程经 debugger.getTargetInfo 写入——
   *     targetId 跨导航稳定，不受页面 title/url 变化影响——主路径）；
   *  ② /json/list 按 title 过滤（BROWSER_TARGET_TITLE 标记——发现文件缺失时的兜底）。
   */
  private async findTarget(): Promise<{ webSocketDebuggerUrl: string; url: string }> {
    const t0 = Date.now()
    let lastErr = 'unknown'
    while (Date.now() - t0 < this.connectTimeoutMs) {
      // ① 发现文件（主路径）
      try {
        const disc = JSON.parse(readFileSync(join(this.deps.userDataDir, 'browser-target.json'), 'utf8')) as { targetId?: string; cdpPort?: number }
        if (disc.targetId) {
          const port = disc.cdpPort ?? this.cdpPort
          const wsUrl = `ws://127.0.0.1:${port}/devtools/page/${disc.targetId}`
          return { webSocketDebuggerUrl: wsUrl, url: '(发现文件)' }
        }
      } catch { /* 文件缺失/损坏 → 兜底路径 */ }
      // ② /json/list title 兜底
      try {
        const list = (await (await this.fetchImpl(`http://127.0.0.1:${this.cdpPort}/json/list`)).json()) as Array<{
          title?: string
          webSocketDebuggerUrl?: string
          url?: string
        }>
        const target = list.find((t) => t.title === BROWSER_TARGET_TITLE && t.webSocketDebuggerUrl)
        if (target) return { webSocketDebuggerUrl: target.webSocketDebuggerUrl!, url: target.url ?? '' }
        lastErr = `targets=${list.length}（无「${BROWSER_TARGET_TITLE}」标记窗口、无发现文件）`
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e)
      }
      await new Promise((r) => setTimeout(r, 300))
    }
    throw new Error(
      `CAR-E-BROWSER-TARGET: 受控浏览器窗口未发现（CDP 127.0.0.1:${this.cdpPort}，${this.connectTimeoutMs}ms）——` +
        `检查：设置已启用浏览器操控且宿主重启生效、受控窗口未被关闭（${lastErr}）`,
    )
  }

  private async ensureConn(): Promise<CdpConn> {
    if (this.conn) return this.conn
    const target = await this.findTarget()
    const ws = await this.wsFactory(target.webSocketDebuggerUrl)
    // B-2 补：open 等待加连接窗口护栏（死端口握死不回 error = 挂死——fail-visible 有界）
    await new Promise<void>((res, rej) => {
      if (ws.readyState === ws.OPEN) return res()
      const openTimer = setTimeout(() => rej(new Error(`CAR-E-BROWSER-CDP: WebSocket 连接超时（${this.connectTimeoutMs}ms——target 端口无响应）`)), this.connectTimeoutMs)
      ws.onopen = () => {
        clearTimeout(openTimer)
        res()
      }
      ws.onerror = () => {
        clearTimeout(openTimer)
        rej(new Error('CAR-E-BROWSER-CDP: WebSocket 连接失败'))
      }
    })
    let msgId = 0
    const waiting = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>()
    const eventWaiters = new Map<string, { resolve: (v: Record<string, unknown>) => void; timer: ReturnType<typeof setTimeout> }>()
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as { id?: number; result?: Record<string, unknown>; error?: { message: string }; method?: string; params?: Record<string, unknown> }
      if (msg.id && waiting.has(msg.id)) {
        const w = waiting.get(msg.id)!
        waiting.delete(msg.id)
        msg.error ? w.reject(new Error(`CDP ${msg.error.message}`)) : w.resolve(msg.result ?? {})
      } else if (msg.method && eventWaiters.has(msg.method)) {
        const w = eventWaiters.get(msg.method)!
        eventWaiters.delete(msg.method)
        clearTimeout(w.timer)
        w.resolve(msg.params ?? {})
      }
    }
    const send = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> =>
      new Promise((resolve, reject) => {
        const id = ++msgId
        waiting.set(id, { resolve, reject })
        ws.send(JSON.stringify({ id, method, params }))
      })
    const conn: CdpConn = {
      send,
      waitEvent: (method, timeoutMs) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            eventWaiters.delete(method)
            reject(new Error(`CAR-E-BROWSER-CDP: 等待事件 ${method} 超时（${timeoutMs}ms）`))
          }, timeoutMs)
          eventWaiters.set(method, { resolve, timer })
        }),
      close: () => {
        for (const [, w] of eventWaiters) clearTimeout(w.timer)
        eventWaiters.clear()
        try { ws.close() } catch { /* 收口容错 */ }
        if (this.conn === conn) this.conn = null
      },
    }
    await conn.send('Runtime.enable')
    await conn.send('Page.enable')
    this.conn = conn
    return conn
  }

  private dropConn(): void {
    this.conn?.close()
    this.conn = null
  }

  /** B-2（D-B2-6）：窗口重建——发现失败触发 ensureWindow 钩子（push:browser-need-window 中继，main 重建）后重试一轮 */
  private async ensureConnWithRecreate(): Promise<CdpConn> {
    try {
      return await this.ensureConn()
    } catch (e) {
      if (!this.hookState.ensureWindow) throw e
      this.hookState.ensureWindow()
      return await this.ensureConn() // 重建窗口内重试一轮发现（5s 窗口——创建 ~100ms + target 写入）
    }
  }

  // ── 工具定义（B-2 三件——browser_task_stop = P2/B-3 缓行登记） ──────────────

  private openTool(): HostToolDef {
    return {
      name: 'browser_open',
      // Q-B3：readonly + 网络轴（授权门 authorize ⓪″ decideNetwork——与远程 MCP 工具同口径）
      declaredSideEffect: 'readonly',
      description:
        '在受控浏览器窗口导航至 URL（受控实例与你的日常浏览器隔离，登录态按账号持久复用）。' +
        '返回最终 url/title；目标域名过网络轴（白名单外首次需人工确认，同域后续免审）。导航与读取均落审计链。',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: '目标 URL（http/https）' } },
        required: ['url'],
      },
      run: async (args) => this.open(String((args ?? {})['url'] ?? '')),
    }
  }

  private readTool(): HostToolDef {
    return {
      name: 'browser_read',
      // Q-B3：readonly（读当前页——网络门已在 open 时承担）
      declaredSideEffect: 'readonly',
      description:
        '读取受控浏览器当前页面的文本与元信息（先 browser_open 导航）。' +
        '返回 provenance 四件套（url/fetchedAt/排序口径/未获取字段）+ 正文（脱敏 + 256KB 截断显式标注）；内容不进审计链。',
      parameters: { type: 'object', properties: {} },
      run: async () => this.read(),
    }
  }

  /** B-2（D-B2-1）：browser_act——write 声明（高危子集恒走人审门在 authorize ⓪‴；网络轴在运行面 pre/post 双检） */
  private actTool(): HostToolDef {
    return {
      name: 'browser_act',
      declaredSideEffect: 'write',
      description:
        '在受控浏览器当前页面执行动作：click（点击）/ type（输入，配 value）/ select（下拉选择，配 value）/ scroll（滚动）/ wait（等待）。' +
        'click 支持 selector 或 text（文本匹配可点击元素）；高危动作（提交/支付/发送/删除类）必弹人工确认卡；' +
        '点击引发跨域导航时目标域过网络轴（白名单外跨域导航请先 browser_open 重走网络轴）。' +
        '检测到登录页/验证码/扫码时暂停并推送接管卡（需你人工完成，5 分钟超时）；' +
        '返回 sourceNote 标注「页面抄录」——报告中引用页面内容须与模型生成分列。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['click', 'type', 'select', 'scroll', 'wait'], description: '动作类型' },
          selector: { type: 'string', description: 'CSS 选择器（click/type/select/scroll 目标）' },
          text: { type: 'string', description: 'click 备选：按可见文本匹配可点击元素' },
          value: { type: 'string', description: 'type/select 的输入值' },
          x: { type: 'number', description: 'scroll 纵向位移（px，正=下）' },
          y: { type: 'number', description: 'scroll 横向位移（px，正=右）' },
          timeoutMs: { type: 'number', description: 'wait 上限（缺省 5000，≤10000）' },
        },
        required: ['action'],
      },
      run: async (args) => this.act((args ?? {}) as Record<string, unknown>),
    }
  }

  // ── B-2 · act 运行面（CDP 原子动作 + 网络轴双检 + HITL 接管） ──────────────

  /** 目标解析（click/type/select 共用）：selector 精确 → text 文本匹配兜底；返回中心坐标 + href */
  private async resolveTarget(conn: CdpConn, selector: string, text: string): Promise<{ x: number; y: number; tag: string; href: string | null; text: string } | null> {
    const selLit = JSON.stringify(selector)
    const textLit = JSON.stringify(text)
    const expr =
      selector.trim().length > 0
        ? `JSON.stringify((() => { const el = document.querySelector(${selLit}); if (!el) return null; el.scrollIntoView({block:'center'}); const r = el.getBoundingClientRect(); return {x: r.x + r.width/2, y: r.y + r.height/2, tag: el.tagName, href: el.href || null, text: (el.innerText || el.value || '').slice(0,80)} })())`
        : `JSON.stringify((() => { const els = [...document.querySelectorAll('button,a,[role=button],input[type=submit],input[type=button],label,span,div')]; const el = els.find(e => (e.innerText||'').trim().includes(${textLit}) && e.offsetParent !== null); if (!el) return null; el.scrollIntoView({block:'center'}); const r = el.getBoundingClientRect(); return {x: r.x + r.width/2, y: r.y + r.height/2, tag: el.tagName, href: el.href || null, text: (el.innerText||'').slice(0,80)} })())`
    const frame = await conn.send('Runtime.evaluate', { expression: expr, returnByValue: true })
    return parseEvaluateValue<{ x: number; y: number; tag: string; href: string | null; text: string }>((frame['result'] as { value?: unknown } | undefined)?.value)
  }

  /** HITL 确定性特征探测（URL 特征 + DOM 探测——非 LLM 判断，§4.3 第 3 条） */
  private async detectHitl(conn: CdpConn): Promise<{ hit: boolean; url: string; reason: string }> {
    const frame = await conn.send('Runtime.evaluate', {
      expression:
        `JSON.stringify({url: location.href, pwd: !!document.querySelector('input[type=password]'), ` +
        `captcha: !!document.querySelector('iframe[src*="captcha"],iframe[src*="recaptcha"],iframe[title*="captcha"],[class*="captcha" i],[id*="captcha" i],[class*="geetest"],[class*="slider" i]'), ` +
        `qr: !!document.querySelector('img[alt*="二维码"],img[alt*="扫码"],[class*="qrcode" i],[id*="qrcode" i]')})`,
      returnByValue: true,
    })
    const p = parseEvaluateValue<{ url?: string; pwd?: boolean; captcha?: boolean; qr?: boolean }>((frame['result'] as { value?: unknown } | undefined)?.value)
    if (!p) return { hit: false, url: '', reason: '' }
    const url = p.url ?? ''
    const pathLike = url.toLowerCase()
    const urlHit = /\/(login|signin|sign-in|signup|auth|oauth|sso|verify|captcha|mfa|2fa)\b/i.test(pathLike)
    const reason = p.pwd ? 'password 输入框（登录页特征）' : p.captcha ? '验证码/滑块特征' : p.qr ? '扫码特征' : urlHit ? 'URL 登录/验证特征' : ''
    return { hit: Boolean(p.pwd || p.captcha || p.qr || urlHit), url, reason }
  }

  /** HITL 接管等待：叙事 + 推送接管卡 → 轮询特征消失（2s）→ resolved/timeout/aborted */
  private async hitlWait(conn: CdpConn, url: string, reason: string): Promise<{ resolved: boolean; timedOut: boolean; aborted: boolean }> {
    const deadlineTs = Date.now() + this.hitlTimeoutMs
    narrate(this.deps.parentLog, 'browser/hitl', { phase: 'detect', url, reason })
    this.hookState.emitHitl?.({ phase: 'detect', url, reason, deadlineTs })
    while (Date.now() < deadlineTs) {
      if (this.hookState.isAborted?.()) {
        narrate(this.deps.parentLog, 'browser/hitl', { phase: 'aborted', url, reason })
        this.hookState.emitHitl?.({ phase: 'aborted', url, reason })
        return { resolved: false, timedOut: false, aborted: true }
      }
      await new Promise((r) => setTimeout(r, this.hitlPollMs))
      let still: { hit: boolean; url: string; reason: string }
      try {
        still = await this.detectHitl(conn)
      } catch {
        // 连接面异常（用户关窗等）——按 resolved:false 退出（fail-visible 由调用方收口）
        still = { hit: false, url, reason: 'probe-failed' }
      }
      if (!still.hit) {
        narrate(this.deps.parentLog, 'browser/hitl', { phase: 'resolved', url: still.url || url, reason })
        this.hookState.emitHitl?.({ phase: 'resolved', url: still.url || url })
        return { resolved: true, timedOut: false, aborted: false }
      }
    }
    narrate(this.deps.parentLog, 'browser/hitl', { phase: 'timeout', url, reason })
    this.hookState.emitHitl?.({ phase: 'timeout', url, reason })
    return { resolved: false, timedOut: true, aborted: false }
  }

  /** act 入口（参数校验 → 护栏预检 → 分派 → 导航复检 + HITL） */
  async act(args: Record<string, unknown>): Promise<BrowserActResult> {
    const action = String(args['action'] ?? '') as BrowserActAction
    if (!['click', 'type', 'select', 'scroll', 'wait'].includes(action)) {
      throw new Error('CAR-E-BROWSER-ARGS: action 须为 click/type/select/scroll/wait（fail-visible）')
    }
    const selector = typeof args['selector'] === 'string' ? String(args['selector']) : ''
    const text = typeof args['text'] === 'string' ? String(args['text']) : ''
    const value = typeof args['value'] === 'string' ? String(args['value']) : ''
    if ((action === 'click' || action === 'type' || action === 'select') && !selector.trim() && !(action === 'click' && text.trim())) {
      throw new Error('CAR-E-BROWSER-ARGS: click 须给 selector 或 text；type/select 须给 selector（fail-visible）')
    }
    if ((action === 'type' || action === 'select') && !value) {
      throw new Error(`CAR-E-BROWSER-ARGS: ${action} 须给 value（fail-visible）`)
    }
    // 导航护栏预检（click 是唯一可导航动作——§4.3 速率护栏 fail-visible）
    if (action === 'click' && this.navCount >= BROWSER_NAV_MAX) {
      throw new Error(`CAR-E-BROWSER-NAV: 单会话导航次数已达上限（${BROWSER_NAV_MAX}）——fail-visible 不静默限流`)
    }
    const startedAt = Date.now()
    const callId = `act-${startedAt}`
    let conn: CdpConn
    try {
      conn = await this.ensureConnWithRecreate()
    } catch (e) {
      narrate(this.deps.parentLog, 'browser/act', { action, target: (selector || text || '(未指定)').slice(0, 60), status: 'connect-failed', durationMs: Date.now() - startedAt })
      throw e
    }
    const finish = (result: Omit<BrowserActResult, 'sourceNote'>): BrowserActResult => {
      narrate(this.deps.parentLog, 'browser/act', {
        action, target: (selector || text || '(未指定)').slice(0, 60), status: result.status,
        ...(result.url ? { url: result.url } : {}), ...(result.hitl ? { hitl: result.hitl.triggered } : {}), durationMs: Date.now() - startedAt,
      })
      return { ...result, sourceNote: '页面抄录（受控浏览器实取——与模型生成分列，N-B1 纪律）' }
    }
    try {
      // pre 相网络轴：锚点 href 可解析时预检（decideNetwork 拒 = 不点击；未命中 = 拒并指引 browser_open——防绕过）
      let preUrl: string | null = null
      let target: { x: number; y: number; tag: string; href: string | null; text: string } | null = null
      if (action === 'click' || action === 'type' || action === 'select') {
        target = await this.resolveTarget(conn, selector, text)
        if (!target) throw new Error(`CAR-E-BROWSER-ARGS: 目标未找到（${selector || text}——先 browser_read 定位）`)
        if (action === 'click' && target.href) preUrl = target.href
      }
      if (action === 'click' && preUrl && this.hookState.browserNetGate) {
        const pre = this.hookState.browserNetGate(callId, preUrl, 'pre')
        if (pre.tier === 'deny') {
          throw new Error(`CAR-E-BROWSER-NET: 点击目标 ${preUrl} 未过网络轴（pre 检拒——跨域导航请 browser_open 重走网络轴；已落审计链）`)
        }
      }
      // 分派动作
      let status: BrowserActResult['status'] = 'done'
      let hitlInfo: BrowserActResult['hitl'] | undefined
      let navigated = false
      if (action === 'click') {
        await conn.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: target!.x, y: target!.y, button: 'left', clickCount: 1 })
        await conn.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target!.x, y: target!.y, button: 'left', clickCount: 1 })
        // 导航观测（短窗——loadEventFired 即计导航护栏）
        try {
          await conn.waitEvent('Page.loadEventFired', BROWSER_ACT_NAV_TIMEOUT_MS)
          navigated = true
          this.navCount++
        } catch { /* 未导航 = 正常态 */ }
      } else if (action === 'type' || action === 'select') {
        const selLit = JSON.stringify(selector)
        const valLit = JSON.stringify(value)
        const expr =
          `JSON.stringify((() => { const el = document.querySelector(${selLit}); if (!el) return null; el.focus(); ` +
          `const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value'); ` +
          `if (desc && desc.set) desc.set.call(el, ${valLit}); else el.value = ${valLit}; ` +
          `el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); ` +
          `return String(el.value).slice(0,80) })())`
        const frame = await conn.send('Runtime.evaluate', { expression: expr, returnByValue: true })
        if ((frame['result'] as { value?: string } | undefined)?.value === undefined) {
          throw new Error(`CAR-E-BROWSER-ARGS: 目标未找到（${selector}——先 browser_read 定位）`)
        }
      } else if (action === 'scroll') {
        const x = typeof args['y'] === 'number' ? Number(args['y']) : 0
        const y = typeof args['x'] === 'number' ? Number(args['x']) : 0
        await conn.send('Runtime.evaluate', { expression: `window.scrollBy(${x}, ${y})`, returnByValue: true })
      } else {
        const timeoutMs = Math.min(typeof args['timeoutMs'] === 'number' ? Number(args['timeoutMs']) : 5_000, BROWSER_ACT_WAIT_MAX_MS)
        await new Promise((r) => setTimeout(r, timeoutMs))
        status = 'timeout'
      }
      // post 相网络轴 + HITL（click 引发导航时）
      if (action === 'click') {
        const frame = await conn.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true })
        const finalUrl = String((frame['result'] as { value?: unknown } | undefined)?.value ?? '')
        let crossNav: BrowserActResult['crossNav'] | undefined
        if (navigated && finalUrl && this.hookState.browserNetGate) {
          const post = this.hookState.browserNetGate(callId, finalUrl, 'post')
          if (post.tier === 'deny') {
            // 只读策略白名单外 = 事后硬拒（页面已到不可撤销——登记 + 工具报错 fail-visible）
            throw new Error(`CAR-E-BROWSER-NET: act 引发导航至 ${finalUrl} 未过网络轴（post 检硬拒——导航已发生不可撤销，审计链已留痕）`)
          }
          if (post.note) crossNav = { from: '(act 前)', to: finalUrl, adjudication: post.note }
        }
        // HITL 特征探测（导航后 + 输入后——登录页/验证码/扫码确定性规则）
        const det = await this.detectHitl(conn)
        if (det.hit) {
          const w = await this.hitlWait(conn, det.url, det.reason)
          hitlInfo = { triggered: true, resolved: w.resolved, timedOut: w.timedOut, reason: det.reason }
          if (w.aborted) return finish({ action, status: 'aborted', url: det.url, hitl: hitlInfo })
          if (w.timedOut) return finish({ action, status: 'hitl-timeout', url: det.url, hitl: hitlInfo })
        }
        return finish({ action, status, url: finalUrl || null, ...(hitlInfo ? { hitl: hitlInfo } : {}), ...(crossNav ? { crossNav } : {}) })
      }
      return finish({ action, status, url: null, ...(hitlInfo ? { hitl: hitlInfo } : {}) })
    } catch (e) {
      narrate(this.deps.parentLog, 'browser/act', { action, target: (selector || text || '(未指定)').slice(0, 60), status: 'error', durationMs: Date.now() - startedAt })
      if (e instanceof Error && /CAR-E-BROWSER-(ARGS|NAV|NET)/.test(e.message)) throw e
      this.dropConn()
      throw e
    }
  }

  // ── 工具运行面 ─────────────────────────────────────────────────────────

  /** browser_open：导航（browser/start → Page.navigate → loadEventFired → HITL 探测 → browser/exit） */
  async open(rawUrl: string): Promise<{ url: string; title: string | null; status: 'loaded' | 'timeout'; hitl?: { triggered: boolean; resolved: boolean; timedOut: boolean; reason?: string } }> {
    const url = rawUrl.trim()
    if (!/^https?:\/\//i.test(url)) throw new Error('CAR-E-BROWSER-ARGS: url 须为 http/https（fail-visible）')
    // 导航护栏 fail-visible（提案 §4.3 速率护栏——数值 B-1 常量）
    if (this.navCount >= BROWSER_NAV_MAX) {
      throw new Error(`CAR-E-BROWSER-NAV: 单会话导航次数已达上限（${BROWSER_NAV_MAX}）——fail-visible 不静默限流`)
    }
    this.navCount++
    const startedAt = Date.now()
    narrate(this.deps.parentLog, 'browser/start', { url })
    let conn: CdpConn
    try {
      conn = await this.ensureConnWithRecreate()
    } catch (e) {
      narrate(this.deps.parentLog, 'browser/exit', { url, reason: 'connect-failed', durationMs: Date.now() - startedAt })
      throw e
    }
    try {
      await conn.send('Page.navigate', { url })
      let status: 'loaded' | 'timeout' = 'timeout'
      try {
        await conn.waitEvent('Page.loadEventFired', BROWSER_NAV_TIMEOUT_MS)
        status = 'loaded'
      } catch {
        // 超时显式（不静默成功——页面可能仍在加载）
      }
      const frame = await conn.send('Runtime.evaluate', { expression: '({url: location.href, title: document.title})', returnByValue: true })
      const val = frame['result'] as { value?: { url?: string; title?: string } } | undefined
      let finalUrl = val?.value?.url ?? url
      let title = val?.value?.title ?? null
      // B-2（D-B2-4）：HITL 特征探测——登录页/验证码/扫码命中即接管等待（确定性规则非 LLM）
      const det = await this.detectHitl(conn)
      if (det.hit) {
        const w = await this.hitlWait(conn, det.url, det.reason)
        if (w.resolved) {
          // 用户完成接管后重取最终页面态（登录跳转后 url/title 已变）
          const after = await conn.send('Runtime.evaluate', { expression: '({url: location.href, title: document.title})', returnByValue: true })
          const av = after['result'] as { value?: { url?: string; title?: string } } | undefined
          finalUrl = av?.value?.url ?? finalUrl
          title = av?.value?.title ?? title
        }
        return this.exitOpen(finalUrl, title, status, { triggered: true, resolved: w.resolved, timedOut: w.timedOut, reason: det.reason }, startedAt, w.aborted)
      }
      return this.exitOpen(finalUrl, title, status, undefined, startedAt, false)
    } catch (e) {
      narrate(this.deps.parentLog, 'browser/exit', { url, reason: 'error', durationMs: Date.now() - startedAt })
      this.dropConn() // 连接面异常（ws 断开等）——下次调用重连
      throw e
    }
  }

  /** open 收口单点（browser/exit 叙事 + 返回——hitl 事实随结果带给模型） */
  private exitOpen(
    url: string,
    title: string | null,
    status: 'loaded' | 'timeout',
    hitl: { triggered: boolean; resolved: boolean; timedOut: boolean; reason?: string } | undefined,
    startedAt: number,
    aborted: boolean,
  ): { url: string; title: string | null; status: 'loaded' | 'timeout'; hitl?: { triggered: boolean; resolved: boolean; timedOut: boolean; reason?: string } } {
    narrate(this.deps.parentLog, 'browser/exit', { url, reason: aborted ? 'aborted' : status, durationMs: Date.now() - startedAt })
    return { url, title, status, ...(hitl ? { hitl } : {}) }
  }

  /** browser_read：读取当前页（provenance 四件套 + redact + 256KB 截断；内容不进链） */
  async read(): Promise<BrowserReadResult> {
    const conn = await this.ensureConn()
    const fetchedAt = new Date().toISOString()
    const frame = await conn.send('Runtime.evaluate', {
      expression:
        'JSON.stringify({url: location.href, title: document.title ?? null, text: document.body?.innerText ?? null, links: document.links ? document.links.length : null})',
      returnByValue: true,
    })
    const resultVal = (frame['result'] as { value?: string } | undefined)?.value
    if (!resultVal) throw new Error('CAR-E-BROWSER-READ: 页面读取为空（evaluate 无返回——页面态异常）')
    const parsed = JSON.parse(resultVal) as { url?: string; title?: string | null; text?: string | null; links?: number | null }
    const missing: string[] = []
    if (!parsed.url) missing.push('url')
    if (parsed.text == null) missing.push('正文')
    if (parsed.title == null) missing.push('title')
    const raw = parsed.text ?? ''
    const truncated = raw.length > BROWSER_TEXT_CAP
    const content = redact(truncated ? raw.slice(0, BROWSER_TEXT_CAP) : raw).redacted
    narrate(this.deps.parentLog, 'browser/read', { url: parsed.url ?? '(未知)', chars: content.length, truncated })
    return {
      url: parsed.url ?? '(未知)',
      fetchedAt,
      sortNote: '按 DOM 顺序原文（innerText）',
      missing,
      title: parsed.title ?? null,
      content,
      truncated,
      linksCount: parsed.links ?? 0,
    }
  }
}
