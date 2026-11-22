/**
 * zb3-mcp-mount · 0.16.0 B-3 car-browser-mcp 桌面挂载 E2E（D-VB3-2——MCP 封装同批）
 *
 * 判据：
 *  - car.config mcp.servers 挂载真进程（command = node --experimental-transform-types
 *    packages/car-browser-mcp/src/server.ts）→ mcp_car-browser-mcp_browser_* 工具面出现
 *    （stdio transport → tools/list 真握手）；
 *  - stdio 工具不在 mcpToolUrl 注册表 → ⓪′ 网络轴未命中 → 落人审门（pending 推送携工具名）
 *    ——授权责任在宿主门的 E2E 实证；
 *  - deny 应答 → authorization-denied toolResult（CDP 连接不被发起——授权门先于运行面）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createHostService, type HostService, type PushMessage } from '../src/host-core/service.ts'
import type { SessionEventDTO, SessionEventPush, WorkspaceInfo } from '../src/shared/ipc-contract.ts'
import type { SessionHandle } from '../src/host-core/session-handle.ts'
import type { HostModelStep } from '../src/host-core/types.ts'

test('ZB3M-1 挂载真进程：mcp_car-browser-mcp_browser_read 入工具面 + ⓪′ 未命中落人审门 + deny 即拒', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'car-zb3m-ud-'))
  const root = mkdtempSync(join(tmpdir(), 'car-zb3m-ws-'))
  const serverPath = join(fileURLToPath(new URL('..', import.meta.url)), 'packages', 'car-browser-mcp', 'src', 'server.ts')
  // car.config 挂载（stdio 形态——command/args；死端口 1 = 若门失效连接亦 fail-visible 快速失败）
  const config = {
    llm: { baseUrl: 'http://127.0.0.1:9', model: 'test-model' },
    mcp: { servers: { 'car-browser-mcp': { command: process.execPath, args: ['--experimental-transform-types', serverPath, '--cdp-port', '1'] } } },
  }
  writeFileSync(join(root, 'car.config.ts'), 'export default ' + JSON.stringify(config, null, 2) + '\n', 'utf8')
  let capturedTools: string[] | null = null
  const svc = createHostService({
    userDataDir: userData,
    modelFnOverride: (h: SessionHandle) => {
      let lastTurn = ''
      let captured = false
      return async (): Promise<HostModelStep> => {
        const t = h.currentTurnId()
        if (t !== lastTurn) {
          lastTurn = t
          if (!captured) {
            captured = true
            capturedTools = h.tools.map((d) => d.name)
          }
          return { stopReason: 'toolUse', toolCalls: [{ id: 'c-' + t, tool: 'mcp_car-browser-mcp_browser_read', args: {} }] }
        }
        h.log.append('model', 'assistant', h.currentTurnId(), 'done')
        return { stopReason: 'stop' as const, text: 'done' }
      }
    },
  })
  const pushes: PushMessage[] = []
  svc.onPush((m) => {
    pushes.push(m)
    if (m.topic === 'push:authz-pending') {
      const p = m.payload as { requestId: string }
      setTimeout(() => {
        void svc.dispatch('authz:respond', { requestId: p.requestId, decision: 'deny' }).catch(() => { /* 已决 = 噪声 */ })
      }, 30)
    }
  })
  try {
    const ws = (await svc.dispatch('workspace:register', { path: root })) as WorkspaceInfo
    const sess = (await svc.dispatch('session:create', { workspaceId: ws.id })) as { sessionId: string }
    const t = (await svc.dispatch('turn:send', { workspaceId: ws.id, sessionId: sess.sessionId, text: '读页面' })) as { turnId: string }
    const eventsOf = (): SessionEventDTO[] =>
      pushes.filter((m) => m.topic === 'push:session-event').map((m) => (m.payload as SessionEventPush).event)
    const deadline = Date.now() + 20_000
    for (;;) {
      if (eventsOf().some((x) => x.kind === 'turnEnd' && x.turnId === t.turnId)) break
      if (Date.now() > deadline) throw new Error('waitForTurnEnd 超时')
      await new Promise((r) => setTimeout(r, 20))
    }
    // 工具面出现（真进程 tools/list 装载）
    assert.ok(capturedTools, '模型工具面已捕获')
    assert.ok(capturedTools!.includes('mcp_car-browser-mcp_browser_read'), 'mcp_car-browser-mcp_browser_read 入面')
    assert.ok(capturedTools!.includes('mcp_car-browser-mcp_browser_open'), 'browser_open 入面')
    assert.ok(capturedTools!.includes('mcp_car-browser-mcp_browser_act'), 'browser_act 入面')
    // ⓪′ 未命中（stdio 不在 mcpToolUrl）→ 人审门
    const pending = pushes.find((m) => m.topic === 'push:authz-pending')
    assert.ok(pending, 'stdio mcp 工具落人审门（授权责任在宿主）')
    const pp = (pending as { payload: Record<string, unknown> }).payload
    assert.equal(pp['tool'], 'mcp_car-browser-mcp_browser_read')
    assert.equal(pp['capability'], 'mcp')
    // deny 应答 → authorization-denied（CDP 连接不被发起）
    const tr = eventsOf().find((e) => e.kind === 'toolResult')
    assert.ok(tr, 'toolResult 落链')
    assert.match(String(JSON.stringify(tr!.payload)), /authorization-denied|denied/i, 'deny 结果交回模型')
  } finally {
    svc.dispose()
    rmSync(userData, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
})
