/**
 * K2（1.16 子 Agent 最小闭环）行为测试——宿主侧组合形态，内核 runTurn 真跑（行为证明）
 *
 * 覆盖（K2 规划 §2）：
 *  1. spawn→join 全链 E2E：编排事件父链可见 + 子链独立 JSONL（parent 载荷 + 链完整）+
 *     摘要回父 + 子链 usage 汇总事件（subagent/usage，parentTurnId 归因）；
 *  2. 子面白名单反证：子模型回调 toolDefs 仅 fs_read（编排/写类不进子面）；越权工具
 *     在子面被拒且落链（unknown tool toolResult）；
 *  3. 授权门代理父：子 fs_read 人审弹窗在父（pending 携父 sessionId）、决策审计落子链
 *     （authz:* turnEnd 在子链不在父链）；
 *  4. 护栏 fail-visible：并发 >3 结构化错误（CAR-E-SUBAGENT-CONC）；累计 >10（CAR-E-SUBAGENT-CUM）；
 *  5. kill + 父 abort 级联：子链以 aborted 收口（运行期取消——与 interrupted 不混用）；
 *  6. 恢复幂等（K1 POC 四形态转正式）：崩溃态子链 open 恢复补记 interrupted ×1、
 *     重复 open 全零、断链子链只读跳过不阻塞父链恢复；
 *  7. 删除级联：删父 = 子链索引随父标记（文件保留）；
 *  8. seam 门禁：1.16.0 符号面运行时零 subagent 加法（版本 + 计数 + 方向断言；SubagentConfig
 *     为类型面加法——K3 / D-K2-2 合法通道）。
 *  9. K3（D-K2-2）：`llm.subagent` 三键——model 覆盖直达子链 start 载荷 + 模型回调锚点；
 *     maxConcurrent=1 并发拒（错误数值随配置）；maxCumulative=2 累计拒；guards 落链真值。
 * 10. K3 压过口径：modelPool 在场 = subagent.model 被池压过（子锚点回落父现值，与 llm.model 同口径）。
 * 11. K3 压过口径：端点覆盖（R-D6 key-push）在场 = subagent.model 被端点压过（子锚点 = 端点 model）。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadSessionLog } from '@lqc123qwe/car-runtime'
import { createHostService, type HostService, type PushMessage } from '../src/host-core/service.ts'
import { probeSeam } from '../src/host-core/probe.ts'
import type { WorkspaceInfo } from '../src/shared/ipc-contract.ts'
import type { SessionHandle } from '../src/host-core/session-handle.ts'
import type { ChildModelFnOpts } from '../src/host-core/subagent.ts'

function tmpDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `car-k2-${label}-`))
}

function makeWorkspace(label: string): { root: string; ws: (svc: HostService) => Promise<WorkspaceInfo> } {
  const root = tmpDir(label)
  writeFileSync(join(root, 'car.config.ts'), "export default { llm: { baseUrl: 'http://127.0.0.1:9', model: 'test-model' } }\n", 'utf8')
  return { root, ws: async (svc) => (await svc.dispatch('workspace:register', { path: root })) as WorkspaceInfo }
}

/** 授权自动应答器：pending 推送即答（缺省 session——同工具后续免弹窗；可按 requestId 前缀覆写）。
 *  回包须推迟一个宏任务：emitAuthzPending 与 waitAuthzDecision 注册同处一个同步栈
 *  （session-handle authorize 门），栈内同步回包会在注册前抵达 →「不存在或已决」。 */
function autoAuthz(svc: HostService, pushes: PushMessage[], decide?: (requestId: string) => 'once' | 'session' | 'deny'): void {
  svc.onPush((m) => {
    pushes.push(m)
    if (m.topic === 'push:authz-pending') {
      const p = m.payload as { requestId: string }
      const decision = decide ? decide(p.requestId) : 'session'
      setTimeout(() => {
        void svc.dispatch('authz:respond', { requestId: p.requestId, decision }).catch(() => { /* 已决/超时 = 测试环境噪声 */ })
      }, 0)
    }
  })
}

/** 父模型脚本：按序消费 steps（toolUse 批 / stop 文本）；stop 文本复刻 chatStep assistant 落链；脚本尽 = stop */
function scriptedParentModel(steps: Array<{ tool?: string; id?: string; args?: Record<string, unknown>; text?: string; hangMs?: number }>) {
  return (h: SessionHandle) => {
    let i = 0
    return async () => {
      const s = steps[i++] ?? { text: '（脚本尽——自然收口）' }
      if (s.hangMs) await new Promise((r) => setTimeout(r, s.hangMs))
      if (s.tool) {
        return { stopReason: 'toolUse' as const, toolCalls: [{ id: s.id ?? 'call-' + i, tool: s.tool, args: s.args ?? {} }] }
      }
      const text = s.text ?? ''
      if (text.length > 0) h.log.append('model', 'assistant', h.currentTurnId(), text)
      return { stopReason: 'stop' as const, text }
    }
  }
}

/** 子模型脚本：按子 sessionId 分剧本（缺省剧本 = 立即 stop）；assistant 复刻落链；signal 感知（aborted 后让路） */
function scriptedChildModel(
  scripts: Record<string, Array<{ tool?: string; args?: Record<string, unknown>; text?: string; hangMs?: number }>>,
  captured?: { toolDefsByChild: Record<string, string[]> },
) {
  return (o: ChildModelFnOpts) => {
    const sid = o.log.sessionId
    if (captured) captured.toolDefsByChild[sid] = o.toolDefs.map((t) => t.name)
    const steps = scripts[sid] ?? [{ text: '子结论：默认完成' }]
    let i = 0
    return async () => {
      const s = steps[i++] ?? { text: '子结论：完成' }
      if (s.hangMs) {
        await new Promise<void>((resolve) => {
          const t = setInterval(() => {
            if (o.signal.aborted) { clearInterval(t); resolve() }
          }, 10)
          setTimeout(() => { clearInterval(t); resolve() }, s.hangMs)
        })
        if (o.signal.aborted) {
          // 生产中止形态 = 内核 chatStep 抛内部 TurnAborted（seam 不导出）；脚本复刻等效路径：
          // 让路一个空转工具批，内核循环顶信号检查以 aborted 收口（成对补记 = 内核取消纪律）
          return { stopReason: 'toolUse' as const, toolCalls: [{ id: 'yield-abort', tool: '__abort_yield__', args: {} }] }
        }
      }
      if (s.tool) {
        return { stopReason: 'toolUse' as const, toolCalls: [{ id: 'cc-' + i, tool: s.tool, args: s.args ?? {} }] }
      }
      if (s.text && s.text.length > 0) o.log.append('model', 'assistant', 'T1', s.text)
      return { stopReason: 'stop' as const, text: s.text ?? '' }
    }
  }
}

