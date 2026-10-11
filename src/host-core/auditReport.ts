/**
 * S3-S4 · 审计报告与取证包导出（桌面端立项书 F-D2/VD3；链校验单一权威在内核——D-S3-6）
 *
 * 口径：
 *  - 审计报告 = 载入面（内核 loadSessionLog，seam 1.13.0）读 JSONL → 事件全集 +
 *    verifyChain 状态（intact / brokenAt 断链定位）+ 撕裂尾/编码——桌面只做可视化，禁自实现
 *    哈希重算（双实现必漂移）；
 *  - 取证导出 = 内核 exportForensicsBundle（**断链即中止**——禁止带病审计包外流）→ 写
 *    `<userData>/exports/<sessionId>-<ts>/` → **读回重验三重**：逐文件 SHA-256 对拍（verifyBundle）
 *    + 载入面重读 events.jsonl 链校验 + manifest 事件数对拍；
 *  - exportedBy = 本机 OS 用户（谁导出——审计元数据）；runtimeVersion = seam 探测值。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  exportForensicsBundle,
  loadSessionLog,
  verifyBundle,
  type ExportMeta,
} from '@lqc123qwe/car-runtime'
import { assertSafeId, sessionsDirFor } from './sessions.ts'
import { probeSeam } from './probe.ts'
import type { AuditExportResult, AuditReport } from '../shared/ipc-contract.ts'

function sessionFile(workspaceRoot: string, sessionId: string): string {
  assertSafeId('会话', sessionId)
  const file = path.join(sessionsDirFor(workspaceRoot), sessionId + '.jsonl')
  if (!existsSync(file)) throw new Error(`CAR-E-DESKTOP: 会话不存在（${sessionId}）`)
  return file
}

/** 审计报告：事件全集 + 链校验状态（断链定位到 brokenSeq——审计页可视化数据源） */
export function sessionAuditReport(workspaceRoot: string, sessionId: string): AuditReport {
  const file = sessionFile(workspaceRoot, sessionId)
  const loaded = loadSessionLog(file)
  return {
    sessionId,
    eventCount: loaded.log.events.length,
    events: [...loaded.log.events],
    chain: { intact: loaded.brokenAt === null, brokenAt: loaded.brokenAt },
    tornTail: loaded.tornTail,
    encoding: loaded.encoding,
  }
}

/** 取证包导出：断链即中止（内核单点）→ 落盘 → 读回重验（三重） */
export function exportSessionForensics(workspaceRoot: string, sessionId: string, userDataDir: string): AuditExportResult {
  const file = sessionFile(workspaceRoot, sessionId)
  const loaded = loadSessionLog(file)
  if (loaded.brokenAt !== null) {
    throw new Error(`CAR-E-DESKTOP: 会话哈希链断裂（brokenAt seq=${loaded.brokenAt}）——中止导出（禁止带病审计包外流）`)
  }
  const meta: ExportMeta = {
    sessionId,
    exportedBy: process.env['USERNAME'] ?? process.env['USER'] ?? 'desktop',
    exportedAt: new Date().toISOString(),
    runtimeVersion: probeSeam().seamVersion,
    sessionRange: { fromSeq: 0, toSeq: loaded.log.events.length - 1 },
  }
  const bundle = exportForensicsBundle(loaded.log, meta) // 断链再验（内核单点语义）
  const dir = path.join(userDataDir, 'exports', `${sessionId}-${Date.now().toString(36)}`)
  for (const f of bundle.files) {
    const dest = path.join(dir, f.name)
    mkdirSync(path.dirname(dest), { recursive: true })
    writeFileSync(dest, f.content, 'utf8')
  }
  // 读回重验①：逐文件字节读回 → SHA-256/manifest 对拍
  const reread = bundle.files.map((f) => ({ name: f.name, content: readFileSync(path.join(dir, f.name), 'utf8'), sha256: f.sha256 }))
  const verify = verifyBundle({ files: reread, manifest: bundle.manifest })
  // 读回重验②：载入面重读导出的 events.jsonl → 链校验
  const eventsFileName = bundle.files.find((f) => f.name.endsWith('events.jsonl'))!.name
  const reloaded = loadSessionLog(path.join(dir, eventsFileName))
  if (reloaded.brokenAt !== null) {
    throw new Error(`CAR-E-DESKTOP: 导出件读回链校验失败（brokenAt seq=${reloaded.brokenAt}）——导出目录已隔离（${dir}）`)
  }
  // 读回重验③：manifest 事件数对拍
  if (reloaded.log.events.length !== bundle.manifest.eventCount) {
    throw new Error('CAR-E-DESKTOP: 导出件事件数与 manifest 不符——导出目录已隔离')
  }
  return {
    ok: verify.ok,
    dir,
    files: bundle.files.map((f) => f.name),
    eventCount: bundle.manifest.eventCount,
    verify: { ok: verify.ok, brokenFile: verify.brokenFile },
    chainIntact: true,
  }
}
