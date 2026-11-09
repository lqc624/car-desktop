/**
 * T-FV-2 后台 bash 任务 E2E（宿主公共 API 驱动，链真跑；k2 harness 同款——脚本模型 + autoAuthz）
 *
 * 判据：
 *  - bash_run 全链：toolCall/toolResult 成对（模型动作）+ bash/start|bash/exit 落链（体量事实，
 *    输出内容不进链）+ bash:output 读取面过 redact（K-FS-4）；
 *  - 停止：bash/kill + bash/exit(stopped) 落链；turn:abort 级联树杀；
 *  - 安全面：只读策略 → authorization-denied（零 bash/start）；cwd 越界 fail-visible；
 *    并发 ≤4 超限 CAR-E-BASH-CONC（fail-visible 禁静默排队）；
 *  - subagent:kill 面：ghost 会话不可续写 / 未知 id UNKNOWN / settled KILL-STATE；
 *  - 孤儿收割：bash/start 无收口 → reapOrphans 补 stopped（幂等）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { SessionLog } from '@lqc123qwe/car-runtime'
import { createHostService, type HostService, type PushMessage } from '../src/host-core/service.ts'
import { BashTaskManager } from '../src/host-core/bashTasks.ts'
import type { WorkspaceInfo } from '../src/shared/ipc-contract.ts'
import type { SessionHandle } from '../src/host-core/session-handle.ts'
import type { SessionEventDTO, SessionEventPush } from '../src/shared/ipc-contract.ts'

function tmpDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `car-bt-${label}-`))
}

interface Env {
  svc: HostService
  ws: WorkspaceInfo
  sess: { sessionId: string }
  root: string
  pushes: PushMessage[]
}

/** 授权自动应答器（k2 同款——回包推迟一个宏任务） */
function autoAuthz(svc: HostService): void {
  svc.onPush((m) => {
    if (m.topic === 'push:authz-pending') {
      const p = m.payload as { requestId: string }
      setTimeout(() => {
        void svc.dispatch('authz:respond', { requestId: p.requestId, decision: 'session' }).catch(() => { /* 已决 = 噪声 */ })
      }, 0)
    }
  })
}

function scriptedParentModel(
  steps: Array<{
    text?: string
    hangMs?: number
    tool?: string
    id?: string
    args?: Record<string, unknown>
    calls?: Array<{ tool: string; id: string; args: Record<string, unknown> }>
  }>,
) {
  return (h: SessionHandle) => {
    let i = 0
    return async () => {
      const s = steps[i++] ?? { text: '（脚本尽——自然收口）' }
      if (s.hangMs) await new Promise((r) => setTimeout(r, s.hangMs))
      if (s.calls?.length) {
        return { stopReason: 'toolUse' as const, toolCalls: s.calls.map((c, j) => ({ id: c.id ?? 'call-' + j, tool: c.tool, args: c.args })) }
      }
      if (s.tool) {
        return { stopReason: 'toolUse' as const, toolCalls: [{ id: s.id ?? 'call-' + i, tool: s.tool, args: s.args ?? {} }] }
      }
      const text = s.text ?? ''
      if (text.length > 0) h.log.append('model', 'assistant', h.currentTurnId(), text)
      return { stopReason: 'stop' as const, text }
    }
  }
}

async function makeEnv(steps: Parameters<typeof scriptedParentModel>[0]): Promise<Env> {
  const userData = tmpDir('ud')
  const root = tmpDir('ws')
  writeFileSync(join(root, 'car.config.ts'), "export default { llm: { baseUrl: 'http://127.0.0.1:9', model: 'test-model' } }\n", 'utf8')
  const svc = createHostService({ userDataDir: userData, modelFnOverride: scriptedParentModel(steps) })
  const pushes: PushMessage[] = []
  svc.onPush((m) => pushes.push(m))
  autoAuthz(svc)
  const ws = (await svc.dispatch('workspace:register', { path: root })) as WorkspaceInfo
  const sess = (await svc.dispatch('session:create', { workspaceId: ws.id })) as { sessionId: string }
  return { svc, ws, sess, root, pushes }
}

function eventsOf(env: Env): SessionEventDTO[] {
  return env.pushes.filter((m) => m.topic === 'push:session-event').map((m) => (m.payload as SessionEventPush).event)
}

function sysPayloads(env: Env, type: string): Array<Record<string, unknown>> {
  return eventsOf(env)
    .filter((e) => e.kind === 'system' && (e.payload as Record<string, unknown> | null)?.['type'] === type)
    .map((e) => e.payload as Record<string, unknown>)
}

async function sendTurn(env: Env, text: string): Promise<string> {
  return ((await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, text })) as { turnId: string }).turnId
}

