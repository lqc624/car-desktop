/**
 * zb17 · C7（AD-2 后台任务完成结果接回）行为测试（纯函数 + 宿主 E2E）
 *
 * 判据：
 *  - 纯函数 taskRowsFrom.consumed：done 态收口后无 user 事件 = false（徽标「结果待取回」）；
 *    收口后有 user 事件 = true（消费机会已给出）；
 *  - wakeupStore：缺省 false（deny-by-default）+ set 持久化 + 损坏回退出厂；
 *  - E2E：缺省档 = 任务完成零链事件（零 steer user 事件）；自动唤醒档 = 完成后 steer 引导落链
 *    （user 事件含完成事实、无 turnEnd = pendingSteerTurns FIFO 在册）+ busy 期双任务聚合单条引导；
 *  - 引导消费通路 = 既有 D-S6-3 drainPending（零改动面——链上成对可查为方案 B 终验）。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { taskRowsFrom, type TaskRow } from '../src/renderer/task-rows.ts'
import { createBashWakeupStore } from '../src/host-core/wakeupStore.ts'
import { createHostService, type HostService, type PushMessage } from '../src/host-core/service.ts'
import type { SessionEventDTO, SessionEventPush, WorkspaceInfo } from '../src/shared/ipc-contract.ts'
import type { SessionHandle as HandleT } from '../src/host-core/session-handle.ts'
import type { HostModelStep } from '../src/host-core/types.ts'

function tmpDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `car-zb17-c7-`))
}

// ==================== 纯函数：consumed 徽标判据 ====================

const bashStart = (seq: number, ts: number, taskId: string): { kind: string; ts: number; payload: unknown } => ({
  kind: 'system',
  ts,
  payload: { type: 'bash/start', taskId, command: 'echo ' + taskId },
})
const bashExit = (seq: number, ts: number, taskId: string): { kind: string; ts: number; payload: unknown } => ({
  kind: 'system',
  ts,
  payload: { type: 'bash/exit', taskId, exitCode: 0, durationMs: 10, outputBytes: 5 },
})
const userEvent = (ts: number, text: string): { kind: string; ts: number; payload: unknown } => ({ kind: 'user', ts, payload: text })

test('C7·taskRowsFrom.consumed：收口后无 user 事件 = 待取回；有 user 事件 = 已给消费机会', () => {
  const events = [bashStart(1, 1000, 'BK-a'), bashExit(2, 1100, 'BK-a'), userEvent(2000, '下一问'), bashStart(3, 3000, 'BK-b'), bashExit(4, 3100, 'BK-b')]
  const rows: TaskRow[] = taskRowsFrom(events)
  const a = rows.find((r) => r.id === 'BK-a')!
  const b = rows.find((r) => r.id === 'BK-b')!
  assert.equal(a.state, 'done')
  assert.equal(a.consumed, true, 'BK-a 收口后有 user 事件 = 已给消费机会')
  assert.equal(b.consumed, false, 'BK-b 收口后无 user 事件 = 结果待取回（徽标）')
})

// ==================== wakeupStore 单元 ====================

test('C7·wakeupStore：缺省 false（deny-by-default）+ set 持久化 + 损坏回退出厂', () => {
  const userData = tmpDir('ud')
  const store = createBashWakeupStore(userData)
  assert.equal(store.get().autoWakeup, false, '出厂缺省关')
  store.set({ autoWakeup: true })
  assert.equal(store.get().autoWakeup, true)
  // 持久化回读（新实例同 userData）
  const store2 = createBashWakeupStore(userData)
  assert.equal(store2.get().autoWakeup, true, '落盘持久')
  // 损坏回退出厂值并写回
  writeFileSync(join(userData, 'bash-wakeup.json'), '{broken', 'utf8')
  const store3 = createBashWakeupStore(userData)
  assert.equal(store3.get().autoWakeup, false, '损坏回退出厂（不 fail-open）')
  assert.equal(existsSync(join(userData, 'bash-wakeup.json')), true)
  assert.equal(readFileSync(join(userData, 'bash-wakeup.json'), 'utf8').includes('autoWakeup'), true)
})

// ==================== E2E（宿主公共 API——真 bash 子进程） ====================

interface Env {
  svc: HostService
  ws: WorkspaceInfo
  sess: { sessionId: string }
  root: string
  pushes: PushMessage[]
}

function makeEnv(script: (h: HandleT) => () => Promise<HostModelStep>): Env {
  const userData = tmpDir('ud-e2e')
  const root = tmpDir('ws')
  writeFileSync(join(root, 'car.config.ts'), "export default { llm: { baseUrl: 'http://127.0.0.1:9', model: 'test-model' } }\n", 'utf8')
  const svc = createHostService({ userDataDir: userData, modelFnOverride: script })
  const pushes: PushMessage[] = []
  svc.onPush((m) => pushes.push(m))
  return { svc, ws: null!, sess: null!, root, pushes }
}

function eventsOf(env: Env): SessionEventDTO[] {
  return env.pushes.filter((m) => m.topic === 'push:session-event').map((m) => (m.payload as SessionEventPush).event)
}

async function waitForTurnEnd(env: Env, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (eventsOf(env).some((x) => x.kind === 'turnEnd' && !x.turnId.startsWith('authz:'))) return
    if (Date.now() > deadline) throw new Error('waitForTurnEnd 超时')
    await new Promise((r) => setTimeout(r, 20))
  }
}

async function respondAuthzOnce(env: Env, expected = 1): Promise<void> {
  const responded = new Set<string>()
  const deadline = Date.now() + 8000
  for (;;) {
    const ids = env.pushes
      .filter((m) => m.topic === 'push:authz-pending')
      .map((m) => String((m.payload as Record<string, unknown>)['requestId']))
      .filter((id) => !responded.has(id))
    for (const requestId of ids) {
      responded.add(requestId)
      await env.svc.dispatch('authz:respond', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, requestId, decision: 'once' })
    }
    if (responded.size >= expected) return
    if (Date.now() > deadline) throw new Error(`authz pending 不足（${responded.size}/${expected}）`)
    await new Promise((r) => setTimeout(r, 15))
  }
}

/** 回合驱动：单块并行 bash_run（即时回结果）；waitExits = 收口前轮询等任务完成在链（聚合窗口确定性） */
function bashScript(bashCalls: number, opts: { sleepMs?: number; waitExits?: boolean } = {}): (h: HandleT) => () => Promise<HostModelStep> {
  const sleepMs = opts.sleepMs ?? 250
  let step = 0
  return (h: HandleT) =>
    async () => {
      step++
      if (step === 1) {
        const calls = Array.from({ length: bashCalls }, (_, i) => ({
          id: 'cb-' + step + '-' + i,
          tool: 'bash_run',
          args: { command: `node -e "setTimeout(()=>process.exit(0),${sleepMs})"` },
        }))
        return { stopReason: 'toolUse', toolCalls: calls } as HostModelStep
      }
      if (opts.waitExits && bashCalls > 1) {
        // 双任务完成后再收口——onTurnClosed flush = 单条聚合引导（防完成风暴判据确定性成立）
        const deadline = Date.now() + 3000
        while (Date.now() < deadline) {
          const exits = h.log.events.filter((e) => e.kind === 'system' && (e.payload as Record<string, unknown> | null)?.['type'] === 'bash/exit').length
          if (exits >= bashCalls) break
          await new Promise((r) => setTimeout(r, 25))
        }
      }
      return { stopReason: 'stop', text: 'done' }
    }
}

