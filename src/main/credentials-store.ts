/**
 * K6-ME · 端点存储纯决策层（零 electron 依赖——node:test 可测）
 *
 * 职责：三代档归一（v2 多端点 / v1 单对象 / cleared 墓碑）、槽定位 upsert、
 * 删除后 activeId 迁移、切换 active。IO 与 safeStorage 留在 credentials.ts（薄封装）。
 */
import { randomUUID } from 'node:crypto'

/** K5-F：端点模型条目（一个 URL 多个模型——Claude Code 式；首条 = 装配锚点模型） */
export interface EndpointModelEntry {
  id: string
  contextWindow: number | null
}

export interface EndpointMeta {
  baseUrl: string
  /** K5-D（V2）：适配器族声明（openai-compat | anthropic）；读侧缺省 openai-compat（存量档兼容） */
  adapterId: 'openai-compat' | 'anthropic'
  /** K5-F：模型列表（≥1 条；首条 = 锚点）。存量单模型档（model/contextWindow 键）读侧折叠为单条列表 */
  models: EndpointModelEntry[]
}

/** K6-ME：带槽 id 的端点条目（存储面；meta 面不携带 key） */
export interface StoredEndpoint extends EndpointMeta {
  id: string
  keyEncrypted: string
}

export interface StoreFile {
  version: 2
  endpoints: StoredEndpoint[]
  activeId: string | null
}

/** 端点元数据 + 槽 id（无 Key——doctor/装配/设置页读取面） */
export interface EndpointMetaWithId extends EndpointMeta {
  id: string
}

/** 保存入参（宽形态：models 的 contextWindow 可选——归一由调用方用 normModels 完成） */
export interface EndpointWithKey extends Omit<EndpointMeta, 'models'> {
  /** K5-F：Key 可缺席 = 沿用该端点已存加密 Key（仅更新模型列表/元数据——改模型不重输 Key） */
  key?: string
  models: Array<{ id: string; contextWindow?: number | null }>
  /** K6-ME：端点槽 id——有 = 更新该槽；无 = 新增槽（Key 必填，无存量可沿用） */
  endpointId?: string
}

export const normAdapter = (v: unknown): 'openai-compat' | 'anthropic' => (v === 'anthropic' ? 'anthropic' : 'openai-compat')

/** 模型条目归一：字符串数组 / {id,contextWindow} 数组 / 旧单模型键 → 条目列表（去空去重保序） */
export function normModels(raw: unknown, legacyModel: unknown, legacyWindow: unknown): EndpointModelEntry[] {
  const out: EndpointModelEntry[] = []
  const push = (id: unknown, win: unknown) => {
    if (typeof id !== 'string' || !id.trim()) return
    if (out.some((m) => m.id === id.trim())) return
    out.push({ id: id.trim(), contextWindow: typeof win === 'number' && win > 0 ? win : null })
  }
  if (Array.isArray(raw)) {
    for (const e of raw) {
      if (typeof e === 'string') push(e, undefined)
      else if (e && typeof e === 'object') push((e as EndpointModelEntry).id, (e as EndpointModelEntry).contextWindow)
    }
  }
  // 存量单模型档（K5-D 及以前形态）：model/contextWindow 顶层键 → 追加为条目
  if (typeof legacyModel === 'string' && legacyModel.trim()) push(legacyModel, legacyWindow)
  return out
}

/** v2 端点条目归一（槽内校验——baseUrl/keyEncrypted/models 缺一即弃槽） */
export function normStoredEndpoint(raw: unknown): StoredEndpoint | null {
  const p = (raw ?? {}) as Record<string, unknown>
  if (typeof p.baseUrl !== 'string' || !p.baseUrl || typeof p.keyEncrypted !== 'string' || !p.keyEncrypted) return null
  const models = normModels(p.models, p.model, p.contextWindow)
  if (!models.length) return null
  return {
    id: typeof p.id === 'string' && p.id ? p.id : randomUUID(),
    baseUrl: p.baseUrl,
    adapterId: normAdapter(p.adapterId),
    models,
    keyEncrypted: p.keyEncrypted,
  }
}

/**
 * 读存储并归一为 v2 形态（**不写回**——读路径零写盘；首次写操作落新形态）。
 * 三代档兼容：v2 多端点 / v1 单对象 / cleared 墓碑 / 损坏 JSON → 统一 StoreFile。
 */
