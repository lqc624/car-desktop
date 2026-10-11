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
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { redact } from '@lqc123qwe/car-runtime'
import type { HostToolDef } from './types.ts'
import type { FileAction, FileSecurityEngine } from './fileSecurity.ts'

/** 读取截断上限（字节）——超限截断并显性标注，禁静默全量进上下文/链 */
export const FS_READ_MAX_BYTES = 256 * 1024

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

export function fsWriteTool(workspaceRoot: string, fileSecurity?: FileSecurityEngine): HostToolDef {
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
      mkdirSync(path.dirname(target), { recursive: true })
      writeFileSync(target, content, 'utf8')
      return { ok: true, path: rawPath, bytes: Buffer.byteLength(content, 'utf8') }
    },
  }
}

export function fsDeleteTool(workspaceRoot: string, fileSecurity?: FileSecurityEngine): HostToolDef {
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
      rmSync(target, st.isDirectory() ? { recursive: true } : {})
      return { ok: true, path: rawPath, ...(st.isDirectory() ? { recursive: true } : {}) }
    },
  }
}

const ACTION_BY_TOOL: Record<string, FileAction> = { fs_read: 'read', fs_write: 'write', fs_delete: 'delete' }

/** 工具名 → 文件动作（authorize 分派用；未知工具不在文件安全面） */
export function fileActionOf(tool: string): FileAction | null {
  return ACTION_BY_TOOL[tool] ?? null
}

/** S3 工具集：三件套（文件安全面）；插件/MCP 工具源 S4 接入位 */
export function builtinTools(workspaceRoot: string, fileSecurity?: FileSecurityEngine): HostToolDef[] {
  return [fsReadTool(workspaceRoot, fileSecurity), fsWriteTool(workspaceRoot, fileSecurity), fsDeleteTool(workspaceRoot, fileSecurity)]
}
