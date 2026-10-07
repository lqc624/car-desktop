/**
 * seam 探测面（宿主核心；零 Electron import——S1 规划 D-S1-1）
 *
 * 口径（S1 规划 D-S1-6）：probe 输出为展示性信息（版本 + 符号/类型计数），
 * 不冻结内核符号清单副本——清单冻结属内核 s44 职责，桌面复冻会在内核 minor
 * 加法时制造跨仓假红。本模块只断言「自己消费的符号存在」（调用点核验），
 * 不断言上游导出面全量（契约面不归桌面管）。
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import * as seam from '@lqc123qwe/car-runtime'
import type { HostProbeResult } from '../shared/ipc-contract.ts'

const require = createRequire(import.meta.url)

/** 宿主核心实际消费的 seam 符号（调用点核验——缺任一即 probe 失败） */
export const CONSUMED_SEAM_SYMBOLS = ['SessionLog', 'SessionFileStore', 'loadCarConfig', 'warmCarConfig'] as const

export function probeSeam(): HostProbeResult {
  for (const name of CONSUMED_SEAM_SYMBOLS) {
    if (!(name in seam)) {
      throw new Error(`CAR-E-DESKTOP: seam 缺少宿主消费符号 ${name}（内核包版本与桌面壳不兼容）`)
    }
  }
  const pkgPath = require.resolve('@lqc123qwe/car-runtime/package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string }
  let typeCount: number | null = null
  try {
    // exports map 只出 package.json/dist——d.ts 按包根拼路径，不可得即 null（展示位不致命）
    const dtsPath = join(pkgPath, '..', 'dist', 'seam.d.ts')
    const dts = readFileSync(dtsPath, 'utf8')
    typeCount = (dts.match(/export type /g) ?? []).length
  } catch {
    typeCount = null
  }
  const symbols = Object.keys(seam)
  return {
    seamVersion: pkg.version ?? 'unknown',
    nodeVersion: process.versions.node,
    symbolCount: symbols.length,
    typeCount,
    symbols,
  }
}
