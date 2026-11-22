/**
 * C6 · LF-1 链盘对账（LoopForge 借鉴——「链上最近一次成功写入的内容，现在是否还在盘上」；
 * 《借鉴七篇裁决记录-2026-11-22》Q-LF1/LF-2/LF-3 裁决落地；《v0.17.1-装配面四批-迭代规划》D-V171-3/4）
 *
 * 口径：
 *  - **对账源 = 工作区全部链**（主链 + 1.16 子链平铺 JSONL——子 agent 的 fs_write 同样入账；
 *    workspaceMeteringSummary 同款原始行解析——免内核验链，半行容错）；
 *  - **指纹两案并存（LF-3 裁决：B 主 A 兜底）**：案 B = fs_write 回执自含 `sha256`（tools.ts
 *    2026-11-22 起落链）；案 A = 老链回执无指纹 → 重放 toolCall `args.content` hash
 *    （append 层无参数截断——2026-11-16 一手核对，历史链天然覆盖）；
 *  - **按路径 last-wins**（跨链 seq 不可比 → ts 定序；末次成功操作决定行态）：
 *    末次 = fs_write → 盘缺 = 已删除 / hash 同 = 一致 / 异 = 漂移；
 *    末次 = fs_delete（链上删除收口）→ 盘缺 = 已删除（一致面·绿）/ 盘有 = 漂移（链外重建）；
 *  - **对账不判责只陈述**（漂移可能是用户手改/bash 副作用/进程外修改）；**读取时纯计算不落链**；
 *  - **盲区如实标注**（常驻 doctor 脚注）：bash_run / 浏览器写动作 / 进程外修改不经 fs 三件套
 *    账本——对账只覆盖 fs_write/fs_delete 面（LF-1 口径；known gap 进验证记录 LF-2 模板）。
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

export interface ChainDiskReconRow {
  /** 相对路径（正斜杠归一） */
  path: string
  /** 末次成功操作所在链（sessionId） */
  sessionId: string
  /** 末次成功操作链 seq */
  seq: number
  /** 末次成功操作时刻（事件 ts） */
  ts: number
  /** 末次写入字节（fs_delete 行 = 被删件 bytes，无 = null） */
  bytes: number | null
  /** 指纹（案 B 回执 / 案 A 重放；fs_delete = 被删件指纹，无 = null） */
  sha256: string | null
  /** 末次操作 */
  lastOp: 'fs_write' | 'fs_delete'
  /** 三态：一致 / 漂移（盘≠链——含链外重建）/ 已删除（盘上无此件） */
  state: 'match' | 'drift' | 'deleted'
  /** 行注（值不打印红线兼容——只含状态类别与构成，不含内容） */
  note: string
}

export interface ChainDiskReconResult {
  rows: ChainDiskReconRow[]
  /** 扫描的链文件数（含无 fs 面链） */
  sessions: number
  warnings: string[]
}

const norm = (p: string): string => p.replace(/\\/g, '/')

const sha256Of = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')

/** 盘面态探测（缺 = null；返回 size + hash——读失败 = hash null 禁伪造） */
function diskState(workspaceRoot: string, relPath: string): { size: number; sha256: string | null } | null {
  const abs = join(workspaceRoot, relPath)
  if (!existsSync(abs)) return null
  try {
    const st = statSync(abs)
    if (st.isDirectory()) return { size: st.size, sha256: null }
    const raw = readFileSync(abs)
    return { size: raw.length, sha256: createHash('sha256').update(raw).digest('hex') }
  } catch {
    return { size: -1, sha256: null }
  }
}

/**
 * 全链扫描 + 按路径聚合（一次遍历；配对 = toolCall(id) ↔ toolResult(id) last-wins）。
 * 事件形态（内核 1.24 实查）：toolCall payload { id, tool, args }；toolResult payload
 * { id, ok?, error?, sha256? }——error 在场/ok false = 非成功操作（不入账）。
 */
