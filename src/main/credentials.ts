/**
 * S4-S2 · 自定义端点凭据存储（main 侧独占——N-D1 红线承载）
 *
 * 口径：
 *  - Key 经 Electron safeStorage 加密落盘 userData/credentials.json（OS keychain 承载）；
 *    **加密不可用 = 保存 fail-visible**（禁静默明文落盘，R-3）；
 *  - 元数据（baseUrl/model/contextWindow）非密、同文件明文（doctor/装配读取面）；
 *  - 解密 Key 只在内存流转：main 读出 → credentials:key-push 推宿主（装配注入）——
 *    渲染层/宿主/日志均不持明文（值不打印红线）；
 *  - K6-ME（多端点）：v0.1 单端点槽位 → 多端点列表（一应用多 URL 各配各的模型）。
 *    存储形态 v2 = { version:2, endpoints: [{id, baseUrl, adapterId, models, keyEncrypted}], activeId }。
 *    **save 即激活**（沿用「保存并使用」语义）；宿主装配仍是单 active 端点（key-push 推谁谁生效）。
 *    存量单对象档（v1）读侧惰性迁移为单端点列表；{cleared:true} 墓碑 = 空列表。
 *    纯决策逻辑（归一/upsert/删除迁移/切换）在 credentials-store.ts——node:test 可测。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { safeStorage } from 'electron'
import {
  activateInStore,
  normModels,
  parseStoreFile,
  removeFromStore,
  toMeta,
  upsertEndpoint,
  type EndpointMetaWithId,
  type EndpointWithKey,
  type StoreFile,
} from './credentials-store.ts'

const file = (userDataDir: string): string => path.join(userDataDir, 'credentials.json')

/** 读文件 + 归一（读路径零写盘——首次写操作才落 v2 形态） */
function readStore(userDataDir: string): StoreFile {
  if (!existsSync(file(userDataDir))) return { version: 2, endpoints: [], activeId: null }
  try {
    return parseStoreFile(JSON.parse(readFileSync(file(userDataDir), 'utf8')))
  } catch {
    return { version: 2, endpoints: [], activeId: null }
  }
}

/** 原子写（tmp + 同卷 rename——fileSecurityStore 同款） */
function writeStore(userDataDir: string, store: StoreFile): void {
  mkdirSync(userDataDir, { recursive: true })
  const tmp = file(userDataDir) + '.tmp'
  writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8')
  renameSync(tmp, file(userDataDir))
}

export function saveEndpoint(userDataDir: string, ep: EndpointWithKey): EndpointMetaWithId {
  const models = normModels(ep.models, undefined, undefined)
  if (!models.length) {
    throw new Error('CAR-E-DESKTOP: 自定义端点至少需要一个模型（模型列表为空——Claude Code 式一 URL 多模型）')
  }
  const store = readStore(userDataDir)
  // Key 决策：新 Key 加密落槽；无新 Key 沿用该槽存量（新增槽无存量 = fail-visible）
  let keyEncrypted: string
  if (typeof ep.key === 'string' && ep.key.trim()) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('CAR-E-DESKTOP: safeStorage 不可用（OS keychain 缺席）——拒绝明文落盘（N-D1）；自定义端点保存失败')
    }
    keyEncrypted = safeStorage.encryptString(ep.key.trim()).toString('base64')
  } else if (ep.endpointId) {
    const target = store.endpoints.find((e) => e.id === ep.endpointId)
    if (!target) throw new Error('CAR-E-DESKTOP: 端点槽不存在（已被删除？）——请刷新设置页重试')
    keyEncrypted = target.keyEncrypted
  } else {
    throw new Error('CAR-E-DESKTOP: 新增端点必须提供 API Key（更新已有端点可留空沿用该端点的 Key）')
  }
  const { store: next, saved } = upsertEndpoint(
    store,
    { baseUrl: ep.baseUrl, adapterId: ep.adapterId, ...(ep.endpointId ? { endpointId: ep.endpointId } : {}), models },
    keyEncrypted,
  )
  writeStore(userDataDir, next)
  return toMeta(saved)
}

/** 端点列表（无 Key——设置页列表面；activeId = 当前装配目标） */
export function listEndpoints(userDataDir: string): { endpoints: EndpointMetaWithId[]; activeId: string | null } {
  const store = readStore(userDataDir)
  return { endpoints: store.endpoints.map(toMeta), activeId: store.activeId }
}

/** active 端点元数据（无 Key——doctor/装配读取面；兼容 v0.x 单端点语义） */
export function loadEndpointMeta(userDataDir: string): EndpointMetaWithId | null {
  const store = readStore(userDataDir)
  const active = store.endpoints.find((e) => e.id === store.activeId)
  return active ? toMeta(active) : null
}

/** 解密 Key（内存流转——仅供 credentials:key-push 推宿主装配；禁打印禁落盘）。id 缺省 = active 槽 */
export function revealEndpointKey(userDataDir: string, endpointId?: string): string | null {
  const store = readStore(userDataDir)
  const target = endpointId ? store.endpoints.find((e) => e.id === endpointId) : store.endpoints.find((e) => e.id === store.activeId)
  if (!target) return null
  try {
    return safeStorage.decryptString(Buffer.from(target.keyEncrypted, 'base64'))
  } catch {
    return null // 解密失败（换机/系统凭据变更）——视为未配置，引导重新保存
  }
}

/** 删除端点槽；删 active 时 activeId 自动迁移到剩余第一项（无剩余 = null）。返回删除是否发生 */
export function removeEndpoint(userDataDir: string, endpointId: string): boolean {
  const { store: next, removed } = removeFromStore(readStore(userDataDir), endpointId)
  if (removed) writeStore(userDataDir, next)
  return removed
}

/** 切换 active 端点（装配目标跟随——main 侧推该槽 key-push）。返回切后的 active meta */
export function activateEndpoint(userDataDir: string, endpointId: string): EndpointMetaWithId {
  const { store: next, active } = activateInStore(readStore(userDataDir), endpointId)
  writeStore(userDataDir, next)
  return toMeta(active)
}

/** 清空全部端点（装配回退 car.config llm） */
export function clearEndpoint(userDataDir: string): void {
  if (existsSync(file(userDataDir))) {
    writeStore(userDataDir, { version: 2, endpoints: [], activeId: null })
  }
}
