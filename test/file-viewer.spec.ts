/**
 * T-FV 文件查看器 E2E（原型 fv-mask 复刻；宿主公共 API 驱动，链真跑）
 *
 * 判据：
 *  - 预览读取 = fs_read 同管线：redact 脱敏（密钥面不渲染）、256KB 截断、binary 仅 stat 不读内容；
 *  - file/preview 叙事落链（alive 会话）；回放/无句柄 = logged:false（只读预览不落链）；
 *  - deny 规则路径 / 工作区外 = hardReject fail-visible（与 fs_read 同口径），且零落链；
 *  - file/open 落链（渲染层在 shell 成功后调用——宿主只管叙事）；file:shell-open 误入宿主 = 显式拒绝。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createHostService, type HostService, type PushMessage } from '../src/host-core/service.ts'
import type { FilePreviewResultDTO, SessionEventDTO, SessionEventPush, WorkspaceInfo } from '../src/shared/ipc-contract.ts'
import { classifyPreviewFile, parseCsvPreview, resolveViewerPath } from '../src/shared/file-preview.ts'

function tmpDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `car-tfv-${label}-`))
}

interface Env {
  svc: HostService
  ws: WorkspaceInfo
  sess: { sessionId: string }
  root: string
  pushes: PushMessage[]
}

async function makeEnv(): Promise<Env> {
  const userData = tmpDir('ud')
  const root = tmpDir('ws')
  writeFileSync(join(root, 'car.config.ts'), "export default { llm: { baseUrl: 'http://127.0.0.1:9', model: 'test-model' } }\n", 'utf8')
  const svc = createHostService({ userDataDir: userData })
  const pushes: PushMessage[] = []
  svc.onPush((m) => pushes.push(m))
  const ws = (await svc.dispatch('workspace:register', { path: root })) as WorkspaceInfo
  const sess = (await svc.dispatch('session:create', { workspaceId: ws.id })) as { sessionId: string }
  return { svc, ws, sess, root, pushes }
}

function eventsOf(env: Env): SessionEventDTO[] {
  return env.pushes.filter((m) => m.topic === 'push:session-event').map((m) => (m.payload as SessionEventPush).event)
}

function fileNarratives(env: Env, type: string): SessionEventDTO[] {
  return eventsOf(env).filter((e) => (e.payload as Record<string, unknown> | null)?.['type'] === type)
}

async function preview(env: Env, path: string, sessionId?: string): Promise<FilePreviewResultDTO> {
  return (await env.svc.dispatch('file:preview', {
    workspaceId: env.ws.id,
    sessionId: sessionId ?? env.sess.sessionId,
    path,
  })) as FilePreviewResultDTO
}

test('T-FV-0 共享纯函数：分类 / CSV 解析（引号·转义·行数真值）/ 相对路径解析', () => {
  assert.equal(classifyPreviewFile('a.md'), 'text')
  assert.equal(classifyPreviewFile('a.CSV'), 'csv')
  assert.equal(classifyPreviewFile('a.tsv'), 'csv')
  assert.equal(classifyPreviewFile('b.htm'), 'html')
  assert.equal(classifyPreviewFile('c.pdf'), 'binary')
  assert.equal(classifyPreviewFile('d.xlsx'), 'binary')
  const csv = parseCsvPreview('a,b\n"x,1","y""z"""\r\n3,4\n', 2)
  assert.deepEqual(csv.rows, [
    ['a', 'b'],
    ['x,1', 'y"z"'],
  ])
  assert.equal(csv.totalRows, 3, 'CRLF 与尾行均计入真实行数（禁伪造总数）')
  assert.equal(csv.truncated, true)
  assert.equal(resolveViewerPath('D:\\ws', 'reports\\a.md'), 'D:\\ws\\reports\\a.md')
  assert.equal(resolveViewerPath('D:\\ws', 'D:\\abs\\a.md'), 'D:\\abs\\a.md')
  assert.equal(resolveViewerPath('/root/ws', 'reports/a.md'), '/root/ws/reports/a.md')
})

test('T-FV-1 text 预览全链：fs_read 同管线脱敏（密钥面不渲染）+ file/preview 落链 + 相对路径解析', async () => {
  const env = await makeEnv()
  try {
    const FAKE_KEY = 'sk-abcdefghijklmnopqrstuvwxyz0123456789' // secrets-scan:allow dummy target material for redaction assertion (viewer K-FS-4 pipeline, not a credential)
    const dir = join(env.root, 'reports')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'weekly.md'), `# 周报\n\n正文段落。\n\nkey=${FAKE_KEY}\n`, 'utf8')
    const r = await preview(env, 'reports/weekly.md')
    assert.equal(r.kind, 'text')
    assert.equal(r.path, join(env.root, 'reports', 'weekly.md'), '相对入参按工作区 root 解析为绝对路径')
    assert.ok(r.redactedCount !== undefined && r.redactedCount >= 1, 'redact 命中记数（K-FS-4）')
    assert.ok(!String(r.content).includes(FAKE_KEY), '密钥原文不进预览内容')
    assert.ok(String(r.content).includes('# 周报'), '非密钥正文原样')
    assert.equal(r.logged, true, 'alive 会话落链')
    const ev = fileNarratives(env, 'file/preview').at(-1)!
    const p = ev.payload as Record<string, unknown>
    assert.equal(p['kind'], 'text')
    assert.equal(p['tier'], 'allow', '规则面命中上下文随叙事（%WORKSPACE% 读允许）')
    assert.ok(p['ruleId'], 'ruleId 随叙事')
    assert.equal(p['redacted'], r.redactedCount)
  } finally {
    env.svc.closeAll?.()
  }
})

test('T-FV-2 csv / binary 分流：csv 走文本管线；binary 仅 stat 不读内容', async () => {
  const env = await makeEnv()
  try {
    writeFileSync(join(env.root, 'rows.csv'), 'a,b\n1,2\n3,4\n', 'utf8')
    const csv = await preview(env, 'rows.csv')
    assert.equal(csv.kind, 'csv')
    assert.ok(String(csv.content).includes('1,2'), 'csv 走文本管线（渲染层自行解析表格）')
    assert.equal(csv.logged, true)

    const binBytes = Buffer.from([0, 1, 2, 3, 255, 254])
    writeFileSync(join(env.root, 'data.bin'), binBytes)
    const bin = await preview(env, 'data.bin')
    assert.equal(bin.kind, 'binary')
    assert.equal(bin.content, undefined, 'binary 不读内容（fs_read 二进制拒读面不触发——直接 stat）')
    assert.equal(bin.size, binBytes.length, 'size = stat 真值')
    assert.equal(typeof bin.mtime, 'number')
    assert.equal(bin.logged, true)
    assert.equal(fileNarratives(env, 'file/preview').length, 2)
  } finally {
    env.svc.closeAll?.()
  }
})

test('T-FV-3 256KB 截断（fs_read 同口径）', async () => {
  const env = await makeEnv()
  try {
    writeFileSync(join(env.root, 'big.md'), 'x'.repeat(256 * 1024 + 1), 'utf8')
    const r = await preview(env, 'big.md')
    assert.equal(r.truncated, true)
    assert.ok(String(r.content ?? '').length <= 256 * 1024)
  } finally {
    env.svc.closeAll?.()
  }
})

test('T-FV-4 拒绝面（与 fs_read 同口径）：工作区外 / deny 规则路径 fail-visible 且零落链', async () => {
  const env = await makeEnv()
  try {
    const outside = join(tmpDir('outside'), 'o.md')
    writeFileSync(outside, 'outside', 'utf8')
    await assert.rejects(() => preview(env, outside), (err: Error) => /安全规则拒绝|工作区外|fs_read/.test(err.message))
    // .car\ 出厂拒绝×3 预设（hardReject 先于 stat——文件无需存在）
    await assert.rejects(() => preview(env, join(env.root, '.car', 'secret.md')), (err: Error) => /安全规则拒绝|拒绝/.test(err.message))
    assert.equal(fileNarratives(env, 'file/preview').length, 0, '被拒路径零落链')
  } finally {
    env.svc.closeAll?.()
  }
})

test('T-FV-5 回放/无句柄 = 只读预览 logged:false（零叙事）', async () => {
  const env = await makeEnv()
  try {
    writeFileSync(join(env.root, 'note.md'), 'replay preview', 'utf8')
    const r = await preview(env, 'note.md', 'ghost-session')
    assert.equal(r.logged, false, '无 alive 句柄 = 预览照常、动作不落链')
    assert.ok(String(r.content).includes('replay preview'))
    assert.equal(fileNarratives(env, 'file/preview').length, 0)
  } finally {
    env.svc.closeAll?.()
  }
})

test('T-FV-6 file/open 落链 + file:shell-open 误入宿主显式拒绝', async () => {
  const env = await makeEnv()
  try {
    const r = (await env.svc.dispatch('file:open', {
      workspaceId: env.ws.id,
      sessionId: env.sess.sessionId,
      path: join(env.root, 'a.md'),
      how: 'system',
    })) as { ok: boolean; logged: boolean }
    assert.equal(r.ok, true)
    assert.equal(r.logged, true)
    const ev = fileNarratives(env, 'file/open').at(-1)!
    const p = ev.payload as Record<string, unknown>
    assert.equal(p['how'], 'system')
    assert.ok(String(p['path']).endsWith('a.md'))
    await assert.rejects(
      () => env.svc.dispatch('file:shell-open', { path: join(env.root, 'a.md'), how: 'system' }),
      (err: Error) => /main 侧处理/.test(err.message),
      'shell 能力通道不入宿主 dispatch（workspace:pick 同款守卫）',
    )
  } finally {
    env.svc.closeAll?.()
  }
})
