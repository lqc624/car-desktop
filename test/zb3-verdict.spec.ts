/**
 * zb3-verdict · 0.16.0 B-3 visual 判定档与 verdict 契约（D-VB3-1 / §4.8 判据化协议）
 *
 * 判据：
 *  - parseVisualVerdict 契约：宽松取 JSON 子串（prose/代码围栏兼容）+ 严格形状校验
 *    （pages 非空数组 / shotId:string / verdict∈pass,fail / issues 可选数组）——任一违规
 *    整体判 null（不做部分采纳）；
 *  - visual 档 E2E：spawn type='visual' → 子面 toolface 恰 ['shot_read']（委派隔离反证——
 *    browser_* 不进子面）+ 叙事 subagentType 落链；子面 shot_read ⓪⁼ 直判零 pending
 *    （受管证据读面）；join → SubagentJoinResult.verdict + 父链 browser/verdict 叙事
 *    （passCount/failCount——判定 fail ≠ 工具执行 fail 两态分立）；
 *  - unparsed：子链末条非契约 JSON → verdictUnparsed fail-visible（toolResult 标注 +
 *    父链叙事 verdictUnparsed:true，禁静默吞）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadSessionLog } from '@lqc123qwe/car-runtime'
import { createHostService, type HostService, type PushMessage } from '../src/host-core/service.ts'
import { parseVisualVerdict } from '../src/host-core/visual-verdict.ts'
import type { WorkspaceInfo } from '../src/shared/ipc-contract.ts'
import type { SessionHandle } from '../src/host-core/session-handle.ts'
import type { ChildModelFnOpts } from '../src/host-core/subagent.ts'
import type { HostModelStep } from '../src/host-core/types.ts'

function tmpDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `car-zb3v-${label}-`))
}

function makeWorkspace(label: string): { root: string; ws: (svc: HostService) => Promise<WorkspaceInfo> } {
  const root = tmpDir(label)
  writeFileSync(join(root, 'car.config.ts'), "export default { llm: { baseUrl: 'http://127.0.0.1:9', model: 'test-model' } }\n", 'utf8')
  return { root, ws: async (svc) => (await svc.dispatch('workspace:register', { path: root })) as WorkspaceInfo }
}

/** 父模型脚本（k2 同款——按序消费 steps；stop 文本复刻 assistant 落链） */
function scriptedParentModel(steps: Array<{ tool?: string; args?: Record<string, unknown>; text?: string }>) {
  return (h: SessionHandle) => {
    let i = 0
    return async (): Promise<HostModelStep> => {
      const s = steps[i++] ?? { text: '（脚本尽）' }
      if (s.tool) return { stopReason: 'toolUse' as const, toolCalls: [{ id: 'call-' + i, tool: s.tool, args: s.args ?? {} }] }
      const text = s.text ?? ''
      if (text.length > 0) h.log.append('model', 'assistant', h.currentTurnId(), text)
      return { stopReason: 'stop' as const, text }
    }
  }
}

/** 子模型脚本（k2 同款——按子 sessionId 分剧本；toolDefs 捕获 = 委派隔离反证面） */
function scriptedChildModel(
  scripts: Record<string, Array<{ tool?: string; args?: Record<string, unknown>; text?: string }>>,
  captured?: { toolDefsByChild: Record<string, string[]> },
) {
  return (o: ChildModelFnOpts) => {
    const sid = o.log.sessionId
    if (captured) captured.toolDefsByChild[sid] = o.toolDefs.map((t) => t.name)
    const steps = scripts[sid] ?? [{ text: '子结论：默认完成' }]
    let i = 0
    return async (): Promise<HostModelStep> => {
      const s = steps[i++] ?? { text: '子结论：完成' }
      if (s.tool) return { stopReason: 'toolUse' as const, toolCalls: [{ id: 'cc-' + i, tool: s.tool, args: s.args ?? {} }] }
      if (s.text && s.text.length > 0) o.log.append('model', 'assistant', 'T1', s.text)
      return { stopReason: 'stop' as const, text: s.text ?? '' }
    }
  }
}

async function waitTurnEnd(svc: HostService, wid: string, sid: string, timeoutMs = 15_000): Promise<void> {
  const t0 = Date.now()
  for (;;) {
    const rep = (await svc.dispatch('audit:report', { workspaceId: wid, sessionId: sid })) as { events: Array<{ kind: string; turnId: string }> }
    if (rep.events.some((e) => e.kind === 'turnEnd' && !e.turnId.startsWith('authz:'))) return
    if (Date.now() - t0 > timeoutMs) throw new Error('等待 turn 收口超时')
    await new Promise((r) => setTimeout(r, 50))
  }
}

