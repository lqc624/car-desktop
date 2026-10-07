/**
 * S2 内置工具面（立项书偏差 D-S2-2：授权门验证载体）
 *
 * 口径：正式插件/MCP 工具源在 S4；S2 提供最小 fs_write（declaredSideEffect:'write'）
 * 验证授权门全语义与工具回环——授权路径与插件工具完全一致（T-22：声明面=授权面）。
 * 沙盒约束：目标路径 resolve 后必须位于工作区根内（路径穿越 fail-visible 拒绝，
 * 授权门拒绝语义不因工具自身校验弱化）。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { HostToolDef } from './types.ts'

export function fsWriteTool(workspaceRoot: string): HostToolDef {
  return {
    name: 'fs_write',
    declaredSideEffect: 'write',
    description: '在工作区内写文件。参数：path（工作区内相对或绝对路径）、content（文本内容）。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目标文件路径（必须位于工作区内）' },
        content: { type: 'string', description: '要写入的文本内容' },
      },
      required: ['path', 'content'],
    },
    run: async (args) => {
      const rawPath = args['path']
      const content = args['content']
      if (typeof rawPath !== 'string' || rawPath.length === 0) {
        throw new Error('CAR-E-DESKTOP: fs_write 缺少 path（string）')
      }
      if (typeof content !== 'string') {
        throw new Error('CAR-E-DESKTOP: fs_write 缺少 content（string）')
      }
      const root = path.resolve(workspaceRoot)
      const target = path.resolve(root, rawPath)
      const rel = path.relative(root, target)
      if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
        // fail-visible：路径穿越拒绝（../、绝对路径逃逸、根本身）
        throw new Error(`CAR-E-DESKTOP: fs_write 目标越界（${rawPath}）——仅允许工作区内路径`)
      }
      mkdirSync(path.dirname(target), { recursive: true })
      writeFileSync(target, content, 'utf8')
      return { ok: true, path: rel, bytes: Buffer.byteLength(content, 'utf8') }
    },
  }
}

/** S2 工具集：仅内置 fs_write（插件/MCP 面 S4 接入位） */
export function builtinTools(workspaceRoot: string): HostToolDef[] {
  return [fsWriteTool(workspaceRoot)]
}
