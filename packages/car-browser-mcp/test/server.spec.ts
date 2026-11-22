/**
 * car-browser-mcp · 包内套件（B-3 / D-VB3-2）
 *
 * 判据：
 *  - 协议面（in-process serve 注入 io）：initialize 回显 / notifications 无响应 / tools/list
 *    （sideEffect CAR 扩展：open/read=readonly、act 缺省=T-22 收敛 write）/ tools/call 成功
 *    content[0].text JSON / 未知工具 -32000 / 未知方法 -32601 / 坏 JSON -32700 / 串行收口；
 *  - 驱动面（假 CDP——fetchImpl/wsFactory 注入缝，desktop s-browser 同款）：open 全链（loaded +
 *    最终 url/title）/ read provenance 四件套 + redact（密钥面不进读取面）/ act click（真输入
 *    管线断言）/ HITL 特征命中即报告（hitl-detected，不等 300s）/ 导航护栏 100 fail-visible；
 *  - 真进程 E2E：spawn src/server.ts（--experimental-transform-types）——独立进程协议形态 +
 *    死端口 fail-visible（CAR-E-BROWSER-TARGET）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { BrowserMcpDriver, BROWSER_NAV_MAX, BROWSER_TARGET_TITLE } from '../src/driver.ts'
import { buildToolSpecs, createDispatcher, serve } from '../src/server.ts'

// ── 假 CDP（desktop s-browser 同款注入缝） ─────────────────────────────────

class FakeWS {
  static OPEN = 1
  readyState = 1
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  sent: Array<{ id: number; method: string; params: Record<string, unknown> }> = []
  constructor(private handlers: (method: string, params: Record<string, unknown>, ws: FakeWS) => void) {}
  send(raw: string): void {
    const msg = JSON.parse(raw) as { id: number; method: string; params: Record<string, unknown> }
    this.sent.push(msg)
    setTimeout(() => this.handlers(msg.method, msg.params, this), 0)
  }
  reply(id: number, result: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify({ id, result }) })
  }
  emit(method: string, params: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify({ method, params }) })
  }
  close(): void {}
}

const SECRET = 'sk-abcdef1234567890abcdef123456' // secrets-scan:allow 测试 fixture 靶料（redact 管线断言用——非真实凭据）

function fakeDriverDeps(opts: { hitl?: boolean } = {}): ConstructorParameters<typeof BrowserMcpDriver>[0] {
  const wsQueue: FakeWS[] = []
  const evaluateByProbe = (expr: string): unknown => {
    if (expr.includes('innerText')) {
      const text = `表单内容 ${SECRET} 尾部`
      return JSON.stringify({ url: 'https://x.example/final', title: 'Page T', text, links: 3 })
    }
    if (expr.includes('pwd')) {
      return JSON.stringify({ url: opts.hitl ? 'https://x.example/login' : 'https://x.example/final', pwd: opts.hitl === true, captcha: false, qr: false })
    }
    if (expr.includes('({url: location.href')) return { url: 'https://x.example/final', title: 'Page T' }
    if (expr.includes('getBoundingClientRect')) return JSON.stringify({ x: 10, y: 20, tag: 'BUTTON', href: null })
    if (expr.includes('getPrototypeOf')) return JSON.stringify('typed!')
    if (expr.trim() === 'location.href') return 'https://x.example/final'
    return null
  }
  return {
    connectTimeoutMs: 2_000,
    fetchImpl: (async () => ({
      json: async () => [{ title: BROWSER_TARGET_TITLE, webSocketDebuggerUrl: 'ws://fake/target' }],
    })) as unknown as typeof fetch,
    wsFactory: async () => {
      const ws = new FakeWS((method, params, w) => {
        const id = w.sent[w.sent.length - 1]!.id
        if (method === 'Runtime.enable' || method === 'Page.enable') ws.reply(id, {})
        else if (method === 'Page.navigate') {
          ws.reply(id, { frameId: 'f1' })
          setTimeout(() => ws.emit('Page.loadEventFired', {}), 5)
        } else if (method === 'Input.dispatchMouseEvent') {
          ws.reply(id, {})
        } else if (method === 'Runtime.evaluate') {
          ws.reply(id, { result: { value: evaluateByProbe(String(params['expression'])) } })
        } else ws.reply(id, {})
      })
      wsQueue.push(ws)
      setTimeout(() => ws.onopen?.(), 0)
      return ws as unknown as WebSocket
    },
  }
}

// ── BFM-1 · 驱动面（假 CDP） ──────────────────────────────────────────────

test('BFM-0 发现文件主路径（B-3 终验探针实证：/json/list title = document.title——有标题页面 title 过滤必 miss）', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'car-bfm0-'))
  try {
    writeFileSync(join(dir, 'browser-target.json'), JSON.stringify({ targetId: 'TGT123', cdpPort: 9421 }), 'utf8')
    // /json/list 返回「有标题页面」实证形态（title ≠ 窗口 title——兜底必 miss）
    const deps: ConstructorParameters<typeof BrowserMcpDriver>[0] = {
      targetFile: join(dir, 'browser-target.json'),
      connectTimeoutMs: 2_000,
      fetchImpl: (async () => ({
        json: async () => [{ title: '验收 fixture（页面标题）', webSocketDebuggerUrl: 'ws://fake/wrong' }],
      })) as unknown as typeof fetch,
      wsFactory: async (url) => {
        assert.match(url, /devtools\/page\/TGT123/, '主路径 = 发现文件 targetId ws url')
        assert.match(url, /9421/, '发现文件 cdpPort 优先')
        const ws = new FakeWS((method, params, w) => {
          const id = w.sent[w.sent.length - 1]!.id
          if (method === 'Runtime.enable' || method === 'Page.enable') w.reply(id, {})
          else if (method === 'Page.navigate') {
            w.reply(id, { frameId: 'f1' })
            setTimeout(() => w.emit('Page.loadEventFired', {}), 5)
          } else if (method === 'Runtime.evaluate') {
            w.reply(id, { result: { value: { url: 'https://x.example/final', title: 'T' } } })
          } else w.reply(id, {})
        })
        setTimeout(() => ws.onopen?.(), 0)
        return ws as unknown as WebSocket
      },
    }
    const driver = new BrowserMcpDriver(deps)
    const opened = await driver.open('https://x.example/')
    assert.equal(opened.status, 'loaded')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('BFM-1 工具面与驱动：open 全链 / read provenance+redact / act click / HITL 命中即报告', async () => {
  const specs = buildToolSpecs(new BrowserMcpDriver(fakeDriverDeps()))
  assert.deepEqual(specs.map((s) => s.name), ['browser_open', 'browser_read', 'browser_act'])
  assert.equal(specs.find((s) => s.name === 'browser_open')?.sideEffect, 'readonly')
  assert.equal(specs.find((s) => s.name === 'browser_read')?.sideEffect, 'readonly')
  assert.equal(specs.find((s) => s.name === 'browser_act')?.sideEffect, undefined, 'act 缺省（消费端 T-22 收敛 write）')
  const dispatch = createDispatcher(specs)
  const opened = (await dispatch('browser_open', { url: 'https://x.example/' })) as { url: string; title: string | null; status: string }
  assert.equal(opened.status, 'loaded')
  assert.equal(opened.url, 'https://x.example/final')
  assert.equal(opened.title, 'Page T')
  const read = (await dispatch('browser_read', {})) as { url: string; fetchedAt: string; sortNote: string; missing: string[]; content: string; truncated: boolean }
  assert.deepEqual(read.missing, [])
  assert.ok(read.url && read.fetchedAt && read.sortNote, 'provenance 四件套前三角在位')
  assert.ok(!read.content.includes(SECRET), 'redact 脱敏（密钥面不进读取面）')
  assert.ok(read.content.includes('表单内容'), '正文照常可读')
  const act = (await dispatch('browser_act', { action: 'click', selector: '#btn' })) as { status: string; url: string | null }
  assert.equal(act.status, 'done')
  assert.equal(act.url, 'https://x.example/final')
  await assert.rejects(async () => dispatch('browser_open', { url: 'ftp://x' }), /CAR-E-BROWSER-ARGS/)
  await assert.rejects(async () => dispatch('nope', {}), /CAR-E-MCP-TOOL/)
})

test('BFM-2 HITL 特征命中即报告（hitl-detected——不等 300s，消费端 30s 超时兼容）', async () => {
  const t0 = Date.now()
  const dispatch = createDispatcher(buildToolSpecs(new BrowserMcpDriver(fakeDriverDeps({ hitl: true }))))
  const opened = (await dispatch('browser_open', { url: 'https://x.example/' })) as { status: string; hitl?: { triggered: boolean; reason: string } }
  assert.equal(opened.status, 'hitl-detected')
  assert.equal(opened.hitl?.triggered, true)
  assert.ok(Date.now() - t0 < 10_000, '命中即回不等接管窗口')
  const act = (await dispatch('browser_act', { action: 'click', selector: '#btn' })) as { status: string; hitl?: { triggered: boolean } }
  assert.equal(act.status, 'hitl-detected')
})

test('BFM-3 导航护栏 100 fail-visible（不静默限流）', async () => {
  const dispatch = createDispatcher(buildToolSpecs(new BrowserMcpDriver(fakeDriverDeps())))
  for (let i = 0; i < BROWSER_NAV_MAX; i++) {
    await dispatch('browser_open', { url: 'https://x.example/' })
  }
  await assert.rejects(async () => dispatch('browser_open', { url: 'https://x.example/' }), /CAR-E-BROWSER-NAV/)
})

// ── BFM-4 · 协议面（in-process serve 注入 io） ─────────────────────────────

function stringSource(): {
  input: AsyncIterable<string>
  push: (line: string) => void
  end: () => void
} {
  const chunks: string[] = []
  let wake: (() => void) | null = null
  let ended = false
  return {
    input: {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          if (chunks.length > 0) {
            yield chunks.shift()!
            continue
          }
          if (ended) return
          await new Promise<void>((r) => {
            wake = r
          })
        }
      },
    },
    push: (line) => {
      chunks.push(line)
      wake?.()
      wake = null
    },
    end: () => {
      ended = true
      wake?.()
      wake = null
    },
  }
}

async function waitFor<T>(probe: () => T | null, label: string, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = probe()
    if (v !== null) return v
    if (Date.now() > deadline) throw new Error(`waitFor 超时（${label}）`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

test('BFM-4 协议面：initialize 回显 / notifications 无响应 / tools/list sideEffect / tools/call 错误码族 / 串行收口', async () => {
  const src = stringSource()
  const outLines: string[] = []
  const { done } = serve({ cdpPort: 1, driverDeps: fakeDriverDeps() }, { input: src.input, write: (l) => outLines.push(l) })
  // initialize（回显客户端 protocolVersion）
  src.push(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }))
  const init = await waitFor(() => outLines.map((l) => JSON.parse(l) as Record<string, unknown>).find((m) => m['id'] === 1) ?? null, 'initialize')
  const initResult = init['result'] as Record<string, unknown>
  assert.equal(initResult['protocolVersion'], '2025-06-18', 'protocolVersion 回显')
  assert.equal((initResult['serverInfo'] as Record<string, unknown>)['name'], 'car-browser-mcp')
  // notifications/*（无 id）不响应
  const before = outLines.length
  src.push(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(outLines.length, before, 'notifications 无 id 不响应')
  // tools/list
  src.push(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }))
  const list = (await waitFor(() => outLines.map((l) => JSON.parse(l) as Record<string, unknown>).find((m) => m['id'] === 2) ?? null, 'tools/list'))['result'] as { tools: Array<{ name: string; sideEffect?: string }> }
  assert.deepEqual(list.tools.map((t) => t.name), ['browser_open', 'browser_read', 'browser_act'])
  assert.equal(list.tools.find((t) => t.name === 'browser_open')?.sideEffect, 'readonly')
  assert.equal(list.tools.find((t) => t.name === 'browser_act')?.sideEffect, undefined)
  // tools/call 成功（content[0].text JSON）——串行派发链
  src.push(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'browser_read', arguments: {} } }))
  const call = (await waitFor(() => outLines.map((l) => JSON.parse(l) as Record<string, unknown>).find((m) => m['id'] === 3) ?? null, 'tools/call'))['result'] as { content: Array<{ type: string; text: string }> }
  assert.equal(call.content[0]!.type, 'text')
  const payload = JSON.parse(call.content[0]!.text) as Record<string, unknown>
  assert.equal(payload['url'], 'https://x.example/final')
  // tools/call 未知工具 → -32000
  src.push(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope', arguments: {} } }))
  const err4 = (await waitFor(() => outLines.map((l) => JSON.parse(l) as Record<string, unknown>).find((m) => m['id'] === 4) ?? null, 'err4'))['error'] as { code: number; message: string }
  assert.equal(err4.code, -32000)
  assert.match(err4.message, /CAR-E-MCP-TOOL/)
  // 工具失败（参数校验）→ -32000 CAR-E-BROWSER-ARGS
  src.push(JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'browser_open', arguments: { url: 'ftp://x' } } }))
  const err5 = (await waitFor(() => outLines.map((l) => JSON.parse(l) as Record<string, unknown>).find((m) => m['id'] === 5) ?? null, 'err5'))['error'] as { code: number; message: string }
  assert.equal(err5.code, -32000)
  assert.match(err5.message, /CAR-E-BROWSER-ARGS/)
  // 未知方法 → -32601
  src.push(JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'resources/list' }))
  const err6 = (await waitFor(() => outLines.map((l) => JSON.parse(l) as Record<string, unknown>).find((m) => m['id'] === 6) ?? null, 'err6'))['error'] as { code: number }
  assert.equal(err6.code, -32601)
  // 坏 JSON → -32700（id:null）
  src.push('{bad json')
  const err7 = (await waitFor(() => outLines.map((l) => JSON.parse(l) as Record<string, unknown>).find((m) => m['error'] && (m['error'] as { code: number })['code'] === -32700) ?? null, 'err7')) as { id: unknown }
  assert.equal(err7.id, null)
  // stdin 关闭 = server 收口
  src.end()
  await done
})

// ── BFM-5 · 真进程 E2E（独立进程协议形态 + 死端口 fail-visible） ────────────

test('BFM-5 真进程 spawn：initialize/tools/list 协议 + 死端口 tools/call fail-visible（CAR-E-BROWSER-TARGET）', async () => {
  const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.ts')
  const child = spawn(process.execPath, ['--experimental-transform-types', serverPath, '--cdp-port', '1'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  try {
    const out = createInterface({ input: child.stdout! })
    const lines: string[] = []
    out.on('line', (l) => lines.push(l))
    const send = (msg: Record<string, unknown>): void => child.stdin!.write(JSON.stringify(msg) + '\n')
    const waitId = async (id: number, label: string, timeoutMs = 20_000): Promise<Record<string, unknown>> => {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const found = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((m) => m['id'] === id)
        if (found) return found
        if (Date.now() > deadline) throw new Error(`真进程 waitFor 超时（${label}）——lines=${lines.length}`)
        await new Promise((r) => setTimeout(r, 20))
      }
    }
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    const init = await waitId(1, 'initialize')
    assert.equal((init['result'] as Record<string, unknown>)['protocolVersion'], '2024-11-05', '缺省 protocolVersion（内核 stdio 客户端不发 initialize 亦兼容）')
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const list = (await waitId(2, 'tools/list'))['result'] as { tools: Array<{ name: string }> }
    assert.deepEqual(list.tools.map((t) => t.name), ['browser_open', 'browser_read', 'browser_act'])
    // 死端口（CDP 1 无监听）→ 5s 发现窗口后 fail-visible -32000
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'browser_read', arguments: {} } })
    const err = (await waitId(3, 'dead-port call', 30_000))['error'] as { code: number; message: string }
    assert.equal(err.code, -32000)
    assert.match(err.message, /CAR-E-BROWSER-TARGET/)
  } finally {
    child.kill()
  }
})