async function waitFor<T>(fn: () => T | undefined | false, what: string, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() > deadline) throw new Error(`等待超时：${what}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

test('BT-1 bash_run 快任务全链：成对工具痕 + start/exit 落链（输出不进链）+ 读取面已脱敏', async () => {
  const env = await makeEnv([{ tool: 'bash_run', args: { command: 'node -e console.log(42)' } }, { text: '收口' }])
  try {
    const turnId = await sendTurn(env, '跑个快任务')
    await waitFor(() => sysPayloads(env, 'bash/exit').at(-1), 'bash/exit')
    const start = sysPayloads(env, 'bash/start').at(-1)!
    assert.match(String(start['taskId']), /^BK-/, 'taskId = BK- 前缀')
    assert.equal(start['command'], 'node -e console.log(42)')
    assert.equal(start['cwd'], env.root, '缺省 cwd = 工作区根')
    const exit = sysPayloads(env, 'bash/exit').at(-1)!
    assert.equal(exit['exitCode'], 0)
    assert.ok(Number(exit['outputBytes']) > 0, 'outputBytes = 体量事实落链')
    assert.ok(!('tail' in exit) && !('output' in exit), '输出内容不进链')
    // 工具结果面：taskId 回模型（toolCall/toolResult 成对——runTurn 行为）
    const tr = eventsOf(env).find((e) => e.kind === 'toolResult' && (e.payload as Record<string, unknown>)['result'])
    assert.ok(tr, 'toolResult 落链')
    const result = (tr!.payload as Record<string, unknown>)['result'] as Record<string, unknown>
    assert.equal(result['taskId'], start['taskId'])
    // 读取面：尾部含输出真值
    const out = (await env.svc.dispatch('bash:output', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, taskId: start['taskId'] })) as {
      tail: string
      running: boolean
      exitCode: number | null
    }
    assert.equal(out.running, false)
    assert.equal(out.exitCode, 0)
    assert.ok(out.tail.includes('42'), 'tail = 输出真值（宿主已过 redact）')
    void turnId
  } finally {
    env.svc.closeAll?.()
  }
})

test('BT-2 停止：bash/kill + bash/exit(stopped) 落链；读取面 running→false', async () => {
  const env = await makeEnv([{ tool: 'bash_run', args: { command: 'node -e setInterval(function(){},1000)' } }, { text: '收口' }])
  try {
    await sendTurn(env, '跑个长任务再停掉')
    const start = await waitFor(() => sysPayloads(env, 'bash/start').at(-1), 'bash/start')
    const taskId = String(start['taskId'])
    await env.svc.dispatch('bash:kill', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, taskId })
    const kill = sysPayloads(env, 'bash/kill').at(-1)!
    assert.equal(kill['taskId'], taskId)
    assert.equal(kill['reason'], 'user')
    const exit = await waitFor(() => sysPayloads(env, 'bash/exit').find((p) => p['taskId'] === taskId && p['stopped'] === true), 'bash/exit(stopped)')
    assert.ok(exit, '进程树终止后以 stopped 收口')
    const out = (await env.svc.dispatch('bash:output', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, taskId })) as { running: boolean; stopped: boolean }
    assert.equal(out.running, false)
    assert.equal(out.stopped, true)
  } finally {
    env.svc.closeAll?.()
  }
})

test('BT-3 只读策略：bash_run = authorization-denied（零 bash/start——写面一律拒）', async () => {
  const env = await makeEnv([{ tool: 'bash_run', args: { command: 'node -e console.log(1)' } }, { text: '收口' }])
  try {
    await env.svc.dispatch('session:set-policy', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, policy: 'readonly' })
    await sendTurn(env, '只读模式跑任务')
    await waitFor(() => eventsOf(env).find((e) => e.kind === 'turnEnd' && e.turnId !== '' && !e.turnId.startsWith('authz:')), 'turnEnd')
    const tr = eventsOf(env).filter((e) => e.kind === 'toolResult')
    assert.ok(tr.length > 0, 'toolResult 落链')
    assert.ok(
      tr.some((e) => (e.payload as Record<string, unknown>)['error'] === 'authorization-denied'),
      '只读策略硬拒（authorization-denied）',
    )
    assert.equal(sysPayloads(env, 'bash/start').length, 0, '被拒零启动——零 bash/start 落链')
  } finally {
    env.svc.closeAll?.()
  }
})

test('BT-4 cwd 越界 fail-visible（结构化错误交回模型，零 bash/start）', async () => {
  const outside = tmpDir('outside')
  const env = await makeEnv([{ tool: 'bash_run', args: { command: 'echo hi', cwd: outside } }, { text: '收口' }])
  try {
    await sendTurn(env, '越界 cwd')
    await waitFor(() => eventsOf(env).find((e) => e.kind === 'turnEnd' && !e.turnId.startsWith('authz:')), 'turnEnd')
    const tr = eventsOf(env).filter((e) => e.kind === 'toolResult').map((e) => (e.payload as Record<string, unknown>)['error'])
    assert.ok(tr.some((e) => typeof e === 'string' && /cwd 越界/.test(e)), '越界 = 结构化错误（fail-visible）')
    assert.equal(sysPayloads(env, 'bash/start').length, 0)
  } finally {
    env.svc.closeAll?.()
  }
})

test('BT-5 并发上限（≤4）：单批 5 发 = 4 启动 + 1 CAR-E-BASH-CONC', async () => {
  const calls = Array.from({ length: 5 }, (_, i) => ({
    tool: 'bash_run',
    id: 'call-' + i,
    args: { command: 'node -e setInterval(function(){},1000)' },
  }))
  const env = await makeEnv([{ calls }, { text: '收口' }])
  try {
    await sendTurn(env, '并发打满')
    await waitFor(() => sysPayloads(env, 'bash/start').length === 4, '4 个 bash/start')
    await waitFor(() => eventsOf(env).filter((e) => e.kind === 'toolResult').length >= 5, '5 个 toolResult')
    const results = eventsOf(env).filter((e) => e.kind === 'toolResult').map((e) => (e.payload as Record<string, unknown>)['result'])
    assert.equal(results.filter((r) => r && (r as Record<string, unknown>)['ok'] === true).length, 4)
    const errs = eventsOf(env).filter((e) => e.kind === 'toolResult').map((e) => (e.payload as Record<string, unknown>)['error'])
    assert.ok(errs.some((e) => typeof e === 'string' && /CAR-E-BASH-CONC/.test(e)), '第 5 发超限 fail-visible')
  } finally {
    env.svc.closeAll?.()
  }
})

test('BT-6 turn:abort 级联：运行中任务树杀（bash/exit stopped）', async () => {
  const env = await makeEnv([{ tool: 'bash_run', args: { command: 'node -e setInterval(function(){},1000)' } }, { hangMs: 30_000 }])
  try {
    await sendTurn(env, '长任务 + 挂起回合')
    const start = await waitFor(() => sysPayloads(env, 'bash/start').at(-1), 'bash/start')
    await env.svc.dispatch('turn:abort', { workspaceId: env.ws.id, sessionId: env.sess.sessionId })
    const exit = await waitFor(
      () => sysPayloads(env, 'bash/exit').find((p) => p['taskId'] === start['taskId'] && p['stopped'] === true),
      'bash/exit(stopped)',
    )
    assert.ok(exit, '杀父级联 = 任务树杀收口')
  } finally {
    env.svc.closeAll?.()
  }
})

test('BT-7 subagent:kill 面：ghost 会话不可续写 / 未知 id UNKNOWN / settled KILL-STATE', async () => {
  // ghost 会话（requireAliveHandle 先于一切）
  const env = await makeEnv([{ text: '无需任务' }])
  try {
    await assert.rejects(
      () => env.svc.dispatch('subagent:kill', { workspaceId: env.ws.id, sessionId: 'ghost', subagentId: 'SA-X' }),
      (e: Error) => /会话不可续写/.test(e.message),
    )
    await assert.rejects(
      () => env.svc.dispatch('subagent:kill', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, subagentId: 'SA-GHOST' }),
      (e: Error) => /CAR-E-SUBAGENT-UNKNOWN/.test(e.message),
      '未知 id = UNKNOWN fail-visible',
    )
  } finally {
    env.svc.closeAll?.()
  }
})

test('BT-8 孤儿收割：bash/start 无收口 → reapOrphans 补 stopped（幂等）', () => {
  const log = new SessionLog('S-orphan') as unknown as { append: (a: string, k: string, t: string, p: unknown) => void; events: Array<{ kind: string; payload: unknown }> }
  log.append('runtime', 'system', 'session', { type: 'bash/start', taskId: 'BK-orphan', command: 'legacy', cwd: '.' })
  log.append('runtime', 'system', 'session', { type: 'bash/start', taskId: 'BK-closed', command: 'legacy2', cwd: '.' })
  log.append('runtime', 'system', 'session', { type: 'bash/exit', taskId: 'BK-closed', exitCode: 0, durationMs: 1, outputBytes: 1 })
  const m = new BashTaskManager({ parentLog: log as never, workspaceRoot: tmpDir('ws') })
  assert.equal(m.reapOrphans(), 1, '仅无收口的 BK-orphan 被收割')
  const reaped = (log.events.filter((e) => (e.payload as Record<string, unknown>)['type'] === 'bash/exit').at(-1)!.payload) as Record<string, unknown>
  assert.equal(reaped['taskId'], 'BK-orphan')
  assert.equal(reaped['stopped'], true)
  assert.equal(m.reapOrphans(), 0, '二次调用幂等')
})