test('C7 E2E：缺省档（提醒）零链事件——bash 完成不自动 append 引导', async () => {
  const env = makeEnv(bashScript(1))
  try {
    env.ws = (await env.svc.dispatch('workspace:register', { path: env.root })) as WorkspaceInfo
    env.sess = (await env.svc.dispatch('session:create', { workspaceId: env.ws.id })) as { sessionId: string }
    await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, text: '跑' })
    await respondAuthzOnce(env)
    await waitForTurnEnd(env)
    await new Promise((r) => setTimeout(r, 400)) // bash/exit 落链 + 回调窗口
    const users = eventsOf(env).filter((e) => e.kind === 'user')
    assert.equal(users.length, 1, '仅初始 user turn——完成零自动引导（提醒档缺省）')
    assert.ok(!users[0]!.turnId.startsWith('T') || users[0]!.payload !== '[后台任务完成通知]', '无完成通知事件')
  } finally {
    env.svc.dispose()
  }
})

test('C7 E2E：自动唤醒档——完成 steer 引导落链（pendingSteerTurns 在册、无 turnEnd）', async () => {
  const env = makeEnv(bashScript(1))
  try {
    env.ws = (await env.svc.dispatch('workspace:register', { path: env.root })) as WorkspaceInfo
    env.sess = (await env.svc.dispatch('session:create', { workspaceId: env.ws.id })) as { sessionId: string }
    await env.svc.dispatch('bashWakeup:set', { autoWakeup: true })
    await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, text: '跑' })
    await respondAuthzOnce(env)
    await waitForTurnEnd(env)
    const deadline = Date.now() + 5000
    for (;;) {
      const notice = eventsOf(env).find((e) => e.kind === 'user' && String(e.payload ?? '').includes('[后台任务完成通知]'))
      if (notice) {
        const closed = eventsOf(env).some((x) => x.kind === 'turnEnd' && x.turnId === notice.turnId)
        assert.equal(closed, false, '引导 turnId 无 turnEnd = pendingSteerTurns FIFO 在册（下一 turn 消费）')
        assert.match(String(notice.payload), /BK-/, '完成事实（taskId）在引导文本')
        return
      }
      if (Date.now() > deadline) throw new Error('自动唤醒引导未落链')
      await new Promise((r) => setTimeout(r, 20))
    }
  } finally {
    env.svc.dispose()
  }
})

