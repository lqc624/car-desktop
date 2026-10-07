/**
 * 工作区注册（宿主核心；零 Electron import）
 *
 * 口径（立项书 R-D7 + S1 规划 D-S1-4）：
 *  - 工作区 = 本地文件夹 + car.config.ts 双端共享；注册即装载校验，坏 config
 *    fail-visible 拒绝注册（禁「注册成功但配置不生效」的漂移面）；
 *  - 无配置文件为正常态（内核 ConfigLoadResult 语义：未发现非错误）；
 *  - 索引落 userDataDir/workspaces.json——只登记路径与展示名，不含凭据；
 *    测试以注入 userDataDir 替代默认路径（lesson-deterministic-test-premises）；
 *  - 内核配置装载契约：car.config.ts 须先 warmCarConfig 异步预热再 loadCarConfig
 *    同步装载（cli.ts 生产调用点同款；未预热 = CAR-E-CONFIG fail-visible）。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { loadCarConfig, warmCarConfig } from '@lqc123qwe/car-runtime'
import type { WorkspaceInfo } from '../shared/ipc-contract.ts'

interface WorkspacesIndexFile {
  workspaces: WorkspaceInfo[]
}

export class WorkspaceRegistry {
  constructor(private readonly userDataDir: string) {}

  async register(rawPath: string): Promise<WorkspaceInfo> {
    if (!isAbsolute(rawPath)) {
      throw new Error(`CAR-E-DESKTOP: 工作区路径必须是绝对路径（收到：${rawPath}）`)
    }
    const root = resolve(rawPath)
    if (!existsSync(root) || !statSync(root).isDirectory()) {
      throw new Error(`CAR-E-DESKTOP: 工作区目录不存在或非目录（${root}）`)
    }
    await warmCarConfig({ cwd: root })
    const loaded = loadCarConfig({ cwd: root })
    if (loaded.error) {
      // fail-visible：坏配置拒绝注册，错误原文上抛（zod issues 由内核渲染为「路径 原因」）
      throw new Error(loaded.error)
    }
    const id = workspaceIdFor(root)
    const info: WorkspaceInfo = {
      id,
      name: basename(root) || root,
      path: root,
      configPath: loaded.path ?? null,
      configError: null,
    }
    const idx = this.readIndex()
    const existing = idx.workspaces.findIndex((w) => w.path === root)
    if (existing >= 0) idx.workspaces[existing] = info
    else idx.workspaces.push(info)
    this.writeIndex(idx)
    return info
  }

  list(): WorkspaceInfo[] {
    return this.readIndex().workspaces
  }

  /** id → 根目录解析；未知 id fail-visible */
  pathOf(workspaceId: string): string {
    const w = this.list().find((x) => x.id === workspaceId)
    if (!w) throw new Error(`CAR-E-DESKTOP: 未知工作区（${workspaceId}）`)
    return w.path
  }

  private readIndex(): WorkspacesIndexFile {
    const p = join(this.userDataDir, 'workspaces.json')
    if (!existsSync(p)) return { workspaces: [] }
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as WorkspacesIndexFile
    return { workspaces: Array.isArray(parsed.workspaces) ? parsed.workspaces : [] }
  }

  private writeIndex(idx: WorkspacesIndexFile): void {
    mkdirSync(this.userDataDir, { recursive: true })
    writeFileSync(join(this.userDataDir, 'workspaces.json'), JSON.stringify(idx, null, 2), 'utf8')
  }
}

export function workspaceIdFor(absPath: string): string {
  return createHash('sha256').update(absPath).digest('hex').slice(0, 8)
}
