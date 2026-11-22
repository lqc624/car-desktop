/**
 * car-browser-mcp · 紧凑 CDP 驱动（B-3 / 提案 §4.4 模块 D——BrowserTaskManager 能力的 stdio
 * MCP 封装；零传递依赖，唯一 dep = @lqc123qwe/car-runtime〔redact〕）
 *
 * 口径与漂移登记：
 *  - 本驱动 = car-desktop/src/host-core/browserTasks.ts 的 CDP 面紧凑复刻（陪伴形态：经
 *    /json/list title 过滤发现桌面受控窗口「CAR 受控浏览器」——须桌面受控窗口在场；
 *    browser-target.json 主路径不依赖）。**漂移风险登记**：act 的 React 实例层原生 setter
 *    配方为 B-2 实证配方复制——browserTasks 侧变更时本文件须同步（两文件头注互指）；
 *  - **授权责任上移宿主**（README 明示）：本 server 运行在消费方宿主的授权门内（桌面
 *    mcp_* 门 / 平台 McpGateway / 第三方客户端策略）——server 自身无人审/网络轴/grant 面，
 *    只继承 fail-visible 护栏（导航 ≤100 / CDP 连接 5s / 导航 15s / act 等待 10s / 256KB 截断
 *    / redact 脱敏）；
 *  - HITL：桌面钩子面（emitHitl 推送/接管卡）在独立进程不存在——确定性特征命中即回
 *    hitl 报告（status:'hitl-detected'，不等 300s——兼容消费端 30s 超时 / BD-02 崩溃隔离）；
 *  - 工具面 v1 = browser_open / browser_read / browser_act（browser_shot 不入 MCP 面 v1：
 *    截图验收流是桌面宿主原生工作流，MCP 形态取数导向——登记后续再议）。
 */
import { readFileSync } from 'node:fs'
import { redact } from '@lqc123qwe/car-runtime'

export const BROWSER_CDP_PORT = 9333
export const BROWSER_NAV_MAX = 100
export const BROWSER_TEXT_CAP = 256 * 1024
export const BROWSER_CONNECT_TIMEOUT_MS = 5_000
export const BROWSER_NAV_TIMEOUT_MS = 15_000
export const BROWSER_ACT_WAIT_MAX_MS = 10_000
export const BROWSER_ACT_NAV_TIMEOUT_MS = 8_000
/** 受控窗口标记（/json/list title 过滤——与桌面 BROWSER_TARGET_TITLE 同值） */
export const BROWSER_TARGET_TITLE = 'CAR 受控浏览器'

export type BrowserActAction = 'click' | 'type' | 'select' | 'scroll' | 'wait'

export interface BrowserOpenResult {
  url: string
  title: string | null
  status: 'loaded' | 'timeout' | 'hitl-detected'
  hitl?: { triggered: boolean; resolved: false; timedOut: false; reason: string }
  sourceNote: string
}

export interface BrowserReadResult {
  /** provenance 四件套（缺一标缺失禁补全——桌面 T-B7 同口径） */
  url: string
  fetchedAt: string
  sortNote: string
  missing: string[]
  title: string | null
  content: string
  truncated: boolean
  linksCount: number
}

export interface BrowserActResult {
  action: BrowserActAction
  status: 'done' | 'timeout' | 'hitl-detected'
  url: string | null
  hitl?: { triggered: boolean; resolved: false; timedOut: false; reason: string }
  sourceNote: string
}

interface CdpConn {
  send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>
  waitEvent(method: string, timeoutMs: number): Promise<Record<string, unknown>>
  close(): void
}

export interface DriverDeps {
  cdpPort?: number
  targetTitle?: string
  /** 发现文件主路径（userData/browser-target.json——main 进程经 debugger.getTargetInfo 写入，
   *  targetId 跨导航稳定；桌面陪伴形态挂载传 --target-file 对齐桌面 findTarget 双路径） */
  targetFile?: string
  fetchImpl?: typeof fetch
  wsFactory?: (url: string) => Promise<WebSocket>
  connectTimeoutMs?: number
}

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

/** HITL 确定性特征探测（URL 特征 + DOM 探测——与桌面 detectHitl 同款，非 LLM 判断） */
const HITL_PROBE_EXPR =
  `JSON.stringify({url: location.href, pwd: !!document.querySelector('input[type=password]'), ` +
  `captcha: !!document.querySelector('iframe[src*="captcha"],iframe[src*="recaptcha"],iframe[title*="captcha"],[class*="captcha" i],[id*="captcha" i],[class*="geetest"],[class*="slider" i]'), ` +
  `qr: !!document.querySelector('img[alt*="二维码"],img[alt*="扫码"],[class*="qrcode" i],[id*="qrcode" i]')})`

export class BrowserMcpDriver {
  private navCount = 0
  private conn: CdpConn | null = null
  private readonly cdpPort: number
  private readonly targetTitle: string
  private readonly targetFile: string | null
  private readonly fetchImpl: typeof fetch
  private readonly wsFactory: (url: string) => Promise<WebSocket>
  private readonly connectTimeoutMs: number