/** 授权自动应答器（k2 同款——父面 spawn/join 过人审门；回包推迟一个宏任务避注册竞态） */
function autoAuthz(svc: HostService, pushes: PushMessage[]): void {
  svc.onPush((m) => {
    pushes.push(m)
    if (m.topic === 'push:authz-pending') {
      const p = m.payload as { requestId: string }
      setTimeout(() => {
        void svc.dispatch('authz:respond', { requestId: p.requestId, decision: 'session' }).catch(() => { /* 已决/超时 = 测试环境噪声 */ })
      }, 0)
    }
  })
}

function chainEvents(root: string, sid: string): Array<Record<string, unknown>> {
  const loaded = loadSessionLog(join(root, '.car', 'sessions', sid + '.jsonl'))
  assert.equal(loaded.brokenAt, null, `子链 ${sid} 哈希链必须完整`)
  return loaded.log.events as unknown as Array<Record<string, unknown>>
}

function systemPayloads(events: Array<Record<string, unknown>>, type: string): Array<Record<string, unknown>> {
  return events.filter((e) => e['kind'] === 'system' && (e['payload'] as Record<string, unknown> | null)?.['type'] === type).map((e) => e['payload'] as Record<string, unknown>)
}

// ==================== verdict 契约 ====================

test('ZB3V-1 parseVisualVerdict 契约：prose 包裹兼容 / 代码围栏兼容 / 坏形态整体判 null', () => {
  const verdict = { pages: [{ shotId: 'shot-a1', verdict: 'fail', issues: [{ severity: 'high', note: '按钮缺失' }] }, { shotId: 'shot-a2', verdict: 'pass' }], summary: '1 fail 1 pass' }
  const clean = JSON.stringify(verdict)
  assert.deepEqual(parseVisualVerdict(clean)?.pages.length, 2)
  // prose 包裹 + 代码围栏
  const wrapped = `判定完成。\n\n\`\`\`json\n${clean}\n\`\`\`\n以上。`
  const w = parseVisualVerdict(wrapped)
  assert.equal(w?.pages[0]!.verdict, 'fail')
  assert.equal(w?.pages[1]!.verdict, 'pass')
  // 坏形态：pages 空 / 非法 verdict / 缺 shotId / issues 非数组 / 非 JSON / 纯文本
  assert.equal(parseVisualVerdict(JSON.stringify({ pages: [] })), null)
  assert.equal(parseVisualVerdict(JSON.stringify({ pages: [{ shotId: 's', verdict: 'PASS' }] })), null)
  assert.equal(parseVisualVerdict(JSON.stringify({ pages: [{ verdict: 'pass' }] })), null)
  assert.equal(parseVisualVerdict(JSON.stringify({ pages: [{ shotId: 's', verdict: 'pass', issues: 'bad' }] })), null)
  assert.equal(parseVisualVerdict('没有 JSON 的普通文本'), null)
  assert.equal(parseVisualVerdict(undefined), null)
  // issues 缺省可省
  assert.deepEqual(parseVisualVerdict(JSON.stringify({ pages: [{ shotId: 's', verdict: 'pass' }] }))?.pages[0]!.shotId, 's')
})

// ==================== visual 档 E2E ====================

const VERDICT_TEXT = JSON.stringify({
  pages: [
    { shotId: 'shot-x1', verdict: 'fail', issues: [{ severity: 'high', note: '计数按钮缺失' }] },
    { shotId: 'shot-x2', verdict: 'pass', issues: [] },
  ],
  summary: '1 fail / 1 pass',
})

