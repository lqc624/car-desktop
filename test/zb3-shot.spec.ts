/**
 * zb3-shot · 0.16.0 B-3 截图验收面（D-VB3-1/§4.8 视觉验收判据化协议）
 *
 * 判据：
 *  - browser_shot 工具面形态（第 4 件，readonly——页面读语义 + 受管证据落盘）；
 *  - shot 运行面（假 CDP）：PNG magic 校验落盘 + sidecar（provenance 四件套 + 截图时刻冻结
 *    文本摘录过 redact + viewport）+ index 登记 + 叙事仅元数据（PNG 字节/base64 零进链）；
 *  - 上限 fail-visible（BROWSER_SHOT_MAX——禁静默驱逐审计证据）；
 *  - shot_read 受管证据读面：list/read 两态 + 未知 id/坏 sidecar fail-visible + PNG 缺失
 *    照实标注（sidecar 在——文本证据仍可判定）；
 *  - ⓪⁼ 直判落链（E2E——零 pending，decideByRule APPROVED decidedBy policy）；
 *  - FileViewer 图片预览（kind=image dataUrl）+ 受管证据目录 carve-out（用户自阅面）+
 *    工作区外 deny 照拒。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { BrowserTasks, type BrowserManagerDeps } from '../src/host-core/browserTasks.ts'
import { appendShotEvidence, readShotIndex, shotReadTool, BROWSER_SHOT_MAX } from '../src/host-core/evidence.ts'
import { classifyPreviewFile, imageMimeOf } from '../src/shared/file-preview.ts'
import { createHostService, type HostService, type PushMessage } from '../src/host-core/service.ts'
import type { SessionEventDTO, SessionEventPush, WorkspaceInfo } from '../src/shared/ipc-contract.ts'
import type { SessionHandle } from '../src/host-core/session-handle.ts'
import type { SessionLog } from '@lqc123qwe/car-runtime'

const SECRET = 'sk-live-zb3secret999abcdefghij' // secrets-scan:allow 测试 fixture 靶料（redact 管线断言用——非真实凭据）

/** 最小合法 PNG 字节（magic 头 + 数据——appendShotEvidence 只验 magic） */
function fakePng(): Buffer {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 7)])
}

// ── 假 CDP（s-browser 同款注入缝 + captureScreenshot 应答） ─────────────────

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

/** 叙事桩（只收 system payload——断言 base64/密钥零进链） */
function fakeLog(): SessionLog & { narratives: Array<Record<string, unknown>> } {
  const narratives: Array<Record<string, unknown>> = []
  return {
    narratives,
    append(_actor: unknown, kind: unknown, _turnId: unknown, payload: unknown) {
      if (kind === 'system' && payload && typeof payload === 'object') narratives.push(payload as Record<string, unknown>)
      return { seq: narratives.length }
    },
  } as unknown as SessionLog & { narratives: Array<Record<string, unknown>> }
}

function makeShotDeps(userDataDir: string, parentLog: SessionLog, opts: { hitl?: boolean } = {}): { deps: BrowserManagerDeps; ws: FakeWS } {
  let ws: FakeWS | null = null
  const evaluateByProbe = (expr: string): unknown => {
    if (expr.includes('innerWidth')) {
      return JSON.stringify({ url: 'https://x.example/page', title: '验收页', text: `表单 ${SECRET} 尾部`, vw: 800, vh: 600 })
    }
    if (expr.includes('pwd')) return JSON.stringify({ url: 'https://x.example/page', pwd: opts.hitl === true, captcha: false, qr: false })
    if (expr.includes('({url: location.href')) return { url: 'https://x.example/page', title: '验收页' }
    return null
  }
  const deps: BrowserManagerDeps = {
    parentLog,
    userDataDir,
    fetchImpl: (async () => ({
      json: async () => [{ title: 'CAR 受控浏览器', webSocketDebuggerUrl: 'ws://fake/target' }],
    })) as unknown as typeof fetch,
    wsFactory: async () => {
      ws = new FakeWS((method, params, w) => {
        const id = w.sent[w.sent.length - 1]!.id
        if (method === 'Runtime.enable' || method === 'Page.enable') w.reply(id, {})
        else if (method === 'Page.navigate') {
          w.reply(id, { frameId: 'f1' })
          setTimeout(() => w.emit('Page.loadEventFired', {}), 5)
        } else if (method === 'Page.captureScreenshot') {
          w.reply(id, { data: fakePng().toString('base64') })
        } else if (method === 'Runtime.evaluate') {
          w.reply(id, { result: { value: evaluateByProbe(String(params['expression'])) } })
        } else w.reply(id, {})
      })
      setTimeout(() => ws!.onopen?.(), 0)
      return ws as unknown as WebSocket
    },
  }
  return { deps, ws: ws as unknown as FakeWS }
}