/** 轮询父会话直至出现满足条件的 turnEnd（超时 fail） */
async function waitTurnEnd(
  svc: HostService,
  wid: string,
  sid: string,
  pred: (e: { kind: string; turnId: string; meta?: Record<string, unknown> }) => boolean,
  timeoutMs = 15_000,
): Promise<void> {
  const t0 = Date.now()
  for (;;) {
    const rep = (await svc.dispatch('audit:report', { workspaceId: wid, sessionId: sid })) as {
      events: Array<{ kind: string; turnId: string; meta?: Record<string, unknown> }>
    }
    if (rep.events.some((e) => e.kind === 'turnEnd' && !e.turnId.startsWith('authz:') && pred(e))) return
    if (Date.now() - t0 > timeoutMs) throw new Error('等待 turn 收口超时')
    await new Promise((r) => setTimeout(r, 50))
  }
}

function chainEvents(svc: HostService, wid: string, root: string, sid: string): Array<Record<string, unknown>> {
  void svc
  const loaded = loadSessionLog(join(root, '.car', 'sessions', sid + '.jsonl'))
  assert.equal(loaded.brokenAt, null, `子链 ${sid} 哈希链必须完整`)
  return loaded.log.events as unknown as Array<Record<string, unknown>>
}

function systemPayloads(events: Array<Record<string, unknown>>, type: string): Array<Record<string, unknown>> {
  return events.filter((e) => e['kind'] === 'system' && (e['payload'] as Record<string, unknown> | null)?.['type'] === type).map((e) => e['payload'] as Record<string, unknown>)
}

// ── 1/2/3：spawn→join 全链 + 白名单反证 + 授权代理父（同一会话流内分断言） ──

test('K2: spawn→join 全链 E2E——编排事件父链可见 + 子链独立完整 + 摘要回父 + usage 汇总落子链', async () => {
  const { root, ws } = makeWorkspace('e2e')
  const captured: { toolDefsByChild: Record<string, string[]> } = { toolDefsByChild: {} }
  const svc = createHostService({
    userDataDir: tmpDir('ud'),
    authzTimeoutMs: 120_000,
    modelFnOverride: scriptedParentModel([
      { tool: 'subagent_spawn', id: 'call-spawn', args: { task: '调研 note.txt 内容并总结', id: 'SA-E2E' } },
      { tool: 'subagent_join', id: 'call-join', args: { id: 'SA-E2E' } },
      { text: '父收口：已拿到子结论' },
    ]),
    childModelFnOverride: scriptedChildModel(
      { 'SA-E2E': [{ tool: 'fs_read', args: { path: 'askme/note.txt' } }, { text: '子结论：note 内容已调研完成' }] },
      captured,
    ),
  })
  const pushes: PushMessage[] = []
  autoAuthz(svc, pushes, (requestId) => (requestId.includes(':fs_read:') ? 'once' : 'session'))
  const w = await ws(svc)
  // 出厂预设工作区读取=allow（规则面直批）；本测试要验证子链人审门——设 ask 目录让读取落入人审
  await svc.dispatch('fileSecurity:set', {
    rules: [
      { id: 'r-ask-dir', path: join(root, 'askme') + '\\', read: 'ask', write: 'ask', delete: 'ask' },
      { id: 'r-car-deny', path: join(root, '.car') + '\\', read: 'deny', write: 'deny', delete: 'deny' },
      { id: 'preset-workspace', path: root + '\\', read: 'allow', write: 'ask', delete: 'ask' },
    ],
  })
  mkdirSync(join(root, 'askme'), { recursive: true })
  writeFileSync(join(root, 'askme', 'note.txt'), 'K2 测试正文——子 Agent 可读', 'utf8')
  const sess = (await svc.dispatch('session:create', { workspaceId: w.id })) as { sessionId: string }
  await svc.dispatch('turn:send', { workspaceId: w.id, sessionId: sess.sessionId, text: '派生子 Agent 调研 note.txt' })
  await waitTurnEnd(svc, w.id, sess.sessionId, (e) => (e.meta as Record<string, unknown>)?.['reason'] === 'completed')

  // 父链断言：编排事件 + join 摘要回父（toolResult 携 summary）
  const parent = chainEvents(svc, w.id, root, sess.sessionId)
  const spawns = systemPayloads(parent, 'subagent/spawn')
  const joins = systemPayloads(parent, 'subagent/join')
  assert.equal(spawns.length, 1, '父链恰一条 subagent/spawn')
  assert.equal(spans0(spawns), 'SA-E2E')
  assert.equal((spawns[0] as Record<string, unknown>)['parentSessionId'] ?? (spawns[0] as Record<string, unknown>)['parentTurnId'], 'T1', 'spawn 事件带 parentTurnId')
  assert.equal(joins.length, 1, '父链恰一条 subagent/join')
  assert.equal((joins[0] as Record<string, unknown>)['reason'], 'completed')
  const joinResult = parent.find(
    (e) => e['kind'] === 'toolResult' && (e['payload'] as Record<string, unknown>)['id'] === 'call-join' && 'result' in (e['payload'] as Record<string, unknown>),
  )
  assert.ok(joinResult, 'join toolResult 在父链')
  const jrResult = ((joinResult as Record<string, unknown>)['payload'] as Record<string, unknown>)['result'] as Record<string, unknown>
  assert.match(String(jrResult['summary']), /子结论：note 内容已调研完成/, 'join 摘要回父（模型可见）')
  assert.equal(jrResult['reason'], 'completed')

  // 子链断言：session-start 父载荷 + 授权决策落子链 + 工具结果 + usage 汇总
  const child = chainEvents(svc, w.id, root, 'SA-E2E')
  const start = systemPayloads(child, 'session-start')[0] as Record<string, unknown>
  assert.equal(start['parentSessionId'], sess.sessionId, '子链 session-start 带 parentSessionId（Q-A1 平铺形态）')
  assert.equal(start['parentTurnId'], 'T1')
  const authzEnds = child.filter((e) => e['kind'] === 'turnEnd' && String(e['turnId']).startsWith('authz:SA-E2E:'))
  assert.equal(authzEnds.length, 1, '子 fs_read 授权决策落子链（恰一条）')
  assert.equal((authzEnds[0] as Record<string, unknown>)['payload'] && ((authzEnds[0] as Record<string, unknown>)['payload'] as Record<string, unknown>)['decision'], 'APPROVED')
  const readResult = child.find((e) => e['kind'] === 'toolResult' && ((e['payload'] as Record<string, unknown>)['result'] as Record<string, unknown> | undefined)?.['content'])
  assert.ok(readResult, '子 fs_read 执行结果在子链')
  assert.match(
    String((((readResult as Record<string, unknown>)['payload'] as Record<string, unknown>)['result'] as Record<string, unknown>)['content']),
    /K2 测试正文/,
    '子 fs_read 执行结果在子链',
  )
  const usage = systemPayloads(child, 'subagent/usage')
  assert.equal(usage.length, 1, 'join 时子链恰一条 subagent/usage 汇总')
  assert.equal((usage[0] as Record<string, unknown>)['parentTurnId'], 'T1', 'usage 汇总带 parentTurnId 归因')
  assert.ok(typeof (usage[0] as Record<string, unknown>)['requests'] === 'number')

  // 白名单反证（T-K2-2 CI 门禁）：子面 toolDefs 仅 fs_read——编排/写类不进子面
  assert.deepEqual(captured.toolDefsByChild['SA-E2E'], ['fs_read'], '子面工具清单 = 白名单（构造性主强子弱）')
  // 授权弹窗在父：pending 推送携父 sessionId（requestId 内嵌子 id 路由）
  const childPending = pushes.find((m) => m.topic === 'push:authz-pending' && String((m.payload as Record<string, unknown>)['requestId']).startsWith('SA-E2E:'))
  assert.ok(childPending, '子链人审 pending 推送在案')
  assert.equal((childPending as { payload: Record<string, unknown> }).payload['sessionId'], sess.sessionId, '弹窗在父（pending 携父 sessionId）')
  // 父链无子授权审计（决策归子链——审计不串链）
  assert.equal(parent.filter((e) => e['kind'] === 'turnEnd' && String(e['turnId']).startsWith('authz:SA-E2E')).length, 0)
  svc.dispose()
})