export function parseStoreFile(raw: unknown): StoreFile {
  const empty: StoreFile = { version: 2, endpoints: [], activeId: null }
  if (!raw || typeof raw !== 'object') return empty
  const p = raw as Record<string, unknown>
  if (p.cleared === true) return empty // 旧 clear 墓碑
  // v2 多端点档
  if (Array.isArray(p.endpoints)) {
    const endpoints = p.endpoints.map(normStoredEndpoint).filter((e): e is StoredEndpoint => e !== null)
    const activeId = typeof p.activeId === 'string' && endpoints.some((e) => e.id === p.activeId) ? p.activeId : (endpoints[0]?.id ?? null)
    return { version: 2, endpoints, activeId }
  }
  // v1 单对象档（有 keyEncrypted 即视为端点档）→ 惰性迁移为单端点列表
  const legacy = normStoredEndpoint(p)
  if (legacy) return { version: 2, endpoints: [legacy], activeId: legacy.id }
  return empty
}

/**
 * save 决策：endpointId 指定 = 更新该槽（槽不存在 fail-visible）；无 = 新增。
 * **save 即激活**（「保存并使用」语义）。keyEncrypted 由调用方决定（新 Key 加密 or 沿用槽存量）。
 * 返回落槽后的条目（供 meta 面返回）。
 */
export function upsertEndpoint(store: StoreFile, ep: EndpointWithKey, keyEncrypted: string): { store: StoreFile; saved: StoredEndpoint } {
  const target = ep.endpointId ? store.endpoints.find((e) => e.id === ep.endpointId) : undefined
  if (ep.endpointId && !target) {
    throw new Error('CAR-E-DESKTOP: 端点槽不存在（已被删除？）——请刷新设置页重试')
  }
  // 防呆：同 baseUrl + 同适配器已存在槽（非本次编辑目标）→ fail-visible 引导编辑（禁重复槽堆积）
  const adapter = normAdapter(ep.adapterId)
  const dup = store.endpoints.find((e) => e.id !== target?.id && e.baseUrl === ep.baseUrl && e.adapterId === adapter)
  if (dup) {
    throw new Error(`CAR-E-DESKTOP: 该 Base URL 已存在端点（${ep.baseUrl}·${adapter}）——请在列表中点「编辑」修改它，勿重复新增`)
  }
  const models = normModels(ep.models, undefined, undefined)
  if (!models.length) {
    throw new Error('CAR-E-DESKTOP: 自定义端点至少需要一个模型（模型列表为空——Claude Code 式一 URL 多模型）')
  }
  const id = target?.id ?? randomUUID()
  const saved: StoredEndpoint = { id, baseUrl: ep.baseUrl, adapterId: normAdapter(ep.adapterId), models, keyEncrypted }
  const endpoints = target ? store.endpoints.map((e) => (e.id === id ? saved : e)) : [...store.endpoints, saved]
  return { store: { version: 2, endpoints, activeId: id }, saved }
}

/** 删除端点槽；删 active 时 activeId 自动迁移到剩余第一项（无剩余 = null）。返回删除是否发生 */
export function removeFromStore(store: StoreFile, endpointId: string): { store: StoreFile; removed: boolean } {
  const next = store.endpoints.filter((e) => e.id !== endpointId)
  if (next.length === store.endpoints.length) return { store, removed: false }
  const activeId = store.activeId === endpointId ? (next[0]?.id ?? null) : store.activeId
  return { store: { version: 2, endpoints: next, activeId }, removed: true }
}

/** 切换 active（id 不存在 fail-visible） */
export function activateInStore(store: StoreFile, endpointId: string): { store: StoreFile; active: StoredEndpoint } {
  const target = store.endpoints.find((e) => e.id === endpointId)
  if (!target) throw new Error('CAR-E-DESKTOP: 端点槽不存在——无法切换')
  return { store: { ...store, activeId: target.id }, active: target }
}

/** meta 读取面投影（去 keyEncrypted） */
export function toMeta(e: StoredEndpoint): EndpointMetaWithId {
  const { id, baseUrl, adapterId, models } = e
  return { id, baseUrl, adapterId, models }
}