function toolsOf(deps: BrowserManagerDeps): ReturnType<BrowserTasks['tools']> {
  return new BrowserTasks(deps).tools()
}

// ==================== browser_shot ====================

test('ZB3S-1 工具形态 + shot 全链：PNG/sidecar/index 落盘 + 摘录 redact + 叙事仅元数据（字节零进链）', async () => {
  const ud = mkdtempSync(join(tmpdir(), 'car-zb3-ud-'))
  try {
    const tools = toolsOf(makeShotDeps(ud, fakeLog()).deps)
    const shotTool = tools.find((t) => t.name === 'browser_shot')
    assert.ok(shotTool, 'browser_shot 入工具面（第 4 件）')
    assert.equal(shotTool!.declaredSideEffect, 'readonly', '页面读语义声明')
    const log = fakeLog()
    const { deps } = makeShotDeps(ud, log)
    const shot = toolsOf(deps).find((t) => t.name === 'browser_shot')!
    const r = (await shot.run({})) as Record<string, unknown>
    assert.match(String(r['shotId']), /^shot-/)
    assert.equal(r['url'], 'https://x.example/page')
    assert.equal(r['title'], '验收页')
    assert.deepEqual(r['viewport'], { width: 800, height: 600 })
    assert.ok(Number(r['pngBytes']) > 0)
    assert.equal(r['textTruncated'], false)
    assert.ok(String(r['sourceNote']).length > 0, '分层标注在场')
    // 落盘面：PNG 字节 == 解码值；sidecar 摘录脱敏；index 登记
    const id = String(r['shotId'])
    const pngPath = join(ud, 'browser-shots', `${id}.png`)
    assert.ok(existsSync(pngPath), 'PNG 落盘')
    assert.deepEqual(readFileSync(pngPath), fakePng())
    const sidecar = JSON.parse(readFileSync(join(ud, 'browser-shots', `${id}.json`), 'utf8')) as Record<string, unknown>
    assert.equal(sidecar['shotId'], id)
    assert.equal(sidecar['url'], 'https://x.example/page')
    assert.deepEqual(sidecar['viewport'], { width: 800, height: 600 })
    assert.ok(!String(sidecar['textExcerpt']).includes('zb3secret999'), '摘录 redact（密钥面不落盘）')
    assert.ok(String(sidecar['textExcerpt']).includes('表单'), '摘录正文照常在')
    const index = readShotIndex(ud)
    assert.equal(index.length, 1)
    assert.equal(index[0]!.shotId, id)
    // 叙事仅元数据：browser/shot payload 不含 base64/密钥
    const shotNarratives = log.narratives.filter((p) => p['type'] === 'browser/shot')
    assert.equal(shotNarratives.length, 1)
    const raw = JSON.stringify(shotNarratives[0])
    assert.ok(!raw.includes(fakePng().toString('base64').slice(0, 20)), 'PNG base64 零进链')
    assert.ok(!raw.includes('zb3secret999'), '密钥零进链')
    assert.equal(shotNarratives[0]!['shotId'], id)
  } finally {
    rmSync(ud, { recursive: true, force: true })
  }
})