test('ZB3V-2 visual 档 E2E：子面恰 shot_read（委派隔离反证）+ ⓪⁼ 直判零 pending + verdict 落链 + join verdict 回父', async () => {
  const { root, ws } = makeWorkspace('judge')
  const captured: { toolDefsByChild: Record<string, string[]> } = { toolDefsByChild: {} }
  const svc = createHostService({
    userDataDir: tmpDir('ud'),
    authzTimeoutMs: 120_000,
    modelFnOverride: scriptedParentModel([
      { tool: 'subagent_spawn', args: { task: '视觉验收判定（判据先行：shot-x1 计数=1 / shot-x2 布局完整）', type: 'visual', id: 'SA-vis-1' } },
      { tool: 'subagent_join', args: { id: 'SA-vis-1' } },
      { text: 'verdict 已收到——判定即视觉门结果（主面禁复判）' },
    ]),
    childModelFnOverride: scriptedChildModel({ 'SA-vis-1': [{ tool: 'shot_read', args: {} }, { text: VERDICT_TEXT }] }, captured),
  })
  const pushes: PushMessage[] = []
  autoAuthz(svc, pushes)
  try {
    const w = await ws(svc)
    const sess = (await svc.dispatch('session:create', { workspaceId: w.id })) as { sessionId: string }
    await svc.dispatch('turn:send', { workspaceId: w.id, sessionId: sess.sessionId, text: '派 visual 判定档验收截图' })
    await waitTurnEnd(svc, w.id, sess.sessionId)
    // 父链断言
    const parent = chainEvents(root, sess.sessionId)
    const spawn = systemPayloads(parent, 'subagent/spawn')[0] as Record<string, unknown>
    assert.ok(spawn, '父链 spawn 叙事')
    assert.equal(spawn['subagentType'], 'visual', 'subagentType 落链')
    assert.deepEqual(spawn['whitelist'], ['shot_read'])
    // verdict 叙事落链（判定 fail ≠ 工具执行 fail——toolResult ok,叙事两态分立）
    const verdictEv = systemPayloads(parent, 'browser/verdict')[0] as Record<string, unknown>
    assert.ok(verdictEv, 'browser/verdict 父链叙事（§4.8 verdict 落链）')
    assert.equal(verdictEv['subagentId'], 'SA-vis-1')
    assert.equal(verdictEv['passCount'], 1)
    assert.equal(verdictEv['failCount'], 1)
    assert.equal(verdictUnparsed(verdictEv), undefined)
    // join toolResult 携 verdict（模型可见面——判定即视觉门结果）
    const joinResult = parent.find((e) => e['kind'] === 'toolResult' && ((e['payload'] as Record<string, unknown>)['result'] as Record<string, unknown> | undefined)?.['verdict'])
    assert.ok(joinResult, 'join toolResult 携 verdict')
    const jr = ((joinResult as Record<string, unknown>)['payload'] as Record<string, unknown>)['result'] as Record<string, unknown>
    assert.equal(jr['ok'], true, '判定 fail ≠ 工具执行 fail（toolResult ok）')
    const verdict = jr['verdict'] as { pages: Array<{ shotId: string; verdict: string }> }
    assert.equal(verdict.pages[0]!.shotId, 'shot-x1')
    assert.equal(verdict.pages[0]!.verdict, 'fail')
    // 子链断言：session-start + ⓪⁼ 直判落子链（零 pending）+ shot_read 执行结果
    const child = chainEvents(root, 'SA-vis-1')
    assert.deepEqual(captured.toolDefsByChild['SA-vis-1'], ['shot_read'], '委派隔离反证：子面恰 shot_read（browser_* 不进子面）')
    const roRule = child.find((e) => String(e['turnId'] ?? '').includes('ro-tool:shot_read'))
    assert.ok(roRule, '子面 shot_read ⓪⁼ 直判落子链')
    assert.equal(((roRule as Record<string, unknown>)['payload'] as Record<string, unknown>)['decision'], 'APPROVED')
    assert.equal(pushes.filter((m) => m.topic === 'push:authz-pending' && String((m.payload as Record<string, unknown>)['requestId']).startsWith('SA-vis-1:')).length, 0, '受管证据读面零人审弹窗（父面 spawn/join 门由 autoAuthz 应答不计）')
    const shotReadResult = child.find((e) => e['kind'] === 'toolResult')
    assert.ok(shotReadResult, 'shot_read 执行结果落子链')
    svc.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

function verdictUnparsed(ev: Record<string, unknown>): unknown {
  return ev['verdictUnparsed']
}

test('ZB3V-3 unparsed：子链末条非契约 JSON → verdictUnparsed fail-visible（toolResult 标注 + 父链叙事）', async () => {
  const { root, ws } = makeWorkspace('unparsed')
  const svc = createHostService({
    userDataDir: tmpDir('ud'),
    authzTimeoutMs: 120_000,
    modelFnOverride: scriptedParentModel([
      { tool: 'subagent_spawn', args: { task: '判定', type: 'visual', id: 'SA-vis-2' } },
      { tool: 'subagent_join', args: { id: 'SA-vis-2' } },
      { text: '收口' },
    ]),
    childModelFnOverride: scriptedChildModel({ 'SA-vis-2': [{ text: '我看了一眼，应该没问题' }] }),
  })
  const pushes: PushMessage[] = []
  autoAuthz(svc, pushes)
  try {
    const w = await ws(svc)
    const sess = (await svc.dispatch('session:create', { workspaceId: w.id })) as { sessionId: string }
    await svc.dispatch('turn:send', { workspaceId: w.id, sessionId: sess.sessionId, text: '判定' })
    await waitTurnEnd(svc, w.id, sess.sessionId)
    const parent = chainEvents(root, sess.sessionId)
    const verdictEv = systemPayloads(parent, 'browser/verdict')[0] as Record<string, unknown>
    assert.ok(verdictEv, 'unparsed 也落叙事（禁静默吞）')
    assert.equal(verdictEv['verdictUnparsed'], true)
    const joinResult = parent.find((e) => e['kind'] === 'toolResult' && ((e['payload'] as Record<string, unknown>)['result'] as Record<string, unknown> | undefined)?.['verdictUnparsed'])
    assert.ok(joinResult, 'toolResult verdictUnparsed 标注（fail-visible 交回模型）')
    assert.equal((verdictEv['passCount'] ?? null), null, '无 verdict 不落 pass/fail 计数')
    svc.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
