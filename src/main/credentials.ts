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

export interface EndpointMeta {
  baseUrl: string
  model: string
  contextWindow: number | null
  /** K5-D（V2）：适配器族声明（openai-compat | anthropic）；读侧缺省 openai-compat（存量档兼容） */
  adapterId: 'openai-compat' | 'anthropic'
}
export interface EndpointWithKey extends EndpointMeta {
  key: string
}

interface Stored extends EndpointMeta {
  keyEncrypted: string
}

const file = (userDataDir: string): string => path.join(userDataDir, 'credentials.json')

const normAdapter = (v: unknown): 'openai-compat' | 'anthropic' => (v === 'anthropic' ? 'anthropic' : 'openai-compat')

function readStored(userDataDir: string): Stored | null {
  if (!existsSync(file(userDataDir))) return null
  try {
    const p = JSON.parse(readFileSync(file(userDataDir), 'utf8')) as Partial<Stored>
    if (typeof p.baseUrl !== 'string' || typeof p.model !== 'string' || typeof p.keyEncrypted !== 'string') return null
    return {
      baseUrl: p.baseUrl,
      model: p.model,
      contextWindow: typeof p.contextWindow === 'number' ? p.contextWindow : null,
      adapterId: normAdapter(p.adapterId),
      keyEncrypted: p.keyEncrypted,
    }
  } catch {
    return null
  }
}

export function saveEndpoint(userDataDir: string, ep: EndpointWithKey): EndpointMeta {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('CAR-E-DESKTOP: safeStorage 不可用（OS keychain 缺席）——拒绝明文落盘（N-D1）；自定义端点保存失败')
  }
  const keyEncrypted = safeStorage.encryptString(ep.key).toString('base64')
  mkdirSync(userDataDir, { recursive: true })
  const stored: Stored = {
    baseUrl: ep.baseUrl,
    model: ep.model,
    contextWindow: ep.contextWindow ?? null,
    adapterId: normAdapter(ep.adapterId),
    keyEncrypted,
  }
  const tmp = file(userDataDir) + '.tmp'
  writeFileSync(tmp, JSON.stringify(stored, null, 2), 'utf8')
  // 原子替换（同卷 rename——fileSecurityStore 同款）
  renameSync(tmp, file(userDataDir))
  return { baseUrl: ep.baseUrl, model: ep.model, contextWindow: ep.contextWindow ?? null, adapterId: normAdapter(ep.adapterId) }
}

/** 端点元数据（无 Key——doctor/装配读取面） */
export function loadEndpointMeta(userDataDir: string): EndpointMeta | null {
  const s = readStored(userDataDir)
  return s ? { baseUrl: s.baseUrl, model: s.model, contextWindow: s.contextWindow, adapterId: s.adapterId } : null
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
