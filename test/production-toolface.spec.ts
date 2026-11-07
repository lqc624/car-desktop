/**
 * R-DRILL-1 回归：生产装配的模型可见工具面必须含 K2 编排三工具
 *
 * 背景（2026-11-07 商汤网关复测 killed 演练实链暴露）：attachRuntimeModel 的 toolDefs
 * 此前固化为 builtin+extra 快照，而 attachSubagentsFor 在其后才把 subagent_spawn/join/kill
 * push 进 handle.tools——执行注册表（runTurnFor 用 this.tools）与模型可见面分叉：
 * 真模型看不到编排工具（mock 网关脚本驱动时代不可达）。修复 = toolDefs 传 handle.tools
 * 活引用（同一数组，后置 push 每请求可见）。
 *
 * 证明路径：真实 createHostService 装配（零 override）+ 本地假网关捕获请求体——
 * 断言请求 tools 数组含 subagent_spawn/join/kill 与 fs_* 基建面（≈ 模型真实可见面）。
 */
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createHostService, type HostService } from '../src/host-core/service.ts'
import type { WorkspaceInfo } from '../src/shared/ipc-contract.ts'

test('R-DRILL-1：生产模型可见面含 subagent 三工具（活引用非快照）', async () => {
  let capturedTools: string[] | null = null
  const server: Server = createServer((req, res) => {
    let body = ''
    req.on('data', (c: Buffer) => (body += c.toString('utf8')))
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body) as { tools?: Array<{ name?: string; function?: { name?: string } }> }
        // wire 格式 = openai-compat {type:'function', function:{name}}（anthropic 形态亦兜底 name 顶层）
        if (Array.isArray(parsed.tools)) capturedTools = parsed.tools.map((t) => t.function?.name ?? t.name ?? '')
      } catch {
        /* 非 JSON 请求体不走此断言面 */
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  const baseUrl = await new Promise<string>((r) =>
    server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(server.address() as { port: number }).port}/v1`)),
  )
  const userData = mkdtempSync(join(tmpdir(), 'car-toolface-ud-'))
  const root = mkdtempSync(join(tmpdir(), 'car-toolface-ws-'))
  writeFileSync(join(root, 'car.config.ts'), `export default { llm: { baseUrl: '${baseUrl}', model: 'toolface-model' } }\n`, 'utf8')
  const prevKey = process.env.OPENAI_API_KEY
  const prevAllow = process.env.CAR_ALLOW_ENV_CREDENTIALS
  process.env.OPENAI_API_KEY = 'sk-test-toolface' // secrets-scan:allow（测试 fixture 假靶料，非真实凭据）
  process.env.CAR_ALLOW_ENV_CREDENTIALS = '1'
  const svc = createHostService({ userDataDir: userData, authzTimeoutMs: 120_000 })
  try {
    const ws = (await svc.dispatch('workspace:register', { path: root })) as WorkspaceInfo
    const sess = (await svc.dispatch('session:create', { workspaceId: ws.id })) as { sessionId: string; modelError?: string | null }
    assert.equal(sess.modelError ?? null, null, '模型装配失败 = 前置失效')
    await svc.dispatch('turn:send', { workspaceId: ws.id, sessionId: sess.sessionId, text: '报一下你有哪些工具' })
    const deadline = Date.now() + 10_000
    while (capturedTools === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25))
    assert.ok(capturedTools, '假网关未捕获到请求体——前置失效')
    for (const name of ['fs_read', 'fs_write', 'fs_delete', 'subagent_spawn', 'subagent_join', 'subagent_kill']) {
      assert.ok(capturedTools!.includes(name), `模型可见面缺 ${name}（R-DRILL-1 回归命中——执行/可见面分叉复现）`)
    }
  } finally {
    process.env.OPENAI_API_KEY = prevKey
    process.env.CAR_ALLOW_ENV_CREDENTIALS = prevAllow
    await new Promise<void>((r) => server.close(() => r()))
    svc.dispose?.()
  }
})