  constructor(deps: DriverDeps = {}) {
    this.cdpPort = deps.cdpPort ?? BROWSER_CDP_PORT
    this.targetTitle = deps.targetTitle ?? BROWSER_TARGET_TITLE
    this.targetFile = deps.targetFile ?? null
    this.fetchImpl = deps.fetchImpl ?? fetch
    this.wsFactory = deps.wsFactory ?? (async (url) => new WebSocket(url))
    this.connectTimeoutMs = deps.connectTimeoutMs ?? BROWSER_CONNECT_TIMEOUT_MS
  }

  close(): void {
    this.conn?.close()
    this.conn = null
  }

  private async findTarget(): Promise<string> {
    const t0 = Date.now()
    let lastErr = 'unknown'
    while (Date.now() - t0 < this.connectTimeoutMs) {
      // ① 发现文件主路径（userData/browser-target.json——targetId 跨导航稳定；
      //    **B-3 终验探针实证：/json/list title = document.title 而非窗口 title**，
      //    有标题页面下 title 过滤必 miss——主路径与桌面 findTarget 双路径对齐）
      if (this.targetFile) {
        try {
          const disc = JSON.parse(readFileSync(this.targetFile, 'utf8')) as { targetId?: string; cdpPort?: number }
          if (disc.targetId) {
            const port = disc.cdpPort ?? this.cdpPort
            return `ws://127.0.0.1:${port}/devtools/page/${disc.targetId}`
          }
        } catch { /* 文件缺失/损坏 → 兜底路径 */ }
      }
      // ② /json/list title 兜底（无标题页面/直连形态——title 语义局限登记见上）
      try {
        const list = (await (await this.fetchImpl(`http://127.0.0.1:${this.cdpPort}/json/list`)).json()) as Array<{
          title?: string
          webSocketDebuggerUrl?: string
        }>
        const target = list.find((t) => t.title === this.targetTitle && t.webSocketDebuggerUrl)
        if (target) return target.webSocketDebuggerUrl!
        lastErr = `targets=${list.length}（无「${this.targetTitle}」标记窗口${this.targetFile ? '、发现文件无效' : ''}）`
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e)
      }
      await new Promise((r) => setTimeout(r, 300))
    }
    throw new Error(
      `CAR-E-BROWSER-TARGET: 受控浏览器窗口未发现（CDP 127.0.0.1:${this.cdpPort}，${this.connectTimeoutMs}ms）——` +
        `car-browser-mcp 为陪伴形态：须桌面受控窗口在场（建议挂载传 --target-file <userData>/browser-target.json；${lastErr}）`,
    )
  }

  private async ensureConn(): Promise<CdpConn> {
    if (this.conn) return this.conn
    const wsUrl = await this.findTarget()
    const ws = await this.wsFactory(wsUrl)
    await new Promise<void>((res, rej) => {
      if (ws.readyState === ws.OPEN) return res()
      const openTimer = setTimeout(() => rej(new Error(`CAR-E-BROWSER-CDP: WebSocket 连接超时（${this.connectTimeoutMs}ms）`)), this.connectTimeoutMs)
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
    const conn: CdpConn = {
      send: (method, params = {}) =>
        new Promise((resolve, reject) => {
          const id = ++msgId
          waiting.set(id, { resolve, reject })
          ws.send(JSON.stringify({ id, method, params }))
        }),
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
        try {
          ws.close()
        } catch {
          /* 收口容错 */
        }
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

  /** HITL 特征探测（命中即报告不等——独立进程无接管卡面，README 口径） */
  private async detectHitl(conn: CdpConn): Promise<{ hit: boolean; url: string; reason: string }> {
    const frame = await conn.send('Runtime.evaluate', { expression: HITL_PROBE_EXPR, returnByValue: true })
    const p = parseEvaluateValue<{ url?: string; pwd?: boolean; captcha?: boolean; qr?: boolean }>((frame['result'] as { value?: unknown } | undefined)?.value)
    if (!p) return { hit: false, url: '', reason: '' }
    const url = p.url ?? ''
    const urlHit = /\/(login|signin|sign-in|signup|auth|oauth|sso|verify|captcha|mfa|2fa)\b/i.test(url.toLowerCase())
    const reason = p.pwd ? 'password 输入框（登录页特征）' : p.captcha ? '验证码/滑块特征' : p.qr ? '扫码特征' : urlHit ? 'URL 登录/验证特征' : ''
    return { hit: Boolean(p.pwd || p.captcha || p.qr || urlHit), url, reason }
  }

  async open(rawUrl: string): Promise<BrowserOpenResult> {
    const url = rawUrl.trim()
    if (!/^https?:\/\//i.test(url)) throw new Error('CAR-E-BROWSER-ARGS: url 须为 http/https（fail-visible）')
    if (this.navCount >= BROWSER_NAV_MAX) {
      throw new Error(`CAR-E-BROWSER-NAV: 单会话导航次数已达上限（${BROWSER_NAV_MAX}）——fail-visible 不静默限流`)
    }
    this.navCount++
    const conn = await this.ensureConn()
    try {
      await conn.send('Page.navigate', { url })
      let status: BrowserOpenResult['status'] = 'timeout'
      try {
        await conn.waitEvent('Page.loadEventFired', BROWSER_NAV_TIMEOUT_MS)
        status = 'loaded'
      } catch {
        // 超时显式（不静默成功）
      }
      const frame = await conn.send('Runtime.evaluate', { expression: '({url: location.href, title: document.title})', returnByValue: true })
      const val = frame['result'] as { value?: { url?: string; title?: string } } | undefined
      const finalUrl = val?.value?.url ?? url
      const title = val?.value?.title ?? null
      const det = await this.detectHitl(conn)
      if (det.hit) {
        return {
          url: det.url || finalUrl,
          title,
          status: 'hitl-detected',
          hitl: { triggered: true, resolved: false, timedOut: false, reason: det.reason },
          sourceNote: '页面抄录（受控浏览器实取——与模型生成分列，N-B1 纪律）',
        }
      }
      return { url: finalUrl, title, status, sourceNote: '页面抄录（受控浏览器实取——与模型生成分列，N-B1 纪律）' }
    } catch (e) {
      this.dropConn()
      throw e
    }
  }

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

  /** act 目标解析（与桌面 resolveTarget 同款表达式——漂移登记面） */
  private async resolveTarget(conn: CdpConn, selector: string, text: string): Promise<{ x: number; y: number; tag: string; href: string | null } | null> {
    const selLit = JSON.stringify(selector)
    const textLit = JSON.stringify(text)
    const expr =
      selector.trim().length > 0
        ? `JSON.stringify((() => { const el = document.querySelector(${selLit}); if (!el) return null; el.scrollIntoView({block:'center'}); const r = el.getBoundingClientRect(); return {x: r.x + r.width/2, y: r.y + r.height/2, tag: el.tagName, href: el.href || null} })())`
        : `JSON.stringify((() => { const els = [...document.querySelectorAll('button,a,[role=button],input[type=submit],input[type=button],label,span,div')]; const el = els.find(e => (e.innerText||'').trim().includes(${textLit}) && e.offsetParent !== null); if (!el) return null; el.scrollIntoView({block:'center'}); const r = el.getBoundingClientRect(); return {x: r.x + r.width/2, y: r.y + r.height/2, tag: el.tagName, href: el.href || null} })())`
    const frame = await conn.send('Runtime.evaluate', { expression: expr, returnByValue: true })
    return parseEvaluateValue<{ x: number; y: number; tag: string; href: string | null }>((frame['result'] as { value?: unknown } | undefined)?.value)
  }

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
    if (action === 'click' && this.navCount >= BROWSER_NAV_MAX) {
      throw new Error(`CAR-E-BROWSER-NAV: 单会话导航次数已达上限（${BROWSER_NAV_MAX}）——fail-visible 不静默限流`)
    }
    const conn = await this.ensureConn()
    try {
      let target: { x: number; y: number; tag: string; href: string | null } | null = null
      if (action === 'click' || action === 'type' || action === 'select') {
        target = await this.resolveTarget(conn, selector, text)
        if (!target) throw new Error(`CAR-E-BROWSER-ARGS: 目标未找到（${selector || text}——先 browser_read 定位）`)
      }
      let status: BrowserActResult['status'] = 'done'
      let navigated = false
      if (action === 'click') {
        await conn.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: target!.x, y: target!.y, button: 'left', clickCount: 1 })
        await conn.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target!.x, y: target!.y, button: 'left', clickCount: 1 })
        try {
          await conn.waitEvent('Page.loadEventFired', BROWSER_ACT_NAV_TIMEOUT_MS)
          navigated = true
          this.navCount++
        } catch {
          /* 未导航 = 正常态 */
        }
      } else if (action === 'type' || action === 'select') {
        // React 实例层原生 setter 配方（B-2 实证——原型层补丁会让「原型 setter 取用」失效：
        // 取 Object.getPrototypeOf(el) 的 value 描述符；漂移登记面——与桌面 browserTasks 同步）
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
      if (action === 'click') {
        const frame = await conn.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true })
        const finalUrl = String((frame['result'] as { value?: unknown } | undefined)?.value ?? '')
        const det = await this.detectHitl(conn)
        if (det.hit) {
          return {
            action,
            status: 'hitl-detected',
            url: det.url || finalUrl || null,
            hitl: { triggered: true, resolved: false, timedOut: false, reason: det.reason },
            sourceNote: '页面抄录（受控浏览器实取——与模型生成分列，N-B1 纪律）',
          }
        }
        return { action, status, url: finalUrl || null, sourceNote: '页面抄录（受控浏览器实取——与模型生成分列，N-B1 纪律）' }
      }
      return { action, status, url: null, sourceNote: '页面抄录（受控浏览器实取——与模型生成分列，N-B1 纪律）' }
    } catch (e) {
      if (e instanceof Error && /CAR-E-BROWSER-(ARGS|NAV)/.test(e.message)) throw e
      this.dropConn()
      throw e
    }
  }
}
