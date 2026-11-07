/**
 * SKILL.md 导入互认（能力库导入；纯解析层 + 宿主 dispatch E2E，链真跑）
 *
 * 判据：
 *  - 解析：frontmatter name/description/version/author/tags 映射（内联数组与逗号分隔双形态、
 *    引号剥离）；无 frontmatter = 全文正文；未知键忽略；
 *  - id 推导：slugify(name) → slugify(文件名) → 'imported-skill' 兜底（CAPABILITY_ID_RE 字符域）；
 *  - fail-visible：无正文 / spec 超 CAPABILITY_SPEC_MAX → 逐文件 error 行，禁静默截断；
 *  - dispatch E2E：capability:import 逐文件写盘（.car/capabilities/<id>.json）+ capability/write
 *    叙事落链（imported:true + source）；id 冲突 → -2/-3 后缀（不覆盖既有条目）；坏文件独立 error 行。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { parseSkillMd, skillMdToCapability, slugifyCapabilityId } from '../src/host-core/skill-import.ts'
import { createHostService, type HostService, type PushMessage } from '../src/host-core/service.ts'
import type { CapabilityImportResult, SessionEventDTO, SessionEventPush, WorkspaceInfo } from '../src/shared/ipc-contract.ts'
import type { SessionHandle } from '../src/host-core/session-handle.ts'
import type { HostModelStep } from '../src/host-core/types.ts'

// ── 纯解析层 ──

test('parseSkillMd：标准 frontmatter（name/description/version/tags 内联数组）+ 正文', () => {
  const raw = ['---', 'name: code-review', 'description: 代码评审规范', 'version: 1.2.0', 'tags: [review, quality]', '---', '', '# 评审要点', '先看 diff 再下结论。'].join('\n')
  const p = parseSkillMd(raw)
  assert.equal(p.name, 'code-review')
  assert.equal(p.description, '代码评审规范')
  assert.equal(p.version, '1.2.0')
  assert.deepEqual(p.tags, ['review', 'quality'])
  assert.equal(p.body, '# 评审要点\n先看 diff 再下结论。')
})

test('parseSkillMd：tags 逗号分隔 + 引号值 + 无 frontmatter 全文正文', () => {
  const a = parseSkillMd(['---', "name: 'quoted-name'", 'tags: a, b，c', '---', 'body-a'].join('\n'))
  assert.equal(a.name, 'quoted-name')
  assert.deepEqual(a.tags, ['a', 'b', 'c'])
  const b = parseSkillMd('# 无 frontmatter\n直接正文')
  assert.equal(b.name, undefined)
  assert.equal(b.body, '# 无 frontmatter\n直接正文')
})

test('skillMdToCapability：id=slugify(name)、description 前置 blockquote、kind 恒 skill', () => {
  const raw = ['---', 'name: Code Review', 'description: 何时用：PR 评审场景', 'author: lqc', '---', '正文内容'].join('\n')
  const c = skillMdToCapability(raw, 'ignored.md')
  assert.ok(c.ok)
  if (!c.ok) return
  assert.equal(c.id, 'code-review')
  assert.equal(c.kind, 'skill')
  assert.equal(c.name, 'Code Review')
  assert.equal(c.author, 'lqc')
  assert.equal(c.status, 'active')
  assert.equal(c.spec, '> 何时用：PR 评审场景\n\n正文内容')
})

test('skillMdToCapability：中文名回退文件名 slug；全不可 slug 兜底 imported-skill', () => {
  const raw = ['---', 'name: 代码评审规范', '---', '正文'].join('\n')
  const c = skillMdToCapability(raw, 'Skill_文档 01.md')
  assert.ok(c.ok)
  if (!c.ok) return
  assert.equal(c.id, 'skill-01')
  const c2 = skillMdToCapability('正文only', '中文文档.md')
  assert.ok(c2.ok)
  if (!c2.ok) return
  assert.equal(c2.id, 'imported-skill')
})

test('slugifyCapabilityId：非法字符收敛、首尾连字符剥离、64 截断', () => {
  assert.equal(slugifyCapabilityId('  Foo__Bar!! '), 'foo-bar')
  assert.equal(slugifyCapabilityId('---abc---'), 'abc')
  assert.ok(slugifyCapabilityId('a'.repeat(100)).length <= 64)
})

test('skillMdToCapability fail-visible：无正文 / spec 超限', () => {
  const empty = skillMdToCapability(['---', 'name: x', '---'].join('\n'), 'empty.md')
  assert.ok(!empty.ok)
  const big = skillMdToCapability(['---', 'name: big', '---', 'x'.repeat(20_001)].join('\n'), 'big.md')
  assert.ok(!big.ok)
  if (!big.ok) assert.match(big.error, /超限/)
})

// ── 宿主 dispatch E2E ──

function tmpDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `car-skill-import-${label}-`))
}

function echoModel(): (h: SessionHandle) => () => Promise<HostModelStep> {
  return (h: SessionHandle) => async () => {
    const text = `echo:${h.currentTurnId()}`
    h.log.append('model', 'assistant', h.currentTurnId(), text)
    return { stopReason: 'stop', text, secretsRedacted: 0 as const }
  }
}

async function makeEnv(): Promise<{ svc: HostService; ws: WorkspaceInfo; sess: { sessionId: string }; root: string; pushes: PushMessage[] }> {
  const userData = tmpDir('ud')
  const root = tmpDir('ws')
  writeFileSync(join(root, 'car.config.ts'), "export default { llm: { baseUrl: 'http://127.0.0.1:9', model: 'test-model' } }\n", 'utf8')
  const svc = createHostService({ userDataDir: userData, modelFnOverride: echoModel() })
  const pushes: PushMessage[] = []
  svc.onPush((m) => pushes.push(m))
  const ws = (await svc.dispatch('workspace:register', { path: root })) as WorkspaceInfo
  const sess = (await svc.dispatch('session:create', { workspaceId: ws.id })) as { sessionId: string }
  return { svc, ws, sess, root, pushes }
}

function narrativeEvents(pushes: PushMessage[]): SessionEventDTO[] {
  return pushes.filter((m) => m.topic === 'push:session-event').map((m) => (m.payload as SessionEventPush).event)
}

test('capability:import E2E：逐文件写盘 + imported 叙事落链 + 冲突后缀 + 坏文件独立 error', async () => {
  const env = await makeEnv()
  const dir = tmpDir('files')
  const f1 = join(dir, 'code-review.md')
  writeFileSync(f1, ['---', 'name: code-review', 'description: 评审规范', 'tags: [review]', '---', '正文一'].join('\n'), 'utf8')
  const f2 = join(dir, 'deploy.md')
  writeFileSync(f2, ['---', 'name: code-review', '---', '正文二'].join('\n'), 'utf8') // 与 f1 同名 → -2 后缀
  const f3 = join(dir, 'broken.md')
  writeFileSync(f3, ['---', 'name: broken', '---'].join('\n'), 'utf8') // 无正文 → error 行

  const r = (await env.svc.dispatch('capability:import', {
    workspaceId: env.ws.id,
    sessionId: env.sess.sessionId,
    paths: [f1, f2, f3],
  })) as CapabilityImportResult

  assert.equal(r.results.length, 3)
  assert.ok(r.results[0]!.ok)
  assert.equal(r.results[0]!.id, 'code-review')
  assert.equal(r.results[0]!.chars, '> 评审规范\n\n正文一'.length)
  assert.ok(r.results[1]!.ok)
  assert.equal(r.results[1]!.id, 'code-review-2') // 冲突消解不覆盖既有条目
  assert.ok(!r.results[2]!.ok)
  assert.match(r.results[2]!.error ?? '', /无规范正文/)

  const list = (await env.svc.dispatch('capability:list', { workspaceId: env.ws.id })) as { entries: Array<{ id: string; kind: string; name: string; spec: string }> }
  const ids = list.entries.map((e) => e.id).sort()
  assert.deepEqual(ids, ['code-review', 'code-review-2'])
  const imported = list.entries.find((e) => e.id === 'code-review-2')!
  assert.equal(imported.kind, 'skill')
  assert.equal(imported.spec, '正文二') // 无 description 不前置 blockquote

  const events = narrativeEvents(env.pushes)
  const importRows = events.filter((e) => e.kind === 'system' && (e.payload as Record<string, unknown> | null)?.['type'] === 'capability/write')
  assert.ok(importRows.length >= 2)
  const importedRow = importRows.find((e) => (e.payload as Record<string, unknown>)['imported'] === true) as { payload: Record<string, unknown> } | undefined
  assert.ok(importedRow, 'capability/write 叙事含 imported:true')
  assert.equal(typeof importedRow!.payload['source'], 'string')
  env.svc.dispose()
})

test('capability:import 守卫：缺 paths fail-visible；import-pick 误入宿主 dispatch 显式拒绝', async () => {
  const env = await makeEnv()
  await assert.rejects(() => env.svc.dispatch('capability:import', { workspaceId: env.ws.id, sessionId: env.sess.sessionId }), /缺少 paths/)
  await assert.rejects(() => env.svc.dispatch('capability:import-pick', {}), /由 main 侧处理/)
  env.svc.dispose()
})
