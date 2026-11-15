/**
 * s-browser · C3-B1 受控浏览器工具面（browserTasks——提案模块 B 最小环）
 *
 * 判据（host-core/browserTasks.ts + browserStore.ts）：
 *  - 工具面形态：browser_open/browser_read 均 readonly（Q-B3）+ parameters 契约；
 *  - browser_open 全链（假 CDP）：url 校验 fail-visible / browser/start+exit 叙事 / loadEventFired
 *    等待 / 导航护栏 CAR-E-BROWSER-NAV（fail-visible 不静默限流）；
 *  - browser_read：provenance 四件套（url/fetchedAt/sortNote/missing——缺一标缺失禁补全）/
 *    内容过内核 redact（密钥面不进读取面）/ 256KB 截断显式标注 / 内容不进链（叙事仅元数据）；
 *  - target 发现双路径：发现文件主路径（targetId → ws url）+ /json/list title 兜底；
 *  - browserStore：出厂缺省关（D-V10-2）+ 持久化。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserTasks, BROWSER_NAV_MAX, BROWSER_TARGET_TITLE, type BrowserManagerDeps } from '../src/host-core/browserTasks.ts'
import { createBrowserStore } from '../src/host-core/browserStore.ts'
import type { SessionLog } from '@lqc123qwe/car-runtime'

// ── 假 CDP（ws 面注入 + http /json 面注入） ─────────────────────────────────

/** 假 WebSocket：send 按方法分派处理器；waitEvent 靠 test 侧 emit */
class FakeWS {
  static OPEN = 1
  readyState = 1
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  sent: Array<{ id: number; method: string; params: Record<string, unknown> }> = []
  private seq = 0
  constructor(private handlers: (method: string, params: Record<string, unknown>) => void) {}
  send(raw: string): void {
    const msg = JSON.parse(raw) as { id: number; method: string; params: Record<string, unknown> }
    this.sent.push(msg)
    setTimeout(() => this.handlers(msg.method, msg.params), 0)
  }
  reply(id: number, result: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify({ id, result }) })
  }
  emit(method: string, params: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify({ method, params }) })
  }
  close(): void {}
}

function makeDeps(opts: {
  parentLog: SessionLog
  userDataDir: string
  evaluateValue: unknown
  navEvent?: boolean
  targets?: Array<{ title?: string; webSocketDebuggerUrl?: string; url?: string }>
  /** B-2：按表达式内容分派 evaluate 返回（HITL 探测 / resolveTarget / location.href 分形响应） */
  evaluateByProbe?: (expression: string) => unknown
  /** B-2：Input.dispatchMouseEvent(mouseReleased) 后是否发 Page.loadEventFired（act 导航观测） */
  actNav?: boolean
  /** B-2 注入缝：超时/轮询提速（缺省生产常量） */
  hitlPollMs?: number
  hitlTimeoutMs?: number
  connectTimeoutMs?: number
}): { deps: BrowserManagerDeps; wsQueue: FakeWS[] } {
  const wsQueue: FakeWS[] = []
  const deps: BrowserManagerDeps = {
    parentLog: opts.parentLog,
    userDataDir: opts.userDataDir,
    ...(opts.hitlPollMs !== undefined ? { hitlPollMs: opts.hitlPollMs } : {}),
    ...(opts.hitlTimeoutMs !== undefined ? { hitlTimeoutMs: opts.hitlTimeoutMs } : {}),
    ...(opts.connectTimeoutMs !== undefined ? { connectTimeoutMs: opts.connectTimeoutMs } : {}),
    fetchImpl: (async (url: string | URL) => {
      void url
      return {
        json: async () => opts.targets ?? [{ title: BROWSER_TARGET_TITLE, webSocketDebuggerUrl: 'ws://fake/target', url: 'about:blank' }],
      }
    }) as unknown as typeof fetch,
    wsFactory: async () => {
      const ws = new FakeWS((method, params) => {
        const id = ws.sent[ws.sent.length - 1]!.id
        if (method === 'Runtime.enable' || method === 'Page.enable') ws.reply(id, {})
        else if (method === 'Page.navigate') {
          ws.reply(id, { frameId: 'f1' })
          if (opts.navEvent !== false) setTimeout(() => ws.emit('Page.loadEventFired', {}), 5)
        } else if (method === 'Input.dispatchMouseEvent') {
          ws.reply(id, {})
          if (String(params['type']) === 'mouseReleased' && opts.actNav === true) setTimeout(() => ws.emit('Page.loadEventFired', {}), 5)
        } else if (method === 'Runtime.evaluate') {
          ws.reply(id, { result: { value: opts.evaluateByProbe ? opts.evaluateByProbe(String(params['expression'])) : opts.evaluateValue } })
        } else ws.reply(id, {})
      })
      wsQueue.push(ws)
      setTimeout(() => ws.onopen?.(), 0)
      return ws as unknown as WebSocket
    },
  }
  return { deps, wsQueue }
}