test('ZB3S-2 证据上限 fail-visible（BROWSER_SHOT_MAX——禁静默驱逐）', async () => {
  const ud = mkdtempSync(join(tmpdir(), 'car-zb3-cap-'))
  try {
    // 预写满额 index（不落 100 个真文件——上限判定只看 index 计数）
    const shots = Array.from({ length: BROWSER_SHOT_MAX }, (_, i) => ({ shotId: `shot-full-${i}`, url: 'u', title: null, capturedAt: 't', pngBytes: 1 }))
    mkdirSyncShots(ud)
    writeFileSync(join(ud, 'browser-shots', 'index.json'), JSON.stringify({ shots }), 'utf8')
    const log = fakeLog()
    const shot = toolsOf(makeShotDeps(ud, log).deps).find((t) => t.name === 'browser_shot')!
    await assert.rejects(async () => shot.run({}), /CAR-E-BROWSER-SHOT-MAX/)
    assert.equal(readShotIndex(ud).length, BROWSER_SHOT_MAX, '超限不追加（禁静默驱逐）')
  } finally {
    rmSync(ud, { recursive: true, force: true })
  }
})

function mkdirSyncShots(ud: string): void {
  // browser-shots 目录惰性创建——预写 index 需先建目录
  mkdirSync(join(ud, 'browser-shots'), { recursive: true })
}

// ==================== shot_read ====================

test('ZB3S-3 shot_read：list/read 两态 + 未知 id / 坏 sidecar fail-visible + PNG 缺失照实标注', async () => {
  const ud = mkdtempSync(join(tmpdir(), 'car-zb3-ev-'))
  try {
    const rec = appendShotEvidence(ud, fakePng(), {
      url: 'https://x.example/p',
      fetchedAt: '2026-11-22T00:00:00.000Z',
      sortNote: 's',
      missing: [],
      title: 'T',
      capturedAt: '2026-11-22T00:00:00.000Z',
      viewport: { width: 800, height: 600 },
      textExcerpt: `证据摘录 ${SECRET}`,
      textTruncated: false,
      pngBytes: fakePng().length,
    })
    const tool = shotReadTool(ud)
    assert.equal(tool.declaredSideEffect, 'readonly')
    // list 态（无参）——新证据在前
    const list = (await tool.run({})) as { count: number; shots: Array<{ shotId: string }> }
    assert.equal(list.count, 1)
    assert.equal(list.shots[0]!.shotId, rec.shotId)
    // read 态——sidecar 证据 + 读回再 redact（纵深防御）
    const ev = (await tool.run({ shotId: rec.shotId })) as Record<string, unknown>
    assert.equal(ev['shotId'], rec.shotId)
    assert.equal(ev['url'], 'https://x.example/p')
    assert.deepEqual(ev['viewport'], { width: 800, height: 600 })
    assert.ok(!String(ev['textExcerpt']).includes('zb3secret999'), '读回面脱敏')
    assert.equal(ev['pngBytes'], fakePng().length)
    assert.ok(String(ev['sourceNote']).includes('页面抄录'), '分层标注（N-B1 纪律）')
    // 未知 id fail-visible
    await assert.rejects(async () => tool.run({ shotId: 'shot-none' }), /CAR-E-EVIDENCE-SHOT/)
    // sidecar 缺失 fail-visible
    rmSync(join(ud, 'browser-shots', `${rec.shotId}.json`))
    await assert.rejects(async () => tool.run({ shotId: rec.shotId }), /sidecar 缺失/)
    // PNG 缺失照实标注（sidecar 在——文本证据仍可判定）
    const rec2 = appendShotEvidence(ud, fakePng(), {
      url: 'u2', fetchedAt: 't2', sortNote: 's', missing: [], title: null, capturedAt: 't2',
      viewport: null, textExcerpt: 'x', textTruncated: false, pngBytes: 1,
    })
    rmSync(join(ud, 'browser-shots', `${rec2.shotId}.png`))
    const ev2 = (await tool.run({ shotId: rec2.shotId })) as Record<string, unknown>
    assert.equal(ev2['pngBytes'], null, 'PNG 缺失 = pngBytes null（禁伪造）')
    // 父面不注册：builtinTools 永不含 shot_read（禁自看图复判——toolface 级 enforcement）
    const { builtinTools } = await import('../src/host-core/tools.ts')
    assert.equal(builtinTools(ud, undefined, undefined, ud).some((t) => t.name === 'shot_read'), false, 'shot_read 不进父面')
  } finally {
    rmSync(ud, { recursive: true, force: true })
  }
})

