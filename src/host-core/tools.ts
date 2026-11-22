/**
 * S3-S2 内置工具面（桌面端文件安全设计 §4；S2 D-S2-2 载体升级为三件套）
 *
 * 口径：
 *  - 三动作 ↔ 三工具：读取=fs_read（declaredSideEffect:'readonly'）、写入=fs_write、删除=fs_delete
 *    （'write'——删除是变更面；内核 SideEffect 枚举零改动，K-FS-1 authorizeAll 使读取规则可达）；
 *  - **执行面硬校验兜底（R-FS-3，T-22 纪律延伸）**：deny 规则命中 / 未命中-工作区外两种硬拒情形在
 *    run 起点重验（引擎纯函数重算，幂等零成本）——授权面（authorize）与执行面（run）双保险；
 *    引擎缺席时退回工作区词法校验（S2 语义，非生产装配路径）；
 *  - fs_read：文本读取，256KB 截断 + 二进制探测 fail-visible；**结果过内核 redact() 再落链**
 *    （K-FS-4——JSONL 不可变链上不得进密钥原文，命中仅记 redactedCount）；
 *  - fs_delete：文件删除默认；目录需显式 recursive:true（fail-visible）——非空目录未带该参数拒绝。
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { redact } from '@lqc123qwe/car-runtime'
import type { HostToolDef } from './types.ts'
import type { FileAction, FileSecurityEngine } from './fileSecurity.ts'
import type { BackupContext, BackupStore } from './backupStore.ts'

/** 读取截断上限（字节）——超限截断并显性标注，禁静默全量进上下文/链 */
export const FS_READ_MAX_BYTES = 256 * 1024

/** 备份接线面（S3-S3）：store + 会话上下文——SessionHandle 装配时注入 */
export interface BackupWiring {
  store: BackupStore
  ctx: BackupContext
}

/** 先保后变（S3-S3）：变更（覆盖写/删除）前备份；返回 null = 无可保留原件/开关关闭 */
function backupBefore(backup: BackupWiring | undefined, target: string, workspaceRoot: string): { path: string; bytes: number } | null {
  if (!backup) return null
  const rec = backup.store.backupBefore(target, workspaceRoot, backup.ctx)
  return rec ? { path: rec.path, bytes: rec.bytes } : null
}

function requirePath(args: Record<string, unknown>, tool: string): string {
  const raw = args['path']
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error(`CAR-E-DESKTOP: ${tool} 缺少 path（string）`)
  }
  return raw
}

export function fsReadTool(workspaceRoot: string, fileSecurity?: FileSecurityEngine): HostToolDef {
  return {
    name: 'fs_read',
    declaredSideEffect: 'readonly',
    description: '读取文本文件（256KB 截断；二进制文件拒读）。参数：path（工作区内相对或绝对路径）。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '目标文件路径' } },
      required: ['path'],
    },
    run: async (args) => {
      const rawPath = requirePath(args, 'fs_read')
      if (fileSecurity) {
        const msg = fileSecurity.hardReject('read', rawPath, workspaceRoot)
        if (msg) throw new Error(msg)
      } else {
        // 引擎缺席（非生产装配路径）：退回工作区词法校验
        const target = path.resolve(workspaceRoot, rawPath)
        const rel = path.relative(path.resolve(workspaceRoot), target)
        if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`CAR-E-DESKTOP: fs_read 目标越界（${rawPath}）`)
      }
      const target = path.isAbsolute(rawPath) ? rawPath : path.resolve(workspaceRoot, rawPath)
      const st = statSync(target) // 不存在 → ENOENT 成对交回模型（工具错误是结果）
      if (st.isDirectory()) throw new Error(`CAR-E-DESKTOP: fs_read 目标是目录（${rawPath}）——仅支持文件读取`)
      const buf = readFileSync(target)
      if (buf.subarray(0, 8192).includes(0)) {
        throw new Error(`CAR-E-DESKTOP: fs_read 目标疑似二进制文件（${rawPath}）——拒读（文本面 only）`)
      }
      const truncated = buf.length > FS_READ_MAX_BYTES
      const text = buf.subarray(0, FS_READ_MAX_BYTES).toString('utf8')
      // 落链前脱敏（K-FS-4）：redact 幂等；命中仅记数——链上不进密钥原文
      const r = redact(text)
      return {
        path: rawPath,
        bytes: Buffer.byteLength(r.redacted, 'utf8'),
        totalBytes: buf.length,
        ...(truncated ? { truncated: true, note: `内容超 ${FS_READ_MAX_BYTES} 字节已截断` } : {}),
        redactedCount: r.redactedCount,
        content: r.redacted,
      }
    },
  }
}

