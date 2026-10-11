/**
 * S3-S3 · 自动备份存储（安全中心设计 §4；Q-SC-2：默认开启 + 2000MB + LRU）
 *
 * 口径：
 *  - **先保后变（fail-visible）**：backupBefore 在变更（覆盖写/删除）之前调用；备份失败（IO/
 *    配额不可淘汰）= throw → 工具 run 中断 → 变更不落盘——与「先落日志后放行」同构的先保后变；
 *  - 布局 = `<userData>/backups/<workspaceId>/<sessionId>/op-<ts>-<seq>/<工作区相对路径>`；
 *    工作区外目标按净化绝对路径展平存放；目录删除 = 整树拷贝（cpSync recursive）；
 *  - **备份区在 userData 拒绝×3 预设内**（R-SC-3 安全闭环）——被拒路径的内容不可经备份区读回；
 *  - 配额 = backups 根总大小 ≤ maxTotalBytes；超限按 op 目录 mtime **LRU 淘汰**（整目录删除），
 *    淘汰后仍不足（单次备份超过上限）→ throw（禁止挤掉全部历史仍塞入）；
 *  - 留痕：工具结果带 `backup: { path, bytes }`（payload 加法，EventKind 冻结面零新增）——
 *    审计链可回答「变更前的原件在哪」。
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'

export interface BackupRecord {
  /** 备份件位置（绝对路径——恢复 = 打开备份目录手动取回，v0.1 无自动恢复） */
  path: string
  bytes: number
}

export interface BackupContext {
  workspaceId: string
  sessionId: string
}

export interface BackupStore {
  /**
   * 变更前备份：目标存在 → 拷贝并返回 BackupRecord；目标不存在（新建写）或开关关闭 → null；
   * 失败 fail-visible throw（调用方 run 随之中断——变更不落盘）。
   */
  backupBefore(target: string, workspaceRoot: string, ctx: BackupContext): BackupRecord | null
  root(): string
}

export function createBackupStore(
  userDataDir: string,
  config: () => { enabled: boolean; maxTotalBytes: number },
): BackupStore {
  const root = path.join(userDataDir, 'backups')
  let opSeq = 0
  let totalBytes: number | null = null // 惰性聚合（进程内增量维护；跨启动首用重算）

  const sizeOfTree = (p: string): number => {
    const st = statSync(p)
    if (!st.isDirectory()) return st.size
    let sum = 0
    for (const name of readdirSync(p)) sum += sizeOfTree(path.join(p, name))
    return sum
  }
  const totalInUse = (): number => {
    if (totalBytes === null) totalBytes = existsSync(root) ? sizeOfTree(root) : 0
    return totalBytes
  }
  /** LRU 淘汰：op 目录按 mtime 升序整目录删除，直到 total + needed ≤ max；仍不足 = fail */
  const ensureCapacity = (needed: number, max: number): void => {
    if (totalInUse() + needed <= max) return
    const ops: Array<{ dir: string; mtime: number }> = []
    if (existsSync(root)) {
      for (const wsId of readdirSync(root)) {
        const wsDir = path.join(root, wsId)
        for (const sessId of readdirSync(wsDir)) {
          const sessDir = path.join(wsDir, sessId)
          for (const op of readdirSync(sessDir)) {
            const dir = path.join(sessDir, op)
            ops.push({ dir, mtime: statSync(dir).mtimeMs })
          }
        }
      }
    }
    ops.sort((a, b) => a.mtime - b.mtime)
    for (const op of ops) {
      if (totalInUse() + needed <= max) break
      const sz = sizeOfTree(op.dir)
      rmSync(op.dir, { recursive: true, force: true })
      totalBytes = (totalBytes ?? 0) - sz
    }
    if (totalInUse() + needed > max) {
      throw new Error(`CAR-E-DESKTOP: 备份配额不足（needed ${needed}B > 上限 ${max}B，LRU 淘汰后仍不足）——变更不落盘（先保后变）`)
    }
  }

  return {
    backupBefore(target, workspaceRoot, ctx) {
      const { enabled, maxTotalBytes } = config()
      if (!enabled) return null
      let st
      try {
        st = statSync(target)
      } catch {
        return null // 目标不存在（新建写）——无可保留原件
      }
      const needed = sizeOfTree(target)
      ensureCapacity(needed, maxTotalBytes)
      const opDir = path.join(root, ctx.workspaceId, ctx.sessionId, `op-${Date.now().toString(36)}-${++opSeq}`)
      const rel = path.relative(workspaceRoot, target)
      const inside = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
      // 工作区内保留相对结构；工作区外按净化绝对路径展平（盘符冒号与分隔符替换）
      const destRel = inside
        ? rel
        : target.replace(/^[a-zA-Z]:/, '').replace(/[\\/]/g, '_').replace(/^_+/, '')
      const dest = path.join(opDir, destRel)
      mkdirSync(path.dirname(dest), { recursive: true })
      try {
        if (st.isDirectory()) cpSync(target, dest, { recursive: true })
        else copyFileSync(target, dest)
      } catch (err) {
        rmSync(opDir, { recursive: true, force: true }) // 半态清理——备份失败不留残件
        throw new Error(`CAR-E-DESKTOP: 备份失败（${err instanceof Error ? err.message : err}）——变更不落盘（先保后变）`)
      }
      const bytes = sizeOfTree(dest)
      totalBytes = (totalBytes ?? 0) + bytes
      return { path: dest, bytes }
    },
    root: () => root,
  }
}