// ==================== E2E：⓪⁼ 直判落链 ====================

interface Env {
  svc: HostService
  ws: WorkspaceInfo
  sess: { sessionId: string }
  root: string
  userData: string
  pushes: PushMessage[]
}

test('ZB3S-4 E2E：browser_shot ⓪⁼ 直判落链（零 pending——decideByRule APPROVED decidedBy policy）', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'car-zb3-e2e-ud-'))
  writeFileSync(join(userData, 'browser-settings.json'), JSON.stringify({ version: 1, updatedAt: 0, browserEnabled: true }), 'utf8')
  writeFileSync(join(userData, 'browser-target.json'), JSON.stringify({ targetId: 'DEAD', cdpPort: 9999 }), 'utf8')
  const root = mkdtempSync(join(tmpdir(), 'car-zb3-e2e-ws-'))
  writeFileSync(join(root, 'car.config.ts'), "export default { llm: { baseUrl: 'http://127.0.0.1:9', model: 'test-model' } }\n", 'utf8')
  const svc = createHostService({
    userDataDir: userData,
    modelFnOverride: (h: SessionHandle) => {
      let lastTurn = ''
      return async () => {
        const t = h.currentTurnId()
        if (t !== lastTurn) {
          lastTurn = t
          return { stopReason: 'toolUse', toolCalls: [{ id: 'c-' + t, tool: 'browser_shot', args: {} }] }
        }
        h.log.append('model', 'assistant', h.currentTurnId(), 'done')
        return { stopReason: 'stop' as const, text: 'done' }
      }
    },
  })
  const pushes: PushMessage[] = []
  svc.onPush((m) => pushes.push(m))
  try {
    const ws = (await svc.dispatch('workspace:register', { path: root })) as WorkspaceInfo
    const sess = (await svc.dispatch('session:create', { workspaceId: ws.id })) as { sessionId: string }
    const t = (await svc.dispatch('turn:send', { workspaceId: ws.id, sessionId: sess.sessionId, text: '截一张图' })) as { turnId: string }
    const eventsOf = (): SessionEventDTO[] =>
      pushes.filter((m) => m.topic === 'push:session-event').map((m) => (m.payload as SessionEventPush).event)
    const deadline = Date.now() + 15_000
    for (;;) {
      if (eventsOf().some((x) => x.kind === 'turnEnd' && x.turnId === t.turnId)) break
      if (Date.now() > deadline) throw new Error('waitForTurnEnd 超时')
      await new Promise((r) => setTimeout(r, 20))
    }
    // ⓪⁼ 直判：零人审弹窗 + ro-tool APPROVED 落链
    assert.equal(pushes.filter((m) => m.topic === 'push:authz-pending').length, 0, 'browser_shot 零人审弹窗')
    const roRule = eventsOf().find((e) => e.turnId.includes('ro-tool:browser_shot'))
    assert.ok(roRule, '⓪⁼ 直判事件落链')
    assert.equal((roRule!.payload as Record<string, unknown>)['decision'], 'APPROVED')
    assert.equal((roRule!.payload as Record<string, unknown>)['decidedBy'], 'policy')
    assert.ok(String((roRule!.meta as Record<string, unknown>)['reason']).includes('ro-toolface'), 'reason 带规则标识（审计可回答「为什么没问人」）')
    // 叙事 browser/shot 落链（DEAD target 下 run 失败——授权先于运行，叙事由失败路径收口；断言 0⁼ 面即可）
    assert.ok(eventsOf().some((e) => e.kind === 'toolResult' && String(JSON.stringify(e.payload)).includes('CAR-E-')), '死端口 run fail-visible（授权门先于运行面）')
  } finally {
    svc.dispose()
    rmSync(userData, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
})