function spans0(spawns: Array<Record<string, unknown>>): string {
  return String(spawns[0]?.['subagentId'])
}

// ── 2b：越权工具在子面被拒且落链 ──

test('K2: 越权工具在子面被拒且落链（unknown tool fs_write——子面白名单外）', async () => {
  const { root, ws } = makeWorkspace('denytool')
  const svc = createHostService({
    userDataDir: tmpDir('ud'),
    authzTimeoutMs: 120_000,
    modelFnOverride: scriptedParentModel([
      { tool: 'subagent_spawn', args: { task: '尝试越权写', id: 'SA-DENY' } },
      { tool: 'subagent_join', args: { id: 'SA-DENY' } },
      { text: '父收口' },
    ]),
    childModelFnOverride: scriptedChildModel({
      'SA-DENY': [{ tool: 'fs_write', args: { path: 'evil.txt', content: 'x' } }, { text: '写被拒' }],
    }),
  })
  const pushes: PushMessage[] = []
  autoAuthz(svc, pushes)
  const w = await ws(svc)
  const sess = (await svc.dispatch('session:create', { workspaceId: w.id })) as { sessionId: string }
  await svc.dispatch('turn:send', { workspaceId: w.id, sessionId: sess.sessionId, text: '派生' })
  await waitTurnEnd(svc, w.id, sess.sessionId, () => true)
  const child = chainEvents(svc, w.id, root, 'SA-DENY')
  const deny = child.find((e) => e['kind'] === 'toolResult' && String((e['payload'] as Record<string, unknown>)['error'] ?? '').includes('unknown tool'))
  assert.ok(deny, '子链落 unknown tool toolResult（越权被拒且留痕）')
  assert.match(String(((deny as Record<string, unknown>)['payload'] as Record<string, unknown>)['error']), /fs_write/)
  assert.ok(!existsSync(join(root, 'evil.txt')), '越权写未落地')
  svc.dispose()
})

// ── 4：护栏 fail-visible ──