/** 极简 SessionLog 桩（叙事面只验证 payload.type 序列——真链语义由内核 spec 守护） */
function fakeLog(): SessionLog & { narratives: Array<{ type: string; extra: Record<string, unknown> }> } {
  const narratives: Array<{ type: string; extra: Record<string, unknown> }> = []
  return {
    narratives,
    append(_actor: unknown, kind: unknown, _turnId: unknown, payload: unknown) {
      if (kind === 'system' && payload && typeof payload === 'object') {
        const p = payload as Record<string, unknown>
        const { type, ...extra } = p
        narratives.push({ type: String(type), extra })
      }
      return { seq: narratives.length }
    },
  } as unknown as SessionLog & { narratives: Array<{ type: string; extra: Record<string, unknown> }> }
}

test('s-browser: 工具面形态——open/read readonly（Q-B3）+ act write（B-2）+ 契约参数', () => {
  const dir = mkdtempSync(join(tmpdir(), 's-browser-'))
  try {
    const { deps } = makeDeps({ parentLog: fakeLog(), userDataDir: dir, evaluateValue: '{}' })
    const tools = new BrowserTasks(deps).tools()
    assert.deepEqual(tools.map((t) => t.name), ['browser_open', 'browser_read', 'browser_act'], 'B-2 三件（task_stop = P2/B-3 缓行登记）')
    assert.equal(tools[0]!.declaredSideEffect, 'readonly')
    assert.equal(tools[1]!.declaredSideEffect, 'readonly')
    assert.equal(tools[2]!.declaredSideEffect, 'write', 'browser_act = write 声明（T-22 缺省 write 语义位）')
    assert.equal(tools[1]!.parameters && (tools[1]!.parameters as { properties: Record<string, unknown> }).properties && Object.keys((tools[1]!.parameters as { properties: Record<string, unknown> }).properties).length, 0, 'browser_read 无参')
    const actParams = (tools[2]!.parameters as { properties: Record<string, unknown> }).properties
    assert.deepEqual((actParams['action'] as { enum?: string[] }).enum, ['click', 'type', 'select', 'scroll', 'wait'], '动作枚举契约（§4.2）')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('s-browser: browser_open 全链——url 校验 / browser/start+exit 叙事 / 返回 final url+title', async () => {
  const log = fakeLog()
  const dir = mkdtempSync(join(tmpdir(), 's-browser-'))
  try {
    const { deps } = makeDeps({ parentLog: log, userDataDir: dir, evaluateValue: { url: 'https://example.com/final', title: 'Example' } })
    const tools = new BrowserTasks(deps).tools()
    const open = tools[0]!.run
    // url 校验 fail-visible
    await assert.rejects(() => open({ url: 'ftp://x' }), /CAR-E-BROWSER-ARGS/)
    // 全链
    const r = (await open({ url: 'https://example.com' })) as { url: string; title: string; status: string }
    assert.equal(r.url, 'https://example.com/final')
    assert.equal(r.title, 'Example')
    assert.equal(r.status, 'loaded')
    const types = log.narratives.map((n) => n.type)
    assert.deepEqual(types, ['browser/start', 'browser/exit'], 'browser/start → browser/exit 叙事（EventKind 零新增）')
    assert.equal(log.narratives[0]!.extra['url'], 'https://example.com')
    assert.equal(log.narratives[1]!.extra['reason'], 'loaded')
    assert.ok(typeof log.narratives[1]!.extra['durationMs'] === 'number')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('s-browser: 导航护栏——CAR-E-BROWSER-NAV fail-visible 不静默限流', async () => {
  const log = fakeLog()
  const dir = mkdtempSync(join(tmpdir(), 's-browser-'))
  try {
    const { deps } = makeDeps({ parentLog: log, userDataDir: dir, evaluateValue: '{}' })
    const tools = new BrowserTasks(deps).tools()
    const open = tools[0]!.run
    for (let i = 0; i < BROWSER_NAV_MAX; i++) await open({ url: 'https://example.com' })
    await assert.rejects(() => open({ url: 'https://example.com' }), /CAR-E-BROWSER-NAV/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('s-browser: browser_read——provenance 四件套 + redact 密钥面 + 截断标注 + 内容零进链', async () => {
  const log = fakeLog()
  const dir = mkdtempSync(join(tmpdir(), 's-browser-'))
  try {
    const credCanary = 'sk-live-abc123def456ghi789'
    const { deps } = makeDeps({
      parentLog: log,
      userDataDir: dir,
      evaluateValue: JSON.stringify({ url: 'https://example.com', title: 'T', text: `正文含 ${credCanary} 密钥`, links: 3 }),
    })
    const tools = new BrowserTasks(deps).tools()
    const r = (await tools[1]!.run({})) as { url: string; fetchedAt: string; sortNote: string; missing: unknown[]; content: string; truncated: boolean; linksCount: number }
    // provenance 四件套
    assert.equal(r.url, 'https://example.com')
    assert.match(r.fetchedAt, /^\d{4}-\d{2}-\d{2}T/)
    assert.ok(r.sortNote.length > 0)
    assert.deepEqual(r.missing, [], '全字段在位 = missing 空')
    // redact：密钥原文不进读取面
    assert.ok(!r.content.includes(credCanary), '密钥原文零泄漏（redact 管线）')
    assert.ok(r.content.includes('正文含'), '非密钥内容保留')
    assert.equal(r.truncated, false)
    assert.equal(r.linksCount, 3)
    // 内容不进链：叙事仅元数据（chars/truncated）
    const readN = log.narratives.find((n) => n.type === 'browser/read')!
    assert.ok(readN, 'browser/read 叙事在案')
    assert.equal(readN.extra['chars'], r.content.length)
    assert.equal(readN.extra['truncated'], false)
    assert.ok(!JSON.stringify(log.narratives).includes(credCanary), '密钥不进任何叙事')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('s-browser: browser_read 缺失字段——missing 显式标注禁补全 + 超长截断', async () => {
  const log = fakeLog()
  const dir = mkdtempSync(join(tmpdir(), 's-browser-'))
  try {
    const longText = 'x'.repeat(256 * 1024 + 10)
    const { deps } = makeDeps({
      parentLog: log,
      userDataDir: dir,
      evaluateValue: JSON.stringify({ url: null, title: null, text: longText, links: null }),
    })
    const tools = new BrowserTasks(deps).tools()
    const r = (await tools[1]!.run({})) as { missing: string[]; truncated: boolean; url: string; content: string }
    assert.ok(r.missing.includes('url'), 'url 缺失显式标注（禁补全）')
    assert.ok(r.missing.includes('title'))
    assert.equal(r.url, '(未知)')
    assert.equal(r.truncated, true, '256KB 截断显式标注')
    assert.ok(r.content.length <= 256 * 1024)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('s-browser: target 发现双路径——发现文件主路径（targetId → ws url）+ title 兜底', async () => {
  const log = fakeLog()
  const dir = mkdtempSync(join(tmpdir(), 's-browser-disc-'))
  try {
    // ① 发现文件主路径：wsFactory 收到 ws://127.0.0.1:9333/devtools/page/<targetId>
    writeFileSync(join(dir, 'browser-target.json'), JSON.stringify({ targetId: 'ABC123', cdpPort: 9333 }), 'utf8')
    const { deps, wsQueue } = makeDeps({ parentLog: log, userDataDir: dir, evaluateValue: '{}', targets: [] }) // /json 空——仅文件路径可达
    const tools = new BrowserTasks(deps).tools()
    await tools[0]!.run({ url: 'https://example.com' })
    assert.ok(wsQueue[0]!.sent.some((s) => s.method === 'Page.navigate'), '经发现文件 ws url 连接成功（/json 空不阻塞）')
    // ② 兜底路径：无发现文件 → /json title 过滤
    const dir2 = mkdtempSync(join(tmpdir(), 's-browser-disc2-'))
    try {
      const { deps: deps2, wsQueue: q2 } = makeDeps({ parentLog: log, userDataDir: dir2, evaluateValue: '{}' })
      const tools2 = new BrowserTasks(deps2).tools()
      await tools2[0]!.run({ url: 'https://example.com' })
      assert.ok(q2[0]!.sent.some((s) => s.method === 'Page.navigate'), 'title 兜底路径可达')
    } finally {
      rmSync(dir2, { recursive: true, force: true })
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('s-browser: browserStore——出厂缺省关（D-V10-2）+ set 持久化 + 损坏回退出厂', () => {
  const dir = mkdtempSync(join(tmpdir(), 's-browser-store-'))
  try {
    mkdirSync(dir, { recursive: true })
    const store = createBrowserStore(dir)
    assert.equal(store.get().browserEnabled, false, '出厂缺省关（D-V10-2 / T-B5）')
    store.set({ browserEnabled: true })
    assert.equal(store.get().browserEnabled, true)
    assert.equal(createBrowserStore(dir).get().browserEnabled, true, '持久化生效')
    writeFileSync(join(dir, 'browser-settings.json'), '{broken', 'utf8')
    const store3 = createBrowserStore(dir)
    assert.equal(store3.get().browserEnabled, false, '损坏回退出厂（不 fail-open）')
    assert.match(readFileSync(join(dir, 'browser-settings.json'), 'utf8'), /"browserEnabled": false/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ==================== B-2：classifyActRisk / act 运行面 / 网络轴双检 / HITL / 窗口重建 ====================

import { classifyActRisk } from '../src/host-core/browserTasks.ts'

test('s-browser: classifyActRisk 确定性词表——click 高危语义命中 / 非 click / 低危不命中', () => {
  assert.equal(classifyActRisk({ action: 'click', text: '提交订单' }), true, '提交类命中')
  assert.equal(classifyActRisk({ action: 'click', selector: 'button[type=submit]' }), true, 'submit 选择器命中')
  assert.equal(classifyActRisk({ action: 'click', text: 'Pay now' }), true, '支付类命中')
  assert.equal(classifyActRisk({ action: 'click', text: '下一页' }), false, '低危不命中')
  assert.equal(classifyActRisk({ action: 'type', selector: 'input[name=pay]', value: 'x' }), false, '非 click 不判高危（登记局限：词表只看 click）')
  assert.equal(classifyActRisk({}), false)
})

test('s-browser: browser_act click（text 匹配）——真输入管线 + browser/act 叙事 + sourceNote 分层标注', async () => {
  const log = fakeLog()
  const dir = mkdtempSync(join(tmpdir(), 's-browser-act-'))
  try {
    const { deps, wsQueue } = makeDeps({
      parentLog: log,
      userDataDir: dir,
      evaluateValue: null,
      evaluateByProbe: (expr) => {
        if (expr.includes('getBoundingClientRect')) return JSON.stringify({ x: 100, y: 200, tag: 'BUTTON', href: null, text: '提交订单' })
        if (expr.trim() === 'location.href') return 'https://example.com/page'
        if (expr.includes('input[type=password]')) return JSON.stringify({ url: 'https://example.com/page', pwd: false, captcha: false, qr: false })
        return null
      },
    })
    const tools = new BrowserTasks(deps).tools()
    const r = (await tools[2]!.run({ action: 'click', text: '提交订单' })) as { action: string; status: string; url: string; sourceNote: string }
    assert.equal(r.action, 'click')
    assert.equal(r.status, 'done')
    assert.equal(r.url, 'https://example.com/page')
    assert.match(r.sourceNote, /页面抄录/, 'D-B2-8 内容注入分层标注（N-B1 纪律）')
    const mouse = wsQueue[0]!.sent.filter((s) => s.method === 'Input.dispatchMouseEvent')
    assert.equal(mouse.length, 2, 'mousePressed + mouseReleased（真输入管线）')
    assert.equal(mouse[0]!.params['x'], 100)
    const narr = log.narratives.find((n) => n.type === 'browser/act')!
    assert.ok(narr, 'browser/act 叙事在案')
    assert.equal(narr.extra['action'], 'click')
    assert.equal(narr.extra['status'], 'done')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('s-browser: act 网络轴 pre 检——锚点 href 判拒 → CAR-E-BROWSER-NET 且不点击', async () => {
  const log = fakeLog()
  const dir = mkdtempSync(join(tmpdir(), 's-browser-net-'))
  try {
    const { deps, wsQueue } = makeDeps({
      parentLog: log,
      userDataDir: dir,
      evaluateValue: null,
      evaluateByProbe: (expr) =>
        expr.includes('getBoundingClientRect') ? JSON.stringify({ x: 1, y: 2, tag: 'A', href: 'https://evil.example/x', text: '外链' }) : null,
    })
    const tasks = new BrowserTasks(deps)
    tasks.hooks({ browserNetGate: () => ({ tier: 'deny' }) })
    const tools = tasks.tools()
    await assert.rejects(() => tools[2]!.run({ action: 'click', selector: '#buy' }), /CAR-E-BROWSER-NET/)
    assert.ok(!wsQueue[0]!.sent.some((s) => s.method === 'Input.dispatchMouseEvent'), 'pre 检拒 = 不点击（防绕过）')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('s-browser: act 网络轴 post 检——导航后白名单外硬拒 fail-visible（导航已发生不可撤销登记）', async () => {
  const log = fakeLog()
  const dir = mkdtempSync(join(tmpdir(), 's-browser-net2-'))
  try {
    const { deps } = makeDeps({
      parentLog: log,
      userDataDir: dir,
      evaluateValue: null,
      actNav: true,
      evaluateByProbe: (expr) => {
        if (expr.includes('getBoundingClientRect')) return JSON.stringify({ x: 1, y: 2, tag: 'A', href: null, text: '跳转' })
        if (expr.trim() === 'location.href') return 'https://evil.example/landed'
        if (expr.includes('input[type=password]')) return JSON.stringify({ url: 'https://evil.example/landed', pwd: false, captcha: false, qr: false })
        return null
      },
    })
    const tasks = new BrowserTasks(deps)
    const seen: string[] = []
    tasks.hooks({
      browserNetGate: (_callId, url, phase) => {
        seen.push(phase)
        return phase === 'pre' ? { tier: 'deny' } : { tier: 'deny' }
      },
    })
    const tools = tasks.tools()
    await assert.rejects(() => tools[2]!.run({ action: 'click', text: '跳转' }), /post 检硬拒/)
    assert.ok(seen.includes('post'), 'post 相判定已执行')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('s-browser: HITL 接管协议——登录页特征 → browser/hitl 叙事 + 接管推送 + 特征消失 resume', async () => {
  const log = fakeLog()
  const dir = mkdtempSync(join(tmpdir(), 's-browser-hitl-'))
  try {
    let probeCount = 0
    const { deps } = makeDeps({
      parentLog: log,
      userDataDir: dir,
      evaluateValue: null,
      hitlPollMs: 20,
      evaluateByProbe: (expr) => {
        if (expr.startsWith('({url:')) return { url: 'https://x/login', title: '登录页' }
        if (expr.includes('input[type=password]')) {
          probeCount++
          return probeCount === 1
            ? JSON.stringify({ url: 'https://x/login', pwd: true, captcha: false, qr: false })
            : JSON.stringify({ url: 'https://x/home', pwd: false, captcha: false, qr: false })
        }
        return null
      },
    })
    const tasks = new BrowserTasks(deps)
    const hitlPushes: Array<{ phase: string; url?: string }> = []
    tasks.hooks({ emitHitl: (p) => hitlPushes.push(p) })
    const tools = tasks.tools()
    const r = (await tools[0]!.run({ url: 'https://x/login' })) as { url: string; status: string; hitl?: { triggered: boolean; resolved: boolean; timedOut: boolean; reason?: string } }
    assert.equal(r.hitl?.triggered, true, '登录页 password 特征命中')
    assert.equal(r.hitl?.resolved, true, '特征消失 = resolved（用户人工完成语义）')
    assert.equal(r.hitl?.timedOut, false)
    assert.match(r.hitl?.reason ?? '', /password/)
    const phases = log.narratives.filter((n) => n.type === 'browser/hitl').map((n) => String(n.extra['phase']))
    assert.deepEqual(phases, ['detect', 'resolved'], 'browser/hitl 两相叙事落链')
    assert.deepEqual(hitlPushes.map((p) => p.phase), ['detect', 'resolved'], '接管卡推送 detect 建 / resolved 收')
    assert.ok(hitlPushes[0]!.deadlineTs == null || typeof hitlPushes[0]!.deadlineTs === 'number')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('s-browser: HITL 超时——接管窗口耗尽 → hitl-timeout 形态 + timeout 叙事（不静默重试）', async () => {
  const log = fakeLog()
  const dir = mkdtempSync(join(tmpdir(), 's-browser-hitl2-'))
  try {
    const { deps } = makeDeps({
      parentLog: log,
      userDataDir: dir,
      evaluateValue: null,
      hitlPollMs: 20,
      hitlTimeoutMs: 80,
      evaluateByProbe: (expr) => {
        if (expr.startsWith('({url:')) return { url: 'https://x/captcha', title: '验证' }
        if (expr.includes('input[type=password]')) return JSON.stringify({ url: 'https://x/captcha', pwd: false, captcha: true, qr: false })
        return null
      },
    })
    const tasks = new BrowserTasks(deps)
    const hitlPushes: Array<{ phase: string }> = []
    tasks.hooks({ emitHitl: (p) => hitlPushes.push(p) })
    const tools = tasks.tools()
    const r = (await tools[0]!.run({ url: 'https://x/captcha' })) as { status: string; hitl?: { timedOut: boolean } }
    assert.equal(r.hitl?.timedOut, true, '接管窗口耗尽 = timedOut（结果报告模型——转 waiting 语义）')
    assert.ok(log.narratives.some((n) => n.type === 'browser/hitl' && n.extra['phase'] === 'timeout'), 'timeout 叙事落链')
    assert.ok(hitlPushes.some((p) => p.phase === 'timeout'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('s-browser: 窗口重建钩子——target 发现失败 → ensureWindow 恰一触发 + 重试后 fail-visible', async () => {
  const log = fakeLog()
  const dir = mkdtempSync(join(tmpdir(), 's-browser-recreate-'))
  try {
    const { deps } = makeDeps({ parentLog: log, userDataDir: dir, evaluateValue: '{}', targets: [], connectTimeoutMs: 80 })
    const tasks = new BrowserTasks(deps)
    let ensureCalls = 0
    tasks.hooks({ ensureWindow: () => ensureCalls++ })
    const tools = tasks.tools()
    await assert.rejects(() => tools[0]!.run({ url: 'https://example.com' }), /CAR-E-BROWSER-TARGET/)
    assert.equal(ensureCalls, 1, '重建钩子恰一触发（重试一轮仍失败 = fail-visible）')
    assert.ok(log.narratives.some((n) => n.type === 'browser/exit' && n.extra['reason'] === 'connect-failed'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