export function fsWriteTool(workspaceRoot: string, fileSecurity?: FileSecurityEngine, backup?: BackupWiring): HostToolDef {
  return {
    name: 'fs_write',
    declaredSideEffect: 'write',
    description: '在工作区内写文件。参数：path（工作区内相对或绝对路径）、content（文本内容）。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目标文件路径' },
        content: { type: 'string', description: '要写入的文本内容' },
      },
      required: ['path', 'content'],
    },
    run: async (args) => {
      const rawPath = requirePath(args, 'fs_write')
      const content = args['content']
      if (typeof content !== 'string') {
        throw new Error('CAR-E-DESKTOP: fs_write 缺少 content（string）')
      }
      if (fileSecurity) {
        const msg = fileSecurity.hardReject('write', rawPath, workspaceRoot)
        if (msg) throw new Error(msg)
      } else {
        const target = path.resolve(workspaceRoot, rawPath)
        const rel = path.relative(path.resolve(workspaceRoot), target)
        if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
          throw new Error(`CAR-E-DESKTOP: fs_write 目标越界（${rawPath}）——仅允许工作区内路径`)
        }
      }
      const target = path.isAbsolute(rawPath) ? rawPath : path.resolve(workspaceRoot, rawPath)
      // 先保后变（S3-S3）：覆盖已存在目标前备份——备份失败 throw 即变更不落盘
      const backupRec = backupBefore(backup, target, workspaceRoot)
      mkdirSync(path.dirname(target), { recursive: true })
      writeFileSync(target, content, 'utf8')
      // C6（LF-3 案 B 主）：回执自含指纹（写入时 content 已在内存，一次 hash——toolResult 落链自动
      // 携带；链盘对账免重放。老链无此键 = 对账走案 A 链直推重放，见 reconciliation.ts）
      const sha256 = createHash('sha256').update(content, 'utf8').digest('hex')
      return { ok: true, path: rawPath, bytes: Buffer.byteLength(content, 'utf8'), sha256, ...(backupRec ? { backup: backupRec } : {}) }
    },
  }
}

export function fsDeleteTool(workspaceRoot: string, fileSecurity?: FileSecurityEngine, backup?: BackupWiring): HostToolDef {
  return {
    name: 'fs_delete',
    declaredSideEffect: 'write',
    description: '删除文件；目录需显式 recursive:true。参数：path、recursive?（布尔，仅目录删除需要）。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目标路径' },
        recursive: { type: 'boolean', description: '目录删除必须显式 true' },
      },
      required: ['path'],
    },
    run: async (args) => {
      const rawPath = requirePath(args, 'fs_delete')
      const recursive = args['recursive'] === true
      if (fileSecurity) {
        const msg = fileSecurity.hardReject('delete', rawPath, workspaceRoot)
        if (msg) throw new Error(msg)
      } else {
        const target = path.resolve(workspaceRoot, rawPath)
        const rel = path.relative(path.resolve(workspaceRoot), target)
        if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
          throw new Error(`CAR-E-DESKTOP: fs_delete 目标越界（${rawPath}）`)
        }
      }
      const target = path.isAbsolute(rawPath) ? rawPath : path.resolve(workspaceRoot, rawPath)
      const st = statSync(target) // 不存在 → ENOENT 成对交回模型
      if (st.isDirectory() && !recursive) {
        throw new Error(`CAR-E-DESKTOP: fs_delete 目标是目录（${rawPath}）——目录删除必须显式 recursive:true`)
      }
      // 先保后变（S3-S3）：删除前备份（文件单件 / 目录整树）——失败 throw 即不删
      const backupRec = backupBefore(backup, target, workspaceRoot)
      // C6（LF-3）：被删件指纹（文件形态删前现读 hash——对账「已删除」行的链上锚点；读失败 = 不带键禁伪造）
      let deletedSha256: string | undefined
      let deletedBytes: number | undefined
      if (!st.isDirectory()) {
        try {
          const raw = readFileSync(target)
          deletedSha256 = createHash('sha256').update(raw).digest('hex')
          deletedBytes = raw.length
        } catch { /* 删前读失败 = 指纹缺席（对账面该行只陈述删除事实） */ }
      }
      rmSync(target, st.isDirectory() ? { recursive: true } : {})
      return {
        ok: true,
        path: rawPath,
        ...(st.isDirectory() ? { recursive: true } : {}),
        ...(deletedSha256 ? { deletedSha256, deletedBytes } : {}),
        ...(backupRec ? { backup: backupRec } : {}),
      }
    },
  }
}