test('K2: 并发护栏——同批第 4 个 spawn 结构化错误 CAR-E-SUBAGENT-CONC（禁静默排队）', async () => {
  const { root, ws } = makeWorkspace('conc')
  // 父模型单步 toolUse 批 4 个 spawn：前 3 派生挂起子、第 4 撞并发上限
  const batchParent = (_h: SessionHandle) => {
    let n = 0
    return async () => {
      if (n++ > 0) return { stopReason: 'stop' as const, text: '父收口' }
      return {
        stopReason: 'toolUse' as const,
        toolCalls: [1, 2, 3, 4].map((m) => ({ id: 'call-' + m, tool: 'subagent_spawn', args: { task: '挂起' + m, id: 'SA-C' + m } })),
      }
    }
  }
  const svc = createHostService({
    userDataDir: tmpDir('ud'),
    authzTimeoutMs: 120_000,
    modelFnOverride: batchParent,
    childModelFnOverride: scriptedChildModel({
      'SA-C1': [{ hangMs: 60_000, text: '' }],
      'SA-C2': [{ hangMs: 60_000, text: '' }],
      'SA-C3': [{ hangMs: 60_000, text: '' }],
    }),
  })
  const pushes: PushMessage[] = []
  autoAuthz(svc, pushes)
  const w = await ws(svc)
  const sess = (await svc.dispatch('session:create', { workspaceId: w.id })) as { sessionId: string }
  await svc.dispatch('turn:send', { workspaceId: w.id, sessionId: sess.sessionId, text: '并发派生' })
  await waitTurnEnd(svc, w.id, sess.sessionId, () => true, 20_000)
  const parent = chainEvents(svc, w.id, root, sess.sessionId)
  const conc = parent.find((e) => e['kind'] === 'toolResult' && String((e['payload'] as Record<string, unknown>)['error'] ?? '').includes('CAR-E-SUBAGENT-CONC'))
  assert.ok(conc, '第 4 个 spawn 以 CAR-E-SUBAGENT-CONC 结构化错误交回模型')
  const spawnCalls = parent.filter((e) => e['kind'] === 'toolCall' && (e['payload'] as Record<string, unknown>)['tool'] === 'subagent_spawn')
  assert.equal(spawnCalls.length, 4, '4 个 spawn 调用全部父链成对落痕（3 成功 + 1 超限）')
  for (const sid of ['SA-C1', 'SA-C2', 'SA-C3']) {
    assert.ok(existsSync(join(root, '.car', 'sessions', sid + '.jsonl')), `子链 ${sid} 已落盘`)
  }
  svc.dispose()
})

// ── 4b：累计护栏（链上 spawn 事件计数——跨重启收敛） ──

test('K2: 累计护栏——第 11 个 spawn 结构化错误 CAR-E-SUBAGENT-CUM（链上真值计数）', async () => {
  const { root, ws } = makeWorkspace('cum')
  const steps: Array<{ tool: string; args: Record<string, unknown> }> = []
  for (let n = 1; n <= 12; n++) steps.push({ tool: 'subagent_spawn', args: { task: '快完成' + n, id: 'SA-Q' + n } })
  const svc = createHostService({
    userDataDir: tmpDir('ud'),
    authzTimeoutMs: 120_000,
    modelFnOverride: scriptedParentModel(steps),
    childModelFnOverride: scriptedChildModel({}),
  })
  const pushes: PushMessage[] = []
  autoAuthz(svc, pushes)
  const w = await ws(svc)
  const sess = (await svc.dispatch('session:create', { workspaceId: w.id })) as { sessionId: string }
  await svc.dispatch('turn:send', { workspaceId: w.id, sessionId: sess.sessionId, text: '连续派生' })
  await waitTurnEnd(svc, w.id, sess.sessionId, () => true, 30_000)
  const parent = chainEvents(svc, w.id, root, sess.sessionId)
  const cum = parent.find((e) => e['kind'] === 'toolResult' && String((e['payload'] as Record<string, unknown>)['error'] ?? '').includes('CAR-E-SUBAGENT-CUM'))
  assert.ok(cum, '第 11 个 spawn 以 CAR-E-SUBAGENT-CUM 结构化错误交回模型')
  assert.equal(systemPayloads(parent, 'subagent/spawn').length, 10, '链上恰 10 个 spawn 事件（护栏上限内）')
  svc.dispose()
})

// ── 5：kill + 父 abort 级联 ──

test('K2: kill 子 Agent——子链 aborted 收口（运行期取消）+ 父链 kill 编排事件；join 取回 aborted 结论', async () => {
  const { root, ws } = makeWorkspace('kill')
  const svc = createHostService({
    userDataDir: tmpDir('ud'),
    authzTimeoutMs: 120_000,
    modelFnOverride: scriptedParentModel([
      { tool: 'subagent_spawn', args: { task: '长任务', id: 'SA-KILL' } },
      { tool: 'subagent_kill', args: { id: 'SA-KILL' } },
      { tool: 'subagent_join', args: { id: 'SA-KILL' } },
      { text: '父收口' },
    ]),
    childModelFnOverride: scriptedChildModel({ 'SA-KILL': [{ hangMs: 60_000, text: '' }] }),
  })
  const pushes: PushMessage[] = []
  autoAuthz(svc, pushes)
  const w = await ws(svc)
  const sess = (await svc.dispatch('session:create', { workspaceId: w.id })) as { sessionId: string }
  await svc.dispatch('turn:send', { workspaceId: w.id, sessionId: sess.sessionId, text: '派生后终止' })
  await waitTurnEnd(svc, w.id, sess.sessionId, () => true, 20_000)
  const parent = chainEvents(svc, w.id, root, sess.sessionId)
  assert.equal(systemPayloads(parent, 'subagent/kill').length, 1, '父链 subagent/kill 编排事件')
  const child = chainEvents(svc, w.id, root, 'SA-KILL')
  const end = child.find((e) => e['kind'] === 'turnEnd' && e['turnId'] === 'T1') as Record<string, unknown>
  assert.equal((end['meta'] as Record<string, unknown>)['reason'], 'aborted', '子链以 aborted 收口（kill = 运行期取消，与 interrupted 不混用）')
  const joinResult = parent.find((e) => e['kind'] === 'toolResult' && ((e['payload'] as Record<string, unknown>)['result'] as Record<string, unknown> | undefined)?.['reason'] === 'aborted')
  assert.ok(joinResult, 'join 取回 aborted 收口结论（模型可见）')
  svc.dispose()
})

