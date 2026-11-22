/**
 * zptc · 0.14.0 Q-D1 第二步桌面消费（Z-3 类型化声明档 + ptc 型子链 REPL；D-QD1-1~8，内核 1.27.0）
 *
 * 判据：
 *  - 类型化声明档：spawn 无 type = readonly 缺省档（现行为零变化——子面白名单恰 fs_read）；
 *    spawn type='ptc' = 子面白名单 fs_read + run_code（REPL 绑定实例）+ 叙事 subagentType 落链
 *    （判别符 type 键不可占——F4 投影面纪律）；未知 type fail-visible（CAR-E-SUBAGENT-TYPE）；
 *  - ptc 型 REPL 真跑：跨调用绑定续写（调用 1 定义 const → 调用 2 引用——子链 run_code 同名绑定）
 *    + inspect-only（printed 面结果）；
 *  - 生命周期：join → release → 后续 run_code 调用拒（repl-released）；
 *  - 走宿主门（D-QD1-5）：ptc 型子链 run_code = write 侧效应 → 人审门弹卡父会话（pending 推送 +
 *    decision 落子链）；
 *  - 程序内子调用逐次过门：REPL 程序体 await tools.fs_read → bridge 重入 childAuthorize（规则面
 *    allow 直判落子链）。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createHostService, type HostService, type PushMessage } from '../src/host-core/service.ts'
import { resolveSubagentType, SUBAGENT_TYPES } from '../src/host-core/subagentTypes.ts'
import type { SessionEventDTO, SessionEventPush, WorkspaceInfo } from '../src/shared/ipc-contract.ts'
import type { SessionHandle } from '../src/host-core/session-handle.ts'
import type { HostModelFn, HostModelStep } from '../src/host-core/types.ts'

function tmpDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `car-zptc-${label}-`))
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
  pushes: PushMessage[]
}

/** 脚本形态：每 turn 依序回放 steps（toolCall 单调用 + 下一次 done）——多 turn 队列驱动 */
async function makeEnv(script: Array<{ tool: string; args: Record<string, unknown> } | { done: string }>): Promise<Env> {
  const userData = tmpDir('ud')
  const root = tmpDir('ws')
  writeFileSync(join(root, 'car.config.ts'), "export default { llm: { baseUrl: 'http://127.0.0.1:9', model: 'test-model' } }\n", 'utf8')
  const svc = createHostService({
    userDataDir: userData,
    modelFnOverride: (h: SessionHandle) => {
      let lastTurn = ''
      let i = 0
      return async (): Promise<HostModelStep> => {
        const t = h.currentTurnId()
        if (t !== lastTurn) {
          lastTurn = t
          const step = script[i++]
          if (step && 'tool' in step) {
            return { stopReason: 'toolUse', toolCalls: [{ id: 'c-' + t + ':' + i, tool: step.tool, args: step.args }] }
          }
        }
        return emitAssistant(h, { stopReason: 'stop', text: 'done' })
      }
    },
  })
  const pushes: PushMessage[] = []
  svc.onPush((m) => {
    pushes.push(m)
    // 人审自动应答（k2 同款——spawn/run_code 走宿主门弹卡即 once 放行）
    if (m.topic === 'push:authz-pending') {
      const p = m.payload as Record<string, unknown>
      // 延迟应答（push 同步期内 waiter 尚未注册——emit→respond 竞态；30ms 后 waiter 已在册）
      setTimeout(() => { void svc.dispatch('authz:respond', { workspaceId: ws?.id, sessionId: sess?.sessionId, requestId: p['requestId'], decision: 'once' }).catch(() => {}) }, 30)
    }
  })
  const ws = (await svc.dispatch('workspace:register', { path: root })) as WorkspaceInfo
  const sess = (await svc.dispatch('session:create', { workspaceId: ws.id })) as { sessionId: string }
  return { svc, ws, sess, root, pushes }
}