// ==================== FileViewer 图片预览 ====================

test('ZB3S-5 filePreview 图片分支：classify/mime + dataUrl 返回 + 受管证据 carve-out + 工作区外照拒', async () => {
  assert.equal(classifyPreviewFile('page.png'), 'image')
  assert.equal(imageMimeOf('page.png'), 'image/png')
  assert.equal(imageMimeOf('movie.mp4'), null)
  const userData = mkdtempSync(join(tmpdir(), 'car-zb3-fv-ud-'))
  const root = mkdtempSync(join(tmpdir(), 'car-zb3-fv-ws-'))
  writeFileSync(join(root, 'car.config.ts'), "export default { llm: { baseUrl: 'http://127.0.0.1:9', model: 'test-model' } }\n", 'utf8')
  // 工作区图片 + 受管证据图片（carve-out 面）
  writeFileSync(join(root, 'shot-ws.png'), fakePng())
  mkdirSyncShots(userData)
  writeFileSync(join(userData, 'browser-shots', 'shot-evidence.png'), fakePng())
  writeFileSync(join(userData, 'browser-shots', 'index.json'), JSON.stringify({ shots: [{ shotId: 'shot-evidence', url: 'u', title: null, capturedAt: 't', pngBytes: fakePng().length }] }), 'utf8')
  const outside = mkdtempSync(join(tmpdir(), 'car-zb3-fv-out-'))
  writeFileSync(join(outside, 'outside.png'), fakePng())
  const svc = createHostService({
    userDataDir: userData,
    modelFnOverride: (h: SessionHandle) => async () => {
      h.log.append('model', 'assistant', h.currentTurnId(), 'done')
      return { stopReason: 'stop' as const, text: 'done' }
    },
  })
  const pushes: PushMessage[] = []
  svc.onPush((m) => pushes.push(m))
  try {
    const ws = (await svc.dispatch('workspace:register', { path: root })) as WorkspaceInfo
    const sess = (await svc.dispatch('session:create', { workspaceId: ws.id })) as { sessionId: string }
    // 工作区图片（preset-workspace read=allow）
    const r1 = (await svc.dispatch('file:preview', { workspaceId: ws.id, sessionId: sess.sessionId, path: 'shot-ws.png' })) as Record<string, unknown>
    assert.equal(r1['kind'], 'image')
    assert.match(String(r1['dataUrl']), /^data:image\/png;base64,/)
    // 受管证据目录 carve-out（出厂 userData deny 面内——用户自阅面显式豁免，叙事带 evidenceCarveout）
    const r2 = (await svc.dispatch('file:preview', { workspaceId: ws.id, sessionId: sess.sessionId, path: join(userData, 'browser-shots', 'shot-evidence.png') })) as Record<string, unknown>
    assert.equal(r2['kind'], 'image')
    assert.match(String(r2['dataUrl']), /^data:image\/png;base64,/)
    const narr = pushes
      .filter((m) => m.topic === 'push:session-event')
      .map((m) => (m.payload as SessionEventPush).event)
      .find((e) => e.kind === 'system' && JSON.stringify(e.payload).includes('shot-evidence.png'))
    assert.ok(narr, 'file/preview 叙事在案（证据路径）')
    assert.ok(JSON.stringify(narr).includes('evidenceCarveout'), 'carve-out 留痕（叙事面）')
    // 工作区外非证据路径照拒（fallback-outside hardReject——与 fs_read 同口径）
    await assert.rejects(
      async () => svc.dispatch('file:preview', { workspaceId: ws.id, sessionId: sess.sessionId, path: join(outside, 'outside.png') }),
      /CAR-E-DESKTOP/,
    )
  } finally {
    svc.dispose()
    rmSync(userData, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})