test('K2: 杀父级联——turn:abort 后活跃子链全部 aborted 收口', async () => {
  const { root, ws } = makeWorkspace('cascade')
  const svc = createHostService({
    userDataDir: tmpDir('ud'),
    authzTimeoutMs: 120_000,
    modelFnOverride: scriptedParentModel([{ tool: 'subagent_spawn', args: { task: '长任务', id: 'SA-CAS' } }, { hangMs: 60_000, text: '' }]),
    childModelFnOverride: scriptedChildModel({ 'SA-CAS': [{ hangMs: 60_000, text: '' }] }),
  })
  const pushes: PushMessage[] = []
  autoAuthz(svc, pushes)
  const w = await ws(svc)
  const sess = (await svc.dispatch('session:create', { workspaceId: w.id })) as { sessionId: string }
  void svc.dispatch('turn:send', { workspaceId: w.id, sessionId: sess.sessionId, text: '派生后杀父' })
  // 等子链 session-start 落盘后杀父
  for (let i = 0; i < 200; i++) {
    if (existsSync(join(root, '.car', 'sessions', 'SA-CAS.jsonl'))) break
    await new Promise((r) => setTimeout(r, 25))
  }
  await new Promise((r) => setTimeout(r, 100))
  await svc.dispatch('turn:abort', { workspaceId: w.id, sessionId: sess.sessionId })
  for (let i = 0; i < 200; i++) {
    const child = chainEventsOrNull(root, 'SA-CAS')
    if (child?.some((e) => e['kind'] === 'turnEnd' && e['turnId'] === 'T1')) break
    await new Promise((r) => setTimeout(r, 25))
  }
  const child = chainEvents(svc, w.id, root, 'SA-CAS')
  const end = child.find((e) => e['kind'] === 'turnEnd' && e['turnId'] === 'T1') as Record<string, unknown>
  assert.ok(end, '子链已收口')
  assert.equal((end['meta'] as Record<string, unknown>)['reason'], 'aborted', '杀父级联——子链 aborted 收口')
  svc.dispose()
})

function chainEventsOrNull(root: string, sid: string): Array<Record<string, unknown>> | null {
  const file = join(root, '.car', 'sessions', sid + '.jsonl')
  if (!existsSync(file)) return null
  const loaded = loadSessionLog(file)
  return loaded.log.events as unknown as Array<Record<string, unknown>>
}

// ── 6：恢复幂等（K1 POC 四形态转正式：崩溃态 → open 补记 → 重复 open 全零 → 断链子链只读） ──

test('K2: 父 open 恢复——子链补记 interrupted ×1、重复 open 幂等、断链子链只读跳过', async () => {
  const { root, ws } = makeWorkspace('recover')
  // 崩溃态构造：父 T1 执行中 spawn 挂起子链（子 T1' 执行中）——直接弃用 svc 模拟进程消失
  const svc1 = createHostService({
    userDataDir: tmpDir('ud'),
    authzTimeoutMs: 120_000,
    modelFnOverride: scriptedParentModel([{ tool: 'subagent_spawn', args: { task: '长任务', id: 'SA-REC' } }, { hangMs: 60_000, text: '' }]),
    childModelFnOverride: scriptedChildModel({ 'SA-REC': [{ hangMs: 60_000, text: '' }] }),
  })
  const pushes: PushMessage[] = []
  autoAuthz(svc1, pushes)
  const w = await ws(svc1)
  const sess = (await svc1.dispatch('session:create', { workspaceId: w.id })) as { sessionId: string }
  void svc1.dispatch('turn:send', { workspaceId: w.id, sessionId: sess.sessionId, text: '派生后进程消失' })
  for (let i = 0; i < 200; i++) {
    const c = chainEventsOrNull(root, 'SA-REC')
    if (c?.some((e) => e['kind'] === 'user')) break
    await new Promise((r) => setTimeout(r, 25))
  }
  await new Promise((r) => setTimeout(r, 100))
  svc1.dispose() // 弃句柄（文件已 fsync——崩溃形态：双链 turn 未闭合）

  // 断链子链构造：另一个子链文件人为断链（改一行 hash）
  const svcB = createHostService({
    userDataDir: tmpDir('udb'),
    authzTimeoutMs: 120_000,
    modelFnOverride: scriptedParentModel([{ tool: 'subagent_spawn', args: { task: '断链子', id: 'SA-BRK' } }, { text: '父收口' }]),
    childModelFnOverride: scriptedChildModel({ 'SA-BRK': [{ text: '完成' }] }),
  })
  // 断链子链须属同一父——改用会话 B 的父：直接在同一工作区建第二会话
  const pushesB: PushMessage[] = []
  autoAuthz(svcB, pushesB)
  const wB = await ws(svcB)
  assert.equal(wB.id, w.id, '同路径注册应复用工作区 id')
  const sessB = (await svcB.dispatch('session:create', { workspaceId: wB.id })) as { sessionId: string }
  await svcB.dispatch('turn:send', { workspaceId: wB.id, sessionId: sessB.sessionId, text: '派生断链子' })
  await waitTurnEnd(svcB, wB.id, sessB.sessionId, () => true)
  svcB.dispose()
  // 人为断链 SA-BRK（审计红线：测试资产——临时破坏 + 随后只读验证）
  const brkFile = join(root, '.car', 'sessions', 'SA-BRK.jsonl')
  const lines = readFileSync(brkFile, 'utf8').split('\n').filter((l) => l.trim())
  const tampered = JSON.parse(lines[1]!) as Record<string, unknown>
  tampered['hash'] = 'deadbeef'
  lines[1] = JSON.stringify(tampered)
  writeFileSync(brkFile, lines.join('\n') + '\n', 'utf8')

  // 新进程 open 父 A：父链 interrupted 补记 + 子链 SA-REC 补记 interrupted；SA-BRK 非本父子链不影响
  const svc2 = createHostService({
    userDataDir: tmpDir('ud2'),
    authzTimeoutMs: 120_000,
    modelFnOverride: scriptedParentModel([]),
    childModelFnOverride: scriptedChildModel({}),
  })
  // 新进程无内存工作区表——同路径重注册复用 id（路径派生）
  const w2 = await ws(svc2)
  assert.equal(w2.id, w.id, '同路径注册复用工作区 id')
  const open1 = (await svc2.dispatch('session:open', { workspaceId: w.id, sessionId: sess.sessionId })) as {
    recovery: { interruptedTurns: number; childSessions?: { recovered: number; broken: number } } | null
  }
  assert.ok(open1.recovery, '父 open 产生恢复报告')
  assert.ok((open1.recovery!.interruptedTurns ?? 0) >= 1, '父链 T1 补记 interrupted')
  assert.equal(open1.recovery!.childSessions?.recovered, 1, '子链 SA-REC 补记 interrupted ×1')
  const child = chainEvents(svc2, w.id, root, 'SA-REC')
  const int = child.filter((e) => e['kind'] === 'turnEnd' && (e['meta'] as Record<string, unknown>)['reason'] === 'interrupted')
  assert.equal(int.length, 1, '子链恰一条 interrupted 补记')

  // 幂等：重复 open 走常驻句柄快径（recovery=null——不重跑恢复面；子链已闭合，补记不翻倍）
  const open2 = (await svc2.dispatch('session:open', { workspaceId: w.id, sessionId: sess.sessionId })) as {
    recovery: { interruptedTurns?: number; childSessions?: { recovered: number; broken: number } } | null
  }
  assert.equal(open2.recovery, null, '重复 open 走常驻句柄——零补记（幂等）')
  const child2 = chainEvents(svc2, w.id, root, 'SA-REC')
  assert.equal(child2.filter((e) => e['kind'] === 'turnEnd').length, 1, '子链无翻倍补记')

  // 断链子链：父 B open 仍成功，broken=1 只读跳过
  const openB = (await svc2.dispatch('session:open', { workspaceId: w.id, sessionId: sessB.sessionId })) as {
    recovery: { childSessions?: { recovered: number; broken: number } } | null
  }
  assert.equal(openB.recovery?.childSessions?.broken, 1, '断链子链只读跳过（broken 计数明示）')
  const repB = (await svc2.dispatch('audit:report', { workspaceId: w.id, sessionId: sessB.sessionId })) as { chain: { intact: boolean; brokenAt: number | null } }
  assert.equal(repB.chain.brokenAt, null, '父 B 链不受断链子链影响')
  svc2.dispose()
})