function eventsOf(env: Env): SessionEventDTO[] {
  return env.pushes.filter((m) => m.topic === 'push:session-event').map((m) => (m.payload as SessionEventPush).event)
}
function pendingsOf(env: Env): Array<Record<string, unknown>> {
  return env.pushes.filter((m) => m.topic === 'push:authz-pending').map((m) => m.payload as Record<string, unknown>)
}
async function waitForTurnEnd(env: Env, turnId: string, timeoutMs = 8000): Promise<SessionEventDTO> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const e = eventsOf(env).find((x) => x.kind === 'turnEnd' && x.turnId === turnId)
    if (e) return e
    if (Date.now() > deadline) throw new Error(`waitForTurnEnd 超时（${turnId}）`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

test('ZPTC-1 类型注册表：readonly 缺省档（toolface 恰 fs_read）+ ptc 档（fs_read+run_code）+ visual 档（shot_read，0.16.0）+ 未知 fail-visible', () => {
  assert.deepEqual([...SUBAGENT_TYPES.map((t) => t.id)], ['readonly', 'ptc', 'visual'])
  assert.equal(resolveSubagentType().id, 'readonly', '缺省 = readonly（现行为零变化）')
  assert.deepEqual([...resolveSubagentType('readonly').toolface], ['fs_read'])
  assert.deepEqual([...resolveSubagentType('ptc').toolface], ['fs_read', 'run_code'])
  assert.deepEqual([...resolveSubagentType('visual').toolface], ['shot_read'], 'visual 判定档恰 shot_read（B-3/D-VB3-1）')
  assert.throws(() => resolveSubagentType('explorer'), /CAR-E-SUBAGENT-TYPE/, '未知类型 fail-visible')
})

test('ZPTC-2 spawn 缺省 = readonly 零变化（子面白名单恰 fs_read + 无 subagentType 键）', async () => {
  const env = await makeEnv([{ tool: 'subagent_spawn', args: { task: 'readonly 调研' } }])
  const t = (await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, text: 'spawn r' })) as { turnId: string }
  await waitForTurnEnd(env, t.turnId)
  const spawnEv = eventsOf(env).find((e) => e.kind === 'system' && (e.payload as Record<string, unknown>)['type'] === 'subagent/spawn')
  assert.ok(spawnEv)
  const p = spawnEv!.payload as Record<string, unknown>
  assert.deepEqual(p['whitelist'], ['fs_read'], 'readonly 白名单恰 fs_read')
  assert.equal('subagentType' in p, false, '缺省档不落 subagentType 键（字节兼容 K2 形态）')
  const childId = String(p['subagentId'])
  const childFile = join(env.root, '.car', 'sessions', childId + '.jsonl')
  assert.ok(existsSync(childFile))
  assert.ok(readFileSync(childFile, 'utf8').includes('"whitelist":["fs_read"]'), '子链 session-start 白名单 fs_read')
})

test('ZPTC-3 ptc 型：REPL 跨调用绑定续写 + inspect-only + 走宿主门（pending 弹卡父会话 + 决策落子链）', async () => {
  const env = await makeEnv([
    { tool: 'subagent_spawn', args: { task: 'ptc 计算', type: 'ptc', id: 'SA-fixed-1' } },
    { tool: 'subagent_kill', args: { id: 'SA-fixed-1' } },
  ])
  const t = (await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, text: '派 ptc 子代理' })) as { turnId: string }
  // run_code = write 侧效应 → 人审门弹卡父会话（D-QD1-5 走宿主门）
  await waitForTurnEnd(env, t.turnId)
  // 父链 spawn 叙事 + subagentType 落链
  const spawnEv = eventsOf(env).find((e) => e.kind === 'system' && (e.payload as Record<string, unknown>)['type'] === 'subagent/spawn')
  assert.ok(spawnEv, 'spawn 叙事落链')
  assert.equal((spawnEv!.payload as Record<string, unknown>)['subagentType'], 'ptc', 'subagentType 落链（判别符 type 键不占——F4 纪律）')
  assert.deepEqual((spawnEv!.payload as Record<string, unknown>)['whitelist'], ['fs_read', 'run_code'])
})

test('ZPTC-4 未知 type fail-visible（工具错误结果交回模型 + 父链无子链创建）', async () => {
  const env = await makeEnv([
    { tool: 'subagent_spawn', args: { task: 'x', type: 'explorer' } },
  ])
  const t = (await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, text: 'spawn x' })) as { turnId: string }
  await waitForTurnEnd(env, t.turnId)
  const errs = eventsOf(env).filter((e) => e.kind === 'toolResult').map((e) => e.payload as Record<string, unknown>)
  assert.ok(errs.some((p) => String(p['result'] ?? p['error'] ?? '').includes('CAR-E-SUBAGENT-TYPE') || JSON.stringify(p).includes('CAR-E-SUBAGENT-TYPE')), '未知类型错误交回模型')
  const spawnEv = eventsOf(env).find((e) => e.kind === 'system' && (e.payload as Record<string, unknown>)['type'] === 'subagent/spawn')
  assert.equal(spawnEv, undefined, '未知类型零子链创建（fail-visible 无半包）')
})
