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
}): { deps: BrowserManagerDeps; wsQueue: FakeWS[] } {
  const wsQueue: FakeWS[] = []
  const deps: BrowserManagerDeps = {
    parentLog: opts.parentLog,
    userDataDir: opts.userDataDir,
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
        } else if (method === 'Runtime.evaluate') {
          ws.reply(id, { result: { value: opts.evaluateValue } })
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

test('s-browser: 工具面形态——browser_open/browser_read 均 readonly（Q-B3）+ 契约参数', () => {
  const dir = mkdtempSync(join(tmpdir(), 's-browser-'))
  try {
    const { deps } = makeDeps({ parentLog: fakeLog(), userDataDir: dir, evaluateValue: '{}' })
    const tools = new BrowserTasks(deps).tools()
    assert.deepEqual(tools.map((t) => t.name), ['browser_open', 'browser_read'], 'B-1 两件（act/task_stop = B-2/P2 不在本面）')
    assert.equal(tools[0]!.declaredSideEffect, 'readonly')
    assert.equal(tools[1]!.declaredSideEffect, 'readonly')
    assert.equal(tools[1]!.parameters && (tools[1]!.parameters as { properties: Record<string, unknown> }).properties && Object.keys((tools[1]!.parameters as { properties: Record<string, unknown> }).properties).length, 0, 'browser_read 无参')
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