// ── 7：删除级联 ──

test('K2: 删除级联——删父后子链索引随父标记（文件保留、列表过滤）', async () => {
  const { root, ws } = makeWorkspace('delcasc')
  const svc = createHostService({
    userDataDir: tmpDir('ud'),
    authzTimeoutMs: 120_000,
    modelFnOverride: scriptedParentModel([{ tool: 'subagent_spawn', args: { task: '任务', id: 'SA-DEL' } }, { text: '父收口' }]),
    childModelFnOverride: scriptedChildModel({ 'SA-DEL': [{ text: '完成' }] }),
  })
  const pushes: PushMessage[] = []
  autoAuthz(svc, pushes)
  const w = await ws(svc)
  const sess = (await svc.dispatch('session:create', { workspaceId: w.id })) as { sessionId: string }
  await svc.dispatch('turn:send', { workspaceId: w.id, sessionId: sess.sessionId, text: '派生' })
  await waitTurnEnd(svc, w.id, sess.sessionId, () => true)
  const idxBefore = JSON.parse(readFileSync(join(root, '.car', 'session-index.json'), 'utf8')) as { sessions: Record<string, Record<string, unknown>> }
  assert.equal(idxBefore.sessions['SA-DEL']?.['title'], '子 Agent · 任务', '子链 spawn 时已索引登记')
  await svc.dispatch('session:delete', { workspaceId: w.id, sessionId: sess.sessionId })
  const idxAfter = JSON.parse(readFileSync(join(root, '.car', 'session-index.json'), 'utf8')) as { sessions: Record<string, Record<string, unknown>> }
  assert.equal(idxAfter.sessions['SA-DEL']?.['deleted'], true, '子链索引随父标记 deleted')
  assert.equal(idxAfter.sessions['SA-DEL']?.['deletedWithParent'], sess.sessionId, '级联标记携带父 id（审计定位）')
  assert.ok(existsSync(join(root, '.car', 'sessions', 'SA-DEL.jsonl')), '子链 JSONL 保留（日志不可变红线）')
  const list = (await svc.dispatch('session:list', { workspaceId: w.id })) as Array<{ sessionId: string }>
  assert.ok(!list.some((s) => s.sessionId === 'SA-DEL'), '列表过滤随父删除的子链')
  svc.dispose()
})

// ── 7b：R-K2-2 spawn 磁盘存在性守卫（跨会话复用子 id 禁覆盖追加——哈希链红线） ──

test('K2: spawn 子链文件已存在 = CAR-E-SUBAGENT-DUP fail-visible（跨会话 id 冲突禁覆盖追加）', async () => {
  const { root, ws } = makeWorkspace('dupdisk')
  const svc = createHostService({
    userDataDir: tmpDir('ud'),
    authzTimeoutMs: 120_000,
    modelFnOverride: scriptedParentModel([{ tool: 'subagent_spawn', args: { task: '任务', id: 'SA-DUPX' } }, { text: '父收口' }]),
    childModelFnOverride: scriptedChildModel({ 'SA-DUPX': [{ text: '完成' }] }),
  })
  const pushes: PushMessage[] = []
  autoAuthz(svc, pushes)
  const w = await ws(svc)
  const sess1 = (await svc.dispatch('session:create', { workspaceId: w.id })) as { sessionId: string }
  await svc.dispatch('turn:send', { workspaceId: w.id, sessionId: sess1.sessionId, text: '派生第一会话' })
  await waitTurnEnd(svc, w.id, sess1.sessionId, () => true)
  const before = readFileSync(join(root, '.car', 'sessions', 'SA-DUPX.jsonl'), 'utf8')

  // 第二会话（新 SubagentManager——内存 map 看不到第一会话的子链）复用同 id → 磁盘守卫拒绝
  const sess2 = (await svc.dispatch('session:create', { workspaceId: w.id })) as { sessionId: string }
  await svc.dispatch('turn:send', { workspaceId: w.id, sessionId: sess2.sessionId, text: '派生第二会话（同 id）' })
  await waitTurnEnd(svc, w.id, sess2.sessionId, () => true)
  const parent2 = chainEvents(svc, w.id, root, sess2.sessionId)
  const dup = parent2.find(
    (e) => e['kind'] === 'toolResult' && String((e['payload'] as Record<string, unknown>)['error'] ?? '').includes('CAR-E-SUBAGENT-DUP') && String((e['payload'] as Record<string, unknown>)['error'] ?? '').includes('子链文件已存在'),
  )
  assert.ok(dup, '第二会话 spawn 同 id = 结构化错误交回模型（禁覆盖追加）')
  const after = readFileSync(join(root, '.car', 'sessions', 'SA-DUPX.jsonl'), 'utf8')
  assert.equal(after, before, '既有子链文件字节级未动（append-only 红线）')
  assert.equal(loadSessionLog(join(root, '.car', 'sessions', 'SA-DUPX.jsonl')).brokenAt, null, '子链哈希链完整')
  svc.dispose()
})

