/**
 * 能力库存储（T-24 / v0.3 D2-S1；PRD C-1 本地目录先行）
 *
 * 口径（PRD §2/§6）：
 *  - 条目库 = <workspaceRoot>/.car/capabilities/<id>.json——与 .car/memory/、.car/sessions/
 *    同构（白盒可见、工作区分片、零网络依赖）；id 即文件名（MemoryStore ID_RE 同款路径穿越拒绝）；
 *  - 三分界红线：能力引用 = prompt 注入（纯文本进投影）——不注册工具、不装载代码；
 *  - v0.3 收窄 schema：kind 三分类统一注入语义；spec ≤ 20,000 字符（fail-visible）；
 *    不做 price/calls/tokens/quota/cron 平台运营字段；
 *  - 文件 CRUD fail-visible（载入面跳过损坏条目 + 留痕——白盒文件允许手改，损坏不阻塞列表）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const CAPABILITY_ID_RE = /^[a-z0-9-]+$/
export const CAPABILITY_SPEC_MAX = 20_000
export const CAPABILITY_KINDS = ['expert', 'skill', 'kb'] as const
export const CAPABILITY_STATUSES = ['active', 'maintain', 'retired'] as const

export type CapabilityKind = (typeof CAPABILITY_KINDS)[number]
export type CapabilityStatus = (typeof CAPABILITY_STATUSES)[number]

export interface CapabilityEntry {
  id: string
  kind: CapabilityKind
  name: string
  version?: string
  author?: string
  tags?: string[]
  /** 规范正文（注入物）——纯文本/markdown */
  spec: string
  status: CapabilityStatus
  createdAt: number
  updatedAt: number
}

export function capabilitiesDirFor(workspaceRoot: string): string {
  return join(workspaceRoot, '.car', 'capabilities')
}

export interface CapabilityListResult {
  entries: CapabilityEntry[]
  /** 载入跳过的损坏条目（fail-visible 显性化——禁静默吞） */
  warnings: string[]
}

export function listCapabilities(workspaceRoot: string): CapabilityListResult {
  const dir = capabilitiesDirFor(workspaceRoot)
  if (!existsSync(dir)) return { entries: [], warnings: [] }
  const entries: CapabilityEntry[] = []
  const warnings: string[] = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue
    try {
      entries.push(validateCapabilityEntry(JSON.parse(readFileSync(join(dir, f), 'utf8'))))
    } catch (err) {
      warnings.push(`${f}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  entries.sort((a, b) => b.updatedAt - a.updatedAt)
  return { entries, warnings }
}

export function validateCapabilityEntry(input: unknown): CapabilityEntry {
  const e = (input ?? {}) as Record<string, unknown>
  if (typeof e['id'] !== 'string' || !CAPABILITY_ID_RE.test(e['id'])) {
    throw new Error(`条目 id 非法（${String(e['id']).slice(0, 32)}）——仅允许小写字母数字连字符`)
  }
  if (typeof e['kind'] !== 'string' || !CAPABILITY_KINDS.includes(e['kind'] as CapabilityKind)) {
    throw new Error(`条目 kind 非法——仅 expert/skill/kb`)
  }
  if (typeof e['name'] !== 'string' || e['name'].length === 0) throw new Error('条目缺少 name')
  if (typeof e['spec'] !== 'string') throw new Error('条目缺少 spec（规范正文）')
  if (e['spec'].length > CAPABILITY_SPEC_MAX) {
    throw new Error(`规范正文超限（${e['spec'].length} > ${CAPABILITY_SPEC_MAX} 字符）`)
  }
  const status = e['status'] ?? 'active'
  if (typeof status !== 'string' || !CAPABILITY_STATUSES.includes(status as CapabilityStatus)) {
    throw new Error(`条目 status 非法——仅 active/maintain/retired`)
  }
  return {
    id: e['id'],
    kind: e['kind'] as CapabilityKind,
    name: e['name'],
    ...(typeof e['version'] === 'string' ? { version: e['version'] } : {}),
    ...(typeof e['author'] === 'string' ? { author: e['author'] } : {}),
    ...(Array.isArray(e['tags']) ? { tags: (e['tags'] as unknown[]).filter((t): t is string => typeof t === 'string') } : {}),
    spec: e['spec'],
    status: status as CapabilityStatus,
    createdAt: typeof e['createdAt'] === 'number' ? e['createdAt'] : Date.now(),
    updatedAt: typeof e['updatedAt'] === 'number' ? e['updatedAt'] : Date.now(),
  }
}

/** 新建/全量更新（id 即文件名；同 id 覆盖 = 编辑面用 editCapability——本函数面向新建） */
export function writeCapability(workspaceRoot: string, input: unknown): CapabilityEntry {
  const entry = validateCapabilityEntry(input)
  const dir = capabilitiesDirFor(workspaceRoot)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, entry.id + '.json')
  if (existsSync(file)) throw new Error(`CAR-E-DESKTOP: 条目已存在（${entry.id}）——编辑走 capability:edit`)
  writeFileSync(file, JSON.stringify(entry, null, 2), 'utf8')
  return entry
}

export function editCapability(workspaceRoot: string, id: string, patch: unknown): CapabilityEntry {
  if (!CAPABILITY_ID_RE.test(id)) throw new Error(`CAR-E-DESKTOP: 条目 id 非法（${id.slice(0, 32)}）`)
  const file = join(capabilitiesDirFor(workspaceRoot), id + '.json')
  if (!existsSync(file)) throw new Error(`CAR-E-DESKTOP: 条目不存在（${id}）`)
  const current = validateCapabilityEntry(JSON.parse(readFileSync(file, 'utf8')))
  const p = (patch ?? {}) as Record<string, unknown>
  const merged = validateCapabilityEntry({
    ...current,
    ...(p['name'] !== undefined ? { name: p['name'] } : {}),
    ...(p['kind'] !== undefined ? { kind: p['kind'] } : {}),
    ...(p['spec'] !== undefined ? { spec: p['spec'] } : {}),
    ...(p['status'] !== undefined ? { status: p['status'] } : {}),
    ...(p['version'] !== undefined ? { version: p['version'] } : {}),
    ...(p['author'] !== undefined ? { author: p['author'] } : {}),
    ...(p['tags'] !== undefined ? { tags: p['tags'] } : {}),
    id,
    createdAt: current.createdAt,
    updatedAt: Date.now(),
  })
  writeFileSync(file, JSON.stringify(merged, null, 2), 'utf8')
  return merged
}

export function deleteCapability(workspaceRoot: string, id: string): void {
  if (!CAPABILITY_ID_RE.test(id)) throw new Error(`CAR-E-DESKTOP: 条目 id 非法（${id.slice(0, 32)}）`)
  const file = join(capabilitiesDirFor(workspaceRoot), id + '.json')
  if (!existsSync(file)) throw new Error(`CAR-E-DESKTOP: 条目不存在（${id}）`)
  unlinkSync(file)
}

export function loadCapability(workspaceRoot: string, id: string): CapabilityEntry | null {
  if (!CAPABILITY_ID_RE.test(id)) return null
  const file = join(capabilitiesDirFor(workspaceRoot), id + '.json')
  if (!existsSync(file)) return null
  try {
    return validateCapabilityEntry(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return null
  }
}
