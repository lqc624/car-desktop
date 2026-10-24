/**
 * S4-S2 · 自定义端点凭据存储（main 侧独占——N-D1 红线承载）
 *
 * 口径：
 *  - Key 经 Electron safeStorage 加密落盘 userData/credentials.json（OS keychain 承载）；
 *    **加密不可用 = 保存 fail-visible**（禁静默明文落盘，R-3）；
 *  - 元数据（baseUrl/model/contextWindow）非密、同文件明文（doctor/装配读取面）；
 *  - 解密 Key 只在内存流转：main 读出 → credentials:key-push 推宿主（装配注入）——
 *    渲染层/宿主/日志均不持明文（值不打印红线）；
 *  - v0.1 = 单端点槽位（保存即覆盖；多端点登记随 v0.2 多端点切换批）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { safeStorage } from 'electron'

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
/** 保存入参（宽形态：models 的 contextWindow 可选——归一在 saveEndpoint 内完成） */
export interface EndpointWithKey extends Omit<EndpointMeta, 'models'> {
  /** K5-F：Key 可缺席 = 沿用已存加密 Key（仅更新模型列表/元数据——改模型不重输 Key） */
  key?: string
  models: Array<{ id: string; contextWindow?: number | null }>
}

interface Stored extends EndpointMeta {
  keyEncrypted: string
}

const file = (userDataDir: string): string => path.join(userDataDir, 'credentials.json')

const normAdapter = (v: unknown): 'openai-compat' | 'anthropic' => (v === 'anthropic' ? 'anthropic' : 'openai-compat')

/** 模型条目归一：字符串数组 / {id,contextWindow} 数组 / 旧单模型键 → 条目列表（去空去重保序） */
function normModels(raw: unknown, legacyModel: unknown, legacyWindow: unknown): EndpointModelEntry[] {
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

function readStored(userDataDir: string): Stored | null {
  if (!existsSync(file(userDataDir))) return null
  try {
    const p = JSON.parse(readFileSync(file(userDataDir), 'utf8')) as Partial<Stored> & { model?: unknown; contextWindow?: unknown }
    if (typeof p.baseUrl !== 'string' || typeof p.keyEncrypted !== 'string') return null
    const models = normModels(p.models, p.model, p.contextWindow)
    if (!models.length) return null
    return {
      baseUrl: p.baseUrl,
      adapterId: normAdapter(p.adapterId),
      models,
      keyEncrypted: p.keyEncrypted,
    }
  } catch {
    return null
  }
}

export function saveEndpoint(userDataDir: string, ep: EndpointWithKey, opts: { revealExistingKey?: () => string | null } = {}): EndpointMeta {
  const models = normModels(ep.models, undefined, undefined)
  if (!models.length) {
    throw new Error('CAR-E-DESKTOP: 自定义端点至少需要一个模型（模型列表为空——Claude Code 式一 URL 多模型）')
  }
  // Key 缺席 = 沿用已存加密 Key（模型列表更新不重输 Key）；无存量且无新 Key = fail-visible
  let keyEncrypted: string
  if (typeof ep.key === 'string' && ep.key.trim()) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('CAR-E-DESKTOP: safeStorage 不可用（OS keychain 缺席）——拒绝明文落盘（N-D1）；自定义端点保存失败')
    }
    keyEncrypted = safeStorage.encryptString(ep.key.trim()).toString('base64')
  } else {
    const existing = readStored(userDataDir)
    if (!existing) {
      throw new Error('CAR-E-DESKTOP: 首次保存端点必须提供 API Key（之后更新模型列表可留空沿用）')
    }
    keyEncrypted = existing.keyEncrypted
  }
  mkdirSync(userDataDir, { recursive: true })
  const stored: Stored = {
    baseUrl: ep.baseUrl,
    adapterId: normAdapter(ep.adapterId),
    models,
    keyEncrypted,
  }
  const tmp = file(userDataDir) + '.tmp'
  writeFileSync(tmp, JSON.stringify(stored, null, 2), 'utf8')
  // 原子替换（同卷 rename——fileSecurityStore 同款）
  renameSync(tmp, file(userDataDir))
  return { baseUrl: ep.baseUrl, adapterId: normAdapter(ep.adapterId), models }
}

/** 端点元数据（无 Key——doctor/装配读取面） */
export function loadEndpointMeta(userDataDir: string): EndpointMeta | null {
  const s = readStored(userDataDir)
  return s ? { baseUrl: s.baseUrl, adapterId: s.adapterId, models: s.models } : null
}

/** 解密 Key（内存流转——仅供 credentials:key-push 推宿主装配；禁打印禁落盘） */
export function revealEndpointKey(userDataDir: string): string | null {
  const s = readStored(userDataDir)
  if (!s) return null
  try {
    return safeStorage.decryptString(Buffer.from(s.keyEncrypted, 'base64'))
  } catch {
    return null // 解密失败（换机/系统凭据变更）——视为未配置，引导重新保存
  }
}

export function clearEndpoint(userDataDir: string): void {
  if (existsSync(file(userDataDir))) {
    mkdirSync(userDataDir, { recursive: true })
    writeFileSync(file(userDataDir), JSON.stringify({ cleared: true }, null, 2), 'utf8')
  }
}