// ── 8：seam 门禁（K3 / D-K2-2：1.16.0 = 类型面加法，运行时符号零加法） ──

test('K2/K3: seam 门禁——1.16.0 运行时符号面无 subagent 加法（版本 + 计数 + 方向断言）', () => {
  const probe = probeSeam()
  assert.equal(probe.seamVersion, '1.18.2', 'K8 消费基线 = 1.18.2（R-K7-2 usageMissing 尾键——运行时符号面零加法维持）')
  assert.equal(probe.symbolCount, 43, '运行时符号计数与基线一致（1.16.0/1.17.0/1.18.x 加法均 = 类型/行为面，零运行时符号）')
  assert.ok(
    !probe.symbols.some((s) => /subagent/i.test(s)),
    'seam 无 subagent* 运行时符号（编排 = 宿主侧组合；若此处红 = 内核加了法但未走发布纪律）',
  )
})

// ── 9：K3 llm.subagent 三键（model 覆盖 + 护栏上限 config 化） ──

test('K3: llm.subagent 三键——model 覆盖到子链/模型回调 + maxConcurrent=1 并发拒 + maxCumulative=2 累计拒', async () => {
  const root = tmpDir('k3cfg')
  writeFileSync(
    join(root, 'car.config.ts'),
    "export default { llm: { baseUrl: 'http://127.0.0.1:9', model: 'parent-m', subagent: { model: 'child-ovr', maxConcurrent: 1, maxCumulative: 2 } } }\n",
    'utf8',
  )
  const captured: { models: Record<string, string> } = { models: {} }
  // 挂起子 500ms 自然收口：turn1 内两次相邻 spawn 稳定撞并发；turn2 以 join 阻塞汇合（确定性
  // settle 同步——kill 后紧邻 spawn 会因子链异步 settle 未清 active 而再撞 CONC，禁用该形态）
  const baseChild = scriptedChildModel({ 'SA-K3H': [{ hangMs: 500, text: '子完成' }] })
  const svc = createHostService({
    userDataDir: tmpDir('ud'),
    authzTimeoutMs: 120_000,
    modelFnOverride: scriptedParentModel([
      { tool: 'subagent_spawn', id: 'c1', args: { task: '挂起子任务', id: 'SA-K3H' } },
      { tool: 'subagent_spawn', id: 'c2', args: { task: '撞并发上限', id: 'SA-K3X' } },
      { text: 'turn1 收口' },
      { tool: 'subagent_join', id: 'c3', args: { id: 'SA-K3H' } },
      { tool: 'subagent_spawn', id: 'c4', args: { task: '第二个有效派生', id: 'SA-K3Y' } },
      { tool: 'subagent_spawn', id: 'c5', args: { task: '撞累计上限', id: 'SA-K3Z' } },
      { text: 'turn2 收口' },
    ]),
    childModelFnOverride: (o) => {
      captured.models[o.log.sessionId] = o.currentModel()
      return baseChild(o)
    },
  })
  const pushes: PushMessage[] = []
  autoAuthz(svc, pushes)
  const w = (await svc.dispatch('workspace:register', { path: root })) as WorkspaceInfo
  const sess = (await svc.dispatch('session:create', { workspaceId: w.id })) as { sessionId: string }
  await svc.dispatch('turn:send', { workspaceId: w.id, sessionId: sess.sessionId, text: 'K3 三键演练 turn1（并发护栏）' })
  await waitTurnEnd(svc, w.id, sess.sessionId, (e) => (e.meta as Record<string, unknown>)?.['reason'] === 'completed')
  await svc.dispatch('turn:send', { workspaceId: w.id, sessionId: sess.sessionId, text: 'K3 三键演练 turn2（join 汇合 + 累计护栏）' })
  // waitTurnEnd 谓词不区分轮次（会即刻匹配 turn1 的旧 turnEnd）——双 turn 流改计数等待
  const t0 = Date.now()
  for (;;) {
    const rep = (await svc.dispatch('audit:report', { workspaceId: w.id, sessionId: sess.sessionId })) as { events: Array<{ kind: string; turnId: string; meta?: Record<string, unknown> }> }
    const done = rep.events.filter((e) => e.kind === 'turnEnd' && !e.turnId.startsWith('authz:') && (e.meta as Record<string, unknown>)?.['reason'] === 'completed').length
    if (done >= 2) break
    if (Date.now() - t0 > 20_000) throw new Error('等待 turn2 收口超时')
    await new Promise((r) => setTimeout(r, 50))
  }

  const parent = chainEvents(svc, w.id, root, sess.sessionId)
  // 覆盖锚点 + guards 配置真值落链
  const spawns = systemPayloads(parent, 'subagent/spawn')
  assert.equal(spawns.length, 2, '恰两条成功 spawn（挂起子 + join 汇合后第二个有效派生）')
  assert.equal(spawns[0]!['model'], 'child-ovr', 'spawn 事件 model = config 覆盖锚点（非父现值 parent-m）')
  const guards = spawns[0]!['guards'] as Record<string, number>
  assert.equal(guards['maxConcurrent'], 1, 'guards.maxConcurrent = 配置值 1（链上真值）')
  assert.equal(guards['maxCumulative'], 2, 'guards.maxCumulative = 配置值 2（链上真值）')
  // 护栏错误：数值随配置（非 Q-A3 常量 3/10）
  const conc = parent.find((e) => e['kind'] === 'toolResult' && String((e['payload'] as Record<string, unknown>)['error'] ?? '').includes('CAR-E-SUBAGENT-CONC'))
  assert.ok(conc, '并发撞限以 CAR-E-SUBAGENT-CONC 结构化错误交回模型')
  assert.match(String((conc!['payload'] as Record<string, unknown>)['error']), /1 ≥ 1/, '错误数值随配置 maxConcurrent=1')
  const cum = parent.find((e) => e['kind'] === 'toolResult' && String((e['payload'] as Record<string, unknown>)['error'] ?? '').includes('CAR-E-SUBAGENT-CUM'))
  assert.ok(cum, '累计撞限以 CAR-E-SUBAGENT-CUM 结构化错误交回模型')
  assert.match(String((cum!['payload'] as Record<string, unknown>)['error']), /2 ≥ 2/, '错误数值随配置 maxCumulative=2')
  // 子链锚点 + 模型回调锚点 = 覆盖值
  const childStart = systemPayloads(chainEvents(svc, w.id, root, 'SA-K3Y'), 'session-start')
  assert.equal(childStart[0]!['model'], 'child-ovr', '子链 session-start model = config 覆盖锚点')
  assert.equal(captured.models['SA-K3H'], 'child-ovr', '子模型回调 currentModel 锚点 = config 覆盖')
  assert.ok(!existsSync(join(root, '.car', 'sessions', 'SA-K3X.jsonl')), '并发撞限的 SA-K3X 未建子链（护栏先于创建）')
  svc.dispose()
})