const ACTION_BY_TOOL: Record<string, FileAction> = { fs_read: 'read', fs_write: 'write', fs_delete: 'delete' }

/** 工具名 → 文件动作（authorize 分派用；未知工具不在文件安全面） */
export function fileActionOf(tool: string): FileAction | null {
  return ACTION_BY_TOOL[tool] ?? null
}

/** S3 工具集：三件套（文件安全面 + 自动备份接线）；插件/MCP 工具源 S4 接入位 */
export function builtinTools(workspaceRoot: string, fileSecurity?: FileSecurityEngine, backup?: BackupWiring, viewerStateDir?: string): HostToolDef[] {
  const tools = [fsReadTool(workspaceRoot, fileSecurity), fsWriteTool(workspaceRoot, fileSecurity, backup), fsDeleteTool(workspaceRoot, fileSecurity, backup)]
  if (viewerStateDir) tools.push(fileviewerGetViewTool(viewerStateDir))
  return tools
}

/**
 * Z-7 反向感知（0.12.0 / D-V12-2）：FileViewer 态读面——用户正在看的文件 + 选区 + 滚动位置。
 * 数据流 = 渲染层上报 → main 持态原子写 userData/viewer-state.json → 本工具读（文件交接形态，
 * host=utilityProcess 不能直调 main 的架构约束下 browser-target.json 同款）。
 * 缺文件/坏 JSON = `{ viewOpen: false }` 正常态降级（main 是唯一写者，半态由下次上报自愈——
 * 读面非写面，禁 fail-visible 误伤指代消解）；selectionText 过内核 redact（fs_read 同纪律——
 * 文件内容可能含密钥，链上/返回面只进脱敏形态）。
 */
export function fileviewerGetViewTool(userDataDir: string): HostToolDef {
  return {
    name: 'fileviewer_get_view',
    declaredSideEffect: 'readonly',
    description:
      '读取用户当前在文件查看器中打开的文件、可视滚动位置与选区文本（指代消解——「这个文件这里」）。' +
      '无查看器打开时返回 viewOpen:false。参数：无。',
    parameters: { type: 'object', properties: {} },
    run: async () => {
      const file = path.join(userDataDir, 'viewer-state.json')
      let raw: string | null = null
      try {
        raw = readFileSync(file, 'utf8')
      } catch {
        return { viewOpen: false } // 缺文件 = 无查看器态（正常态非错误）
      }
      let state: Record<string, unknown>
      try {
        state = JSON.parse(raw) as Record<string, unknown>
      } catch {
        return { viewOpen: false, note: 'viewer-state 坏 JSON 降级（main 唯一写者——下次上报自愈）' }
      }
      const out: Record<string, unknown> = { viewOpen: state['viewOpen'] === true }
      if (typeof state['path'] === 'string') out['path'] = state['path']
      if (typeof state['scrollPercent'] === 'number') out['scrollPercent'] = state['scrollPercent']
      if (typeof state['selectionText'] === 'string' && state['selectionText'].length) {
        const r = redact(state['selectionText'])
        out['selectionText'] = r.redacted
        out['selectionChars'] = state['selectionChars'] ?? r.redacted.length
        if (r.redactedCount > 0) out['redactedCount'] = r.redactedCount
      }
      if (typeof state['updatedAt'] === 'number') out['updatedAt'] = state['updatedAt']
      return out
    },
  }
}