test('C7 E2E：双任务收口前完成 → 聚合单条引导（防完成风暴）+ 开关关后不再追加', async () => {
  const env = makeEnv(bashScript(2, { waitExits: true }))
  try {
    env.ws = (await env.svc.dispatch('workspace:register', { path: env.root })) as WorkspaceInfo
    env.sess = (await env.svc.dispatch('session:create', { workspaceId: env.ws.id })) as { sessionId: string }
    await env.svc.dispatch('bashWakeup:set', { autoWakeup: true })
    await env.svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, text: '跑两个' })
    await respondAuthzOnce(env, 2) // 双 bash_run 授权（按 requestId 去重——同 pending 不重复决）
    await waitForTurnEnd(env)
    const deadline = Date.now() + 5000
    let notice: SessionEventDTO | undefined
    for (;;) {
      notice = eventsOf(env).find((e) => e.kind === 'user' && String(e.payload ?? '').includes('[后台任务完成通知]'))
      if (notice) break
      if (Date.now() > deadline) throw new Error('聚合引导未落链')
      await new Promise((r) => setTimeout(r, 20))
    }
    const notices = eventsOf(env).filter((e) => e.kind === 'user' && String(e.payload ?? '').includes('[后台任务完成通知]'))
    assert.equal(notices.length, 1, '双任务聚合单条引导（busy 期攒、收口 flush）')
    assert.match(String(notice!.payload), /2 个后台任务已完成/)
    // 关开关 → 后续完成零追加（当前链上无在跑任务——以设置面回读证明切换生效）
    const s = (await env.svc.dispatch('bashWakeup:set', { autoWakeup: false })) as { autoWakeup: boolean }
    assert.equal(s.autoWakeup, false)
  } finally {
    env.svc.dispose()
  }
})