export function collectChainDiskRecon(sessionsDir: string, workspaceRoot: string): ChainDiskReconResult {
  const warnings: string[] = []
  let sessions = 0
  interface LastOp {
    sessionId: string
    seq: number
    ts: number
    path: string
    bytes: number | null
    sha256: string | null
    lastOp: 'fs_write' | 'fs_delete'
  }
  const byPath = new Map<string, LastOp>()
  let files: string[] = []
  try {
    files = readdirSync(sessionsDir).filter((f) => f.endsWith('.jsonl'))
  } catch {
    return { rows: [], sessions: 0, warnings }
  }
  for (const f of files) {
    const sessionId = f.slice(0, -'.jsonl'.length)
    sessions++
    let lines: string[] = []
    try {
      lines = readFileSync(join(sessionsDir, f), 'utf8').split('\n')
    } catch (err) {
      warnings.push(`会话 ${sessionId} 读取失败跳过：${err instanceof Error ? err.message : err}`)
      continue
    }
    /** callId → pending call（tool 摘要 + args 摘要——案 A 重放素材） */
    const calls = new Map<string, { tool: string; path: string; content?: string }>()
    for (const line of lines) {
      if (!line.trim()) continue
      let e: { seq?: unknown; ts?: unknown; kind?: unknown; payload?: unknown }
      try {
        e = JSON.parse(line)
      } catch {
        continue // 半行容错
      }
      if (e.kind !== 'toolCall' && e.kind !== 'toolResult') continue
      const p = (e.payload ?? {}) as Record<string, unknown>
      const id = typeof p['id'] === 'string' ? p['id'] : null
      if (!id) continue
      const seq = typeof e.seq === 'number' ? e.seq : 0
      const ts = typeof e.ts === 'number' ? e.ts : 0
      if (e.kind === 'toolCall') {
        const tool = typeof p['tool'] === 'string' ? p['tool'] : ''
        const args = (p['args'] ?? {}) as Record<string, unknown>
        const rawPath = typeof args['path'] === 'string' ? args['path'] : null
        if (!rawPath) continue
        calls.set(id, {
          tool,
          path: norm(rawPath),
          ...(tool === 'fs_write' && typeof args['content'] === 'string' ? { content: args['content'] } : {}),
        })
        continue
      }
      // toolResult：成功判定（error 在场 = 非成功；ok === false 同——顶面与 result 嵌套面双读）。
      // 内核形态实查（1.27）：成功 = { id, result: {…工具返回} }（授权台账行 = { id, error, granted }）；
      // 对账面双兼容（嵌套 result 优先——真实链形态；平铺 = 测试/历史构造面）。
      const inner = (p['result'] ?? null) as Record<string, unknown> | null
      const readReceipt = (k: string): unknown => {
        if (inner && inner[k] !== undefined) return inner[k]
        return p[k]
      }
      const failed =
        typeof p['error'] === 'string' || p['ok'] === false || (inner != null && inner['ok'] === false)
      const call = calls.get(id)
      calls.delete(id)
      if (!call || failed) continue
      if (call.tool !== 'fs_write' && call.tool !== 'fs_delete') continue
      const prev = byPath.get(call.path)
      if (prev && (prev.ts > ts || (prev.ts === ts && prev.seq >= seq))) continue // 非末次（跨链 ts 定序）
      if (call.tool === 'fs_write') {
        const receiptSha = typeof readReceipt('sha256') === 'string' ? (readReceipt('sha256') as string) : null
        const bytes = typeof readReceipt('bytes') === 'number' ? (readReceipt('bytes') as number) : null
        byPath.set(call.path, {
          sessionId,
          seq,
          ts,
          path: call.path,
          bytes,
          sha256: receiptSha ?? (call.content != null ? sha256Of(call.content) : null), // 案 B 主 / 案 A 兜底
          lastOp: 'fs_write',
        })
      } else {
        byPath.set(call.path, {
          sessionId,
          seq,
          ts,
          path: call.path,
          bytes: typeof readReceipt('deletedBytes') === 'number' ? (readReceipt('deletedBytes') as number) : null,
          sha256: typeof readReceipt('deletedSha256') === 'string' ? (readReceipt('deletedSha256') as string) : null,
          lastOp: 'fs_delete',
        })
      }
    }
  }
  // 盘面对账（三态判定）
  const rows: ChainDiskReconRow[] = []
  for (const op of byPath.values()) {
    const disk = diskState(workspaceRoot, op.path)
    if (op.lastOp === 'fs_delete') {
      if (disk == null) {
        rows.push({ ...op, state: 'deleted', note: '链上删除收口且盘面无件（一致面）' })
      } else {
        rows.push({ ...op, state: 'drift', note: '链上已删除而盘面在件（链外重建——对账不判责）' })
      }
      continue
    }
    if (disk == null) {
      rows.push({ ...op, state: 'deleted', note: '链上末次写入在案而盘面无件（盘面缺失——对账不判责）' })
      continue
    }
    if (op.bytes != null && disk.size !== op.bytes) {
      rows.push({ ...op, state: 'drift', note: `盘面 size 不符（链 ${op.bytes}B / 盘 ${disk.size}B）` })
      continue
    }
    if (op.sha256 != null && disk.sha256 != null) {
      rows.push({ ...op, state: disk.sha256 === op.sha256 ? 'match' : 'drift', note: disk.sha256 === op.sha256 ? '盘 = 链（指纹一致）' : '盘面内容与链上指纹不符（盘≠链——手改/bash 副作用/进程外修改均可能）' })
      continue
    }
    // 指纹缺席（fs_write 无回执指纹且 args.content 缺席——形态外容错）= 以 size 一致近似陈述
    rows.push({ ...op, state: 'match', note: '指纹缺席（size 一致近似——禁伪造 hash）' })
  }
  rows.sort((a, b) => a.path < b.path ? -1 : 1)
  return { rows, sessions, warnings }
}