// ── 10：K3 压过口径（池在场 = subagent.model 被压过） ──

test('K3: modelPool 在场压过 llm.subagent.model——子锚点回落父现值（与 llm.model 同口径）', async () => {
  const root = tmpDir('k3pool')
  writeFileSync(
    join(root, 'car.config.ts'),
    "export default { llm: { model: 'parent-anchor', subagent: { model: 'ignored-ovr' } }, modelPool: { endpoints: [{ baseUrl: 'http://127.0.0.1:9', model: 'pool-first' }] } }\n",
    'utf8',
  )
  const svc = createHostService({
    userDataDir: tmpDir('ud'),
    authzTimeoutMs: 120_000,
    modelFnOverride: scriptedParentModel([
      { tool: 'subagent_spawn', id: 'c1', args: { task: '池形态派生', id: 'SA-PL' } },
      { text: '父收口' },
    ]),
    childModelFnOverride: scriptedChildModel({ 'SA-PL': [{ text: '子完成' }] }),
  })
  const pushes: PushMessage[] = []
  autoAuthz(svc, pushes)
  const w = (await svc.dispatch('workspace:register', { path: root })) as WorkspaceInfo
  const sess = (await svc.dispatch('session:create', { workspaceId: w.id })) as { sessionId: string }
  await svc.dispatch('turn:send', { workspaceId: w.id, sessionId: sess.sessionId, text: '池压过演练' })
  await waitTurnEnd(svc, w.id, sess.sessionId, () => true, 20_000)
  const childStart = systemPayloads(chainEvents(svc, w.id, root, 'SA-PL'), 'session-start')
  assert.ok(childStart.length === 1, 'SA-PL 子链已建')
  assert.equal(childStart[0]!['model'], 'parent-anchor', '池在场 = subagent.model 被压过，子锚点 = 父现值（≠ ignored-ovr）')
  svc.dispose()
})

// ── 11：K3 压过口径（端点覆盖 R-D6 在场 = subagent.model 被压过） ──

test('K3: 端点覆盖压过 llm.subagent.model——子锚点 = 端点 model（R-D6 优先级）', async () => {
  const root = tmpDir('k3ep')
  writeFileSync(
    join(root, 'car.config.ts'),
    "export default { llm: { baseUrl: 'http://127.0.0.1:9', model: 'cfg-m', subagent: { model: 'ignored-ovr' } } }\n",
    'utf8',
  )
  const svc = createHostService({
    userDataDir: tmpDir('ud'),
    authzTimeoutMs: 120_000,
    modelFnOverride: scriptedParentModel([
      { tool: 'subagent_spawn', id: 'c1', args: { task: '端点覆盖形态派生', id: 'SA-EP' } },
      { text: '父收口' },
    ]),
    childModelFnOverride: scriptedChildModel({ 'SA-EP': [{ text: '子完成' }] }),
  })
  const pushes: PushMessage[] = []
  autoAuthz(svc, pushes)
  const w = (await svc.dispatch('workspace:register', { path: root })) as WorkspaceInfo
  await svc.dispatch('credentials:key-push', { baseUrl: 'http://127.0.0.1:9', key: 'k', models: [{ id: 'ep-model', contextWindow: 32000 }] })
  try {
    const sess = (await svc.dispatch('session:create', { workspaceId: w.id })) as { sessionId: string }
    await svc.dispatch('turn:send', { workspaceId: w.id, sessionId: sess.sessionId, text: '端点压过演练' })
    await waitTurnEnd(svc, w.id, sess.sessionId, () => true, 20_000)
    const childStart = systemPayloads(chainEvents(svc, w.id, root, 'SA-EP'), 'session-start')
    assert.ok(childStart.length === 1, 'SA-EP 子链已建')
    assert.equal(childStart[0]!['model'], 'ep-model', '端点覆盖在场 = subagent.model 被压过，子锚点 = 端点 model（≠ ignored-ovr）')
  } finally {
    await svc.dispatch('credentials:key-push', { clear: true }).catch(() => { /* 清理端点态 */ })
    svc.dispose()
  }
})
