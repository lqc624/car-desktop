/**
 * C3-B1 · 受控浏览器工具面（提案模块 A+B 最小环——宿主侧组合，内核零加法；BashTaskManager 同款）
 *
 * 口径（《浏览器操控借鉴与架构设计提案》Q-B1~B5 已裁决）：
 *  - **CDP over loopback**（Q-B2）：受控 BrowserWindow 由 main 进程创建（title='CAR 受控浏览器'
 *    作 target 标记），本面经 127.0.0.1:9333 /json/list 发现 + WebSocket 直驱——驱动代码与
 *    Electron API 解耦（tools/cdp/cdp.mjs 手法，零依赖 fetch+WebSocket）；
 *  - **首版仅前台原子工具**（提案 §4.2）：browser_open（导航，readonly + 网络轴）/ browser_read
 *    （读取，readonly）；browser_act/高危确认门/HITL 接管 = B-2 不在本面；多页遍历由 Agent 循环
 *    逐步调用（每步落链 = 审计粒度）；
 *  - **落链叙事 = 父链 system kind + payload.type**（EventKind 零新增，bash/* 同款先例）：
 *    `browser/start {url}` / `browser/exit {url, reason, durationMs}` / `browser/read {url,
 *    chars, truncated}`——**页面内容不进链**（可能含密钥/超量，bash 输出同纪律）；
 *  - **provenance 四件套强制**（T-B7）：browser_read 返回 {url, fetchedAt, sortNote, missing}
 *    ——缺一标缺失而非补全（fail-visible）；内容过内核 redact() + 256KB 截断（fs_read 纪律）；
 *  - **网络轴**（Q-B3）：browser_open 目标 url 过 fileSecurity.decideNetwork——判定在
 *    session-handle.authorize ⓪″（capability 分派 browser_* = 'mcp' 同口径：readonly 声明 +
 *    网络轴，与远程 MCP 工具同款）；白名单外首次人审 + 会话 grant 缓存（现行授权编排承接）；
 *  - **护栏 fail-visible**：单会话导航 ≤100（CAR-E-BROWSER-NAV）/ CDP 连接 5s / 导航 15s 超时 /
 *    读取内容 256KB 截断显式标注；
 *  - **partition**：'persist:car-browser'（Q-B4 按 CAR 账号分片——账号体系接入后扩展分片键，登记）；
 *  - **生命周期**：窗口 = main 进程创建（宿主启动时、设置启用态）；宿主退出销毁窗口、partition
 *    落盘保留（登录态持久复用 T-B2）；本面无后台句柄（browser_task_stop = P2）。
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
/** main 进程受控窗口标记（/json/list title 过滤——零耦合发现） */
export const BROWSER_TARGET_TITLE = 'CAR 受控浏览器'

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

export class BrowserTasks {
  private navCount = 0
  private conn: CdpConn | null = null
  private readonly fetchImpl: typeof fetch
  private readonly wsFactory: (url: string) => Promise<WebSocket>
  private readonly cdpPort: number

  constructor(private readonly deps: BrowserManagerDeps) {
    this.cdpPort = deps.cdpPort ?? BROWSER_CDP_PORT
    this.fetchImpl = deps.fetchImpl ?? fetch
    this.wsFactory = deps.wsFactory ?? (async (url) => new WebSocket(url))
  }

  tools(): HostToolDef[] {
    return [this.openTool(), this.readTool()]
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
    while (Date.now() - t0 < BROWSER_CONNECT_TIMEOUT_MS) {
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
      `CAR-E-BROWSER-TARGET: 受控浏览器窗口未发现（CDP 127.0.0.1:${this.cdpPort}，${BROWSER_CONNECT_TIMEOUT_MS}ms）——` +
        `检查：设置已启用浏览器操控且宿主重启生效、受控窗口未被关闭（${lastErr}）`,
    )
  }

  private async ensureConn(): Promise<CdpConn> {
    if (this.conn) return this.conn
    const target = await this.findTarget()
    const ws = await this.wsFactory(target.webSocketDebuggerUrl)
    await new Promise<void>((res, rej) => {
      if (ws.readyState === ws.OPEN) return res()
      ws.onopen = () => res()
      ws.onerror = () => rej(new Error('CAR-E-BROWSER-CDP: WebSocket 连接失败'))
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

  // ── 工具定义（B-1 两件——browser_act/task_stop = B-2/P2 不在本面） ──────────

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

  // ── 工具运行面 ─────────────────────────────────────────────────────────

  /** browser_open：导航（browser/start → Page.navigate → loadEventFired → browser/exit） */
  async open(rawUrl: string): Promise<{ url: string; title: string | null; status: 'loaded' | 'timeout' }> {
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
      conn = await this.ensureConn()
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
      const finalUrl = val?.value?.url ?? url
      narrate(this.deps.parentLog, 'browser/exit', { url: finalUrl, reason: status, durationMs: Date.now() - startedAt })
      return { url: finalUrl, title: val?.value?.title ?? null, status }
    } catch (e) {
      narrate(this.deps.parentLog, 'browser/exit', { url, reason: 'error', durationMs: Date.now() - startedAt })
      this.dropConn() // 连接面异常（ws 断开等）——下次调用重连
      throw e
    }
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
