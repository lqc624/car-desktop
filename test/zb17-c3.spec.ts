/**
 * zb17 · C3（WB-1 readonly 策略声明面裁剪）行为测试（SessionHandle 直构单元 + 宿主 E2E）
 *
 * 判据：
 *  - 面断言：default 全量 → readonly 仅 readonly 声明（fs_read 保留，write 面藏）→ 切回恢复
 *    原列表（原位裁/恢复——引用稳定 = 活引用语义不破，R-DRILL-1 纪律）；
 *  - 出生即 readonly（securitySettings 默认值）= 面裁剪立即生效；
 *  - E2E：readonly 下 bash_run = authorization-denied（BT-3 同判据——执行注册表全量，门保留
 *    实证）+ readonly 下 fs_read 通路不受影响 + 切回 default 后写工具恢复可用。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { SessionHandle } from '../src/host-core/session-handle.ts'
import { createHostService, type HostService, type PushMessage } from '../src/host-core/service.ts'
import type { SessionEventDTO, SessionEventPush, WorkspaceInfo } from '../src/shared/ipc-contract.ts'
import type { SessionHandle as HandleT } from '../src/host-core/session-handle.ts'
import type { HostModelStep } from '../src/host-core/types.ts'

function tmpDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `car-zb17-c3-`))
}

// ==================== 面断言（SessionHandle 直构） ====================

function makeHandle(userData: string, defaultPolicy?: 'default' | 'readonly'): HandleT {
  const sessionsDir = join(userData, 'sessions')
  mkdirSync(sessionsDir, { recursive: true }) // SessionFileStore fsync open 需目录在位
  return SessionHandle.createFresh({
    sessionId: 's-c3',
    workspaceId: 'w-c3',
    workspaceRoot: userData,
    configModel: 'test-model',
    modelError: null,
    deps: {
      workspaceId: 'w-c3',
      authzTimeoutMs: 1000,
      sessionsDir,
      emitEvent: () => {},
      contextWindow: null,
      ...(defaultPolicy ? { securitySettings: () => ({ sessionDefaultPolicy: defaultPolicy }) as never } : {}),
    },
  })
}

const namesOf = (h: HandleT): string[] => h.tools.map((t) => t.name)

test('C3·面断言：default 全量 → readonly 仅 readonly 声明（原位裁）→ 切回恢复（引用稳定）', () => {
  const h = makeHandle(tmpDir('ud'))
  const before = namesOf(h)
  assert.ok(before.includes('fs_write') && before.includes('fs_read') && before.includes('fs_delete'), 'default = 三件套全量')
  // 活引用捕获（attachRuntimeModel 形态复刻——toolDefs 是同一数组引用）
  const liveRef = h.tools
  h.setPolicy('readonly')
  assert.deepEqual(namesOf(h), ['fs_read'], 'readonly = 仅 readonly 声明（write 面藏）')
  assert.equal(liveRef.length, 1, '原位裁剪——捕获引用同步可见（活引用语义保持）')
  h.setPolicy('default')
  assert.deepEqual(namesOf(h), before, '切回恢复原列表（保序）')
  assert.equal(h.tools, liveRef, '数组引用恒等（禁换新数组——R-DRILL-1 纪律）')
})

test('C3·出生即 readonly：面裁剪立即生效（securitySettings 默认值路径）', () => {
  const h = makeHandle(tmpDir('ud2'), 'readonly')
  assert.deepEqual(namesOf(h), ['fs_read'], '出生即 readonly = 面藏即时生效')
  h.setPolicy('default')
  assert.ok(namesOf(h).includes('fs_write'), '切回恢复')
})

// ==================== E2E（宿主公共 API——BT-3 同判据复跑） ====================

interface Env {
  svc: HostService
  ws: WorkspaceInfo
  sess: { sessionId: string }
  pushes: PushMessage[]
}

function makeEnv(script: (h: HandleT) => HostModelFn): Env {
  const userData = tmpDir('ud-e2e')
  const root = tmpDir('ws')
  writeFileSync(join(root, 'car.config.ts'), "export default { llm: { baseUrl: 'http://127.0.0.1:9', model: 'test-model' } }\n", 'utf8')
  const svc = createHostService({ userDataDir: userData, modelFnOverride: script })
  const pushes: PushMessage[] = []
  svc.onPush((m) => pushes.push(m))
  return { svc, ws: null!, sess: null!, pushes }
}

type HostModelFn = () => Promise<HostModelStep>

function eventsOf(env: Env): SessionEventDTO[] {
  return env.pushes.filter((m) => m.topic === 'push:session-event').map((m) => (m.payload as SessionEventPush).event)
}

async function waitForTurnEnd(env: Env, timeoutMs = 5000, atLeastBefore = 0): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const n = eventsOf(env).filter((x) => x.kind === 'turnEnd' && !x.turnId.startsWith('authz:')).length
    if (n > atLeastBefore) return
    if (Date.now() > deadline) throw new Error('waitForTurnEnd 超时')
    await new Promise((r) => setTimeout(r, 20))
  }
}

async function respondAuthzOnce(env: Env): Promise<void> {
  const deadline = Date.now() + 8000
  for (;;) {
    const pend = env.pushes.filter((m) => m.topic === 'push:authz-pending').at(-1)
    if (pend) {
      await env.svc.dispatch('authz:respond', {
        workspaceId: env.ws.id,
        sessionId: env.sess.sessionId,
        requestId: (pend.payload as Record<string, unknown>)['requestId'],
        decision: 'once',
      })
      return
    }
    if (Date.now() > deadline) throw new Error('authz pending 未推送')
    await new Promise((r) => setTimeout(r, 15))
  }
}

test('C3 E2E：readonly 下 bash_run/fs_write = authorization-denied（门保留）+ fs_read 通路不受影响 + 切回恢复', async () => {
  const root = tmpDir('ws3')
  writeFileSync(join(root, 'car.config.ts'), "export default { llm: { baseUrl: 'http://127.0.0.1:9', model: 'test-model' } }\n", 'utf8')
  writeFileSync(join(root, 'note.txt'), 'hello', 'utf8')
  let calls = 0
  const svc = createHostService({
    userDataDir: tmpDir('ud3'),
    modelFnOverride: () => async () => {
      calls++
      // readonly 回合（turn 1）：bash_run 拒 → fs_read 放行 → fs_write 拒——单回合三判据
      if (calls === 1) return { stopReason: 'toolUse', toolCalls: [{ id: 'c1', tool: 'bash_run', args: { command: 'node -e console.log(1)' } }] } as HostModelStep
      if (calls === 2) return { stopReason: 'toolUse', toolCalls: [{ id: 'c2', tool: 'fs_read', args: { path: 'note.txt' } }] } as HostModelStep
      if (calls === 3) return { stopReason: 'toolUse', toolCalls: [{ id: 'c3', tool: 'fs_write', args: { path: 'out.txt', content: 'x' } }] } as HostModelStep
      if (calls === 5) return { stopReason: 'toolUse', toolCalls: [{ id: 'c4', tool: 'fs_write', args: { path: 'out.txt', content: 'written-after-default' } }] } as HostModelStep
      return { stopReason: 'stop', text: 'done' }
    },
  })
  const env: Env = { svc, ws: null!, sess: null!, pushes: [] }
  svc.onPush((m) => env.pushes.push(m))
  try {
    env.ws = (await svc.dispatch('workspace:register', { path: root })) as WorkspaceInfo
    env.sess = (await svc.dispatch('session:create', { workspaceId: env.ws.id })) as { sessionId: string }
    await svc.dispatch('session:set-policy', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, policy: 'readonly' })
    // ① readonly 回合：bash_run 拒 + fs_read 放行 + fs_write 拒（三判据同回合）
    await svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, text: '读写跑' })
    await waitForTurnEnd(env)
    const tr = eventsOf(env).filter((e) => e.kind === 'toolResult').map((e) => e.payload as Record<string, unknown>)
    assert.ok(tr.some((p) => p['id'] === 'c1' && p['error'] === 'authorization-denied'), 'bash_run readonly 硬拒（门拦层保留——BT-3 同判据）')
    assert.ok(tr.some((p) => p['id'] === 'c2' && typeof p['result'] === 'object' && String((p['result'] as Record<string, unknown>)['content']).includes('hello')), 'fs_read 通路不受影响（保留面在册）')
    assert.ok(tr.some((p) => p['id'] === 'c3' && p['error'] === 'authorization-denied'), 'fs_write readonly 硬拒（面藏 + 门拦双层）')
    // ② 切回 default → fs_write 恢复可用（出厂写规则 = ask pending → once 放行；C6 sha256 回执在场）
    const before = eventsOf(env).filter((x) => x.kind === 'turnEnd' && !x.turnId.startsWith('authz:')).length
    await svc.dispatch('session:set-policy', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, policy: 'default' })
    await svc.dispatch('turn:send', { workspaceId: env.ws.id, sessionId: env.sess.sessionId, text: '写文件' })
    await respondAuthzOnce(env)
    await waitForTurnEnd(env, 8000, before)
    await new Promise((r) => setTimeout(r, 100))
    const tr2 = eventsOf(env).filter((e) => e.kind === 'toolResult').map((e) => e.payload as Record<string, unknown>)
    assert.ok(
      tr2.some((p) => {
        if (p['id'] !== 'c4') return false
        const inner = (p['result'] ?? null) as Record<string, unknown> | null
        const sha = typeof p['sha256'] === 'string' ? p['sha256'] : typeof inner?.['sha256'] === 'string' ? (inner['sha256'] as string) : null
        const ok = p['ok'] === true || (inner != null && inner['ok'] === true)
        return ok && sha != null
      }),
      '切回 default 后 fs_write 恢复（C6 sha256 回执在场——result 嵌套形态）',
    )
  } finally {
    svc.dispose()
  }
})
