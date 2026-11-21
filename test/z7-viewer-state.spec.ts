/**
 * z7 · 0.12.0 FileViewer 反向感知（Z-7 / D-V12-2 + D-V12-6）
 *
 * 判据：
 *  - 文件交接形态（browser-target.json 同款）：main 写 userData/viewer-state.json →
 *    host 工具读（spec 侧直接写文件模拟 main 写者——main 持态/防抖/原子写由 CDP 终验承载）；
 *  - fileviewer_get_view 四态：缺文件 viewOpen:false / 正常态（path+scroll+选区）/ 坏 JSON 降级 /
 *    选区 redact（密钥面不进返回面——K-FS-4 同纪律）；
 *  - readonly 直判落链（⓪⁼ D-V12-6）：decideByRule APPROVED reason 带 readonly toolface 标识
 *    （审计可回答「为什么没问人」）——E2E 真跑零 pending；
 *  - 上报 IPC（fileviewer:report）/渲染层钩子 = 契约 + CDP 终验面（main 侧无单测壳）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createHostService, type HostService, type PushMessage } from '../src/host-core/service.ts'
import { builtinTools, fileviewerGetViewTool } from '../src/host-core/tools.ts'
import type { SessionEventDTO, SessionEventPush, WorkspaceInfo } from '../src/shared/ipc-contract.ts'
import type { SessionHandle } from '../src/host-core/session-handle.ts'
import type { HostModelFn, HostModelStep } from '../src/host-core/types.ts'

function tmpDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `car-z7-${label}-`))
}

function emitAssistant(h: SessionHandle, s: HostModelStep): HostModelStep {
  if (typeof s.text === 'string' && s.text.length > 0) {
    h.log.append('model', 'assistant', h.currentTurnId(), s.text)
  }
  return s
}

interface Env {
  svc: HostService
  ws: WorkspaceInfo
  sess: { sessionId: string }
  root: string
  userData: string
  pushes: PushMessage[]
}

async function makeEnv(): Promise<Env> {
  const userData = tmpDir('ud')
  const root = tmpDir('ws')
  writeFileSync(join(root, 'car.config.ts'), "export default { llm: { baseUrl: 'http://127.0.0.1:9', model: 'test-model' } }\n", 'utf8')
  const svc = createHostService({
    userDataDir: userData,
    modelFnOverride: (h: SessionHandle) => {
      let lastTurn = ''
      return async (): Promise<HostModelStep> => {
        const t = h.currentTurnId()
        if (t !== lastTurn) {
          lastTurn = t
          return { stopReason: 'toolUse', toolCalls: [{ id: 'c-' + t, tool: 'fileviewer_get_view', args: {} }] }
        }
        return emitAssistant(h, { stopReason: 'stop', text: 'done' })
      }
    },
  })
  const pushes: PushMessage[] = []
  svc.onPush((m) => pushes.push(m))
  const ws = (await svc.dispatch('workspace:register', { path: root })) as WorkspaceInfo
  const sess = (await svc.dispatch('session:create', { workspaceId: ws.id })) as { sessionId: string }
  return { svc, ws, sess, root, userData, pushes }
}

function eventsOf(env: Env): SessionEventDTO[] {
  return env.pushes.filter((m) => m.topic === 'push:session-event').map((m) => (m.payload as SessionEventPush).event)
}
function toolResultsOf(env: Env): Array<Record<string, unknown>> {
  return eventsOf(env)
    .filter((e) => e.kind === 'toolResult')
    .map((e) => e.payload as Record<string, unknown>)
}
async function waitForTurnEnd(env: Env, turnId: string, timeoutMs = 5000): Promise<SessionEventDTO> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const e = eventsOf(env).find((x) => x.kind === 'turnEnd' && x.turnId === turnId)
    if (e) return e
    if (Date.now() > deadline) throw new Error(`waitForTurnEnd 超时（${turnId}）`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

// ==================== 工具单元（四态） ====================

test('Z7-1 工具四态：缺文件 viewOpen:false / 正常态 / 坏 JSON 降级 / 选区 redact', async () => {
  const ud = tmpDir('tool')
  const tool = fileviewerGetViewTool(ud)
  assert.equal(tool.declaredSideEffect, 'readonly')
  // 缺文件 = 正常态非错误
  const none = (await tool.run({})) as Record<string, unknown>
  assert.equal(none['viewOpen'], false)
  // 正常态：main 写者形态（spec 模拟）——path + scroll + 选区
  writeFileSync(join(ud, 'viewer-state.json'), JSON.stringify({ viewOpen: true, path: 'D:/ws/report.md', scrollPercent: 42, selectionText: '普通选区文本', selectionChars: 6, updatedAt: 1 }), 'utf8')
  const ok = (await tool.run({})) as Record<string, unknown>
  assert.equal(ok['viewOpen'], true)
  assert.equal(ok['path'], 'D:/ws/report.md')
  assert.equal(ok['scrollPercent'], 42)
  assert.equal(ok['selectionText'], '普通选区文本')
  // 选区含密钥面 → redact（K-FS-4：链上/返回面只进脱敏形态 + redactedCount 计数）
  writeFileSync(join(ud, 'viewer-state.json'), JSON.stringify({ viewOpen: true, path: 'D:/ws/config.txt', selectionText: 'token sk-live-abc123secretvalue 后续文本', updatedAt: 2 }), 'utf8')
  const sec = (await tool.run({})) as Record<string, unknown>
  assert.ok(!String(sec['selectionText']).includes('abc123secretvalue'), '密钥原文不进返回面')
  assert.ok(Number(sec['redactedCount']) >= 1, '脱敏计数在场')
  // 坏 JSON 降级（main 唯一写者——半态自愈，禁 fail-visible 误伤指代消解）
  writeFileSync(join(ud, 'viewer-state.json'), '{corrupted', 'utf8')
  const bad = (await tool.run({})) as Record<string, unknown>
  assert.equal(bad['viewOpen'], false)
  assert.ok(String(bad['note']).includes('坏 JSON'))
})

// ==================== E2E：readonly 直判落链 + 工具环真跑 ====================

test('Z7-2 E2E：工具环真跑（选区返回面）+ readonly 直判落链（零 pending——⓪⁼ decideByRule APPROVED）', async () => {
  const env = await makeEnv()
  // main 写者模拟：正常态含密钥选区（redact 在工具 run 内承担）
  writeFileSync(join(env.userData, 'viewer-state.json'), JSON.stringify({ viewOpen: true, path: join(env.root, 'notes.md'), scrollPercent: 15, selectionText: '部署视图 notes，api key sk-live-xyzsecret999abcdefghij', updatedAt: 3 }), 'utf8')
  const pendingsBefore = env.pushes.filter((m) => m.topic === 'push:authz-pending').length
  const t = (await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, text: '我正在看这个文件' })) as { turnId: string }
  await waitForTurnEnd(env, t.turnId)
  const trRaw = toolResultsOf(env).at(-1)!
  // toolResult 链事件 payload = { id, result }（kernel 形态）——结果体可能平铺或嵌套，双形态兼容读
  const tr = ((trRaw['result'] ?? trRaw) as Record<string, unknown>)
  assert.equal(tr['viewOpen'], true, '工具环真跑返回态')
  assert.equal(tr['path'], join(env.root, 'notes.md'))
  assert.ok(!String(tr['selectionText']).includes('xyzsecret999abcdefghij'), 'E2E 返回面脱敏')
  assert.ok(Number(tr['redactedCount']) >= 1)
  // readonly 直判：零 pending + 规则面 APPROVED 落链（审计可回答「为什么没问人」）
  assert.equal(env.pushes.filter((m) => m.topic === 'push:authz-pending').length, pendingsBefore, 'readonly 工具零人审弹窗')
  const roRule = eventsOf(env).find((e) => e.turnId.includes('ro-tool:fileviewer_get_view'))
  assert.ok(roRule, '⓪⁼ 直判事件落链')
  assert.equal((roRule!.payload as Record<string, unknown>)['decision'], 'APPROVED')
  assert.equal((roRule!.payload as Record<string, unknown>)['decidedBy'], 'policy')
  assert.ok(String((roRule!.meta as Record<string, unknown>)['reason']).includes('readonly toolface'))
})

test('Z7-3 工具注册前提：userDataDir 缺席 = 不注册（测试装配形态收敛）', () => {
  // builtinTools 第四参可选——viewerStateDir 缺席不推入工具（负向登记）
  const without = builtinTools(tmpDir('ws-nodir'))
  assert.equal(without.some((t) => t.name === 'fileviewer_get_view'), false, '无 userDataDir 不注册')
  const withDir = builtinTools(tmpDir('ws-dir'), undefined, undefined, tmpDir('ud2'))
  assert.equal(withDir.some((t) => t.name === 'fileviewer_get_view'), true, '有 userDataDir 注册')
  assert.ok(existsSync(tmpDir('ws-dir')))
})
