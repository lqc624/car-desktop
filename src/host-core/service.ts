/**
 * 宿主服务装配（宿主核心门面；零 Electron import——S1 规划 D-S1-1）
 *
 * 分层口径：本模块及其子模块（probe/workspaces/sessions）在 node:test 直测
 * （本机 Node / CI 22.19），Electron 胶水（utilityProcess / main / preload）收敛为
 * 薄壳——宿主核心不动即可整体迁移（R-D3 降级路径干净）。
 * dispatch 通道校验 = 契约白名单 + 载荷形状逐通道 fail-visible。
 */
import {
  IpcChannel,
  type HostProbeResult,
  type SessionInfo,
  type SessionOpenResult,
  type WorkspaceInfo,
} from '../shared/ipc-contract.ts'
import { probeSeam } from './probe.ts'
import { WorkspaceRegistry } from './workspaces.ts'
import { SessionManager } from './sessions.ts'

export interface HostServiceOptions {
  /** 桌面 = app.getPath('userData')；测试 = 注入临时目录（D-S1-4） */
  userDataDir: string
}

export interface HostService {
  dispatch(channel: string, payload: unknown): Promise<unknown>
}

export function createHostService(opts: HostServiceOptions): HostService {
  const registry = new WorkspaceRegistry(opts.userDataDir)
  const sessions = new SessionManager()

  const requireString = (v: unknown, label: string): string => {
    if (typeof v !== 'string' || v.length === 0) {
      throw new Error(`CAR-E-DESKTOP: 载荷缺少 ${label}（string）`)
    }
    return v
  }

  async function dispatch(channel: string, payload: unknown): Promise<unknown> {
    const p = (payload ?? {}) as Record<string, unknown>
    switch (channel) {
      case IpcChannel.HostProbe: {
        const probe = probeSeam()
        return probe satisfies HostProbeResult
      }
      case IpcChannel.WorkspaceRegister: {
        const info = await registry.register(requireString(p.path, 'path'))
        return info satisfies WorkspaceInfo
      }
      case IpcChannel.WorkspaceList:
        return registry.list()
      case IpcChannel.SessionCreate: {
        const workspaceId = requireString(p.workspaceId, 'workspaceId')
        const info = sessions.create(registry.pathOf(workspaceId), workspaceId)
        return info satisfies SessionInfo
      }
      case IpcChannel.SessionList: {
        const workspaceId = requireString(p.workspaceId, 'workspaceId')
        return sessions.list(registry.pathOf(workspaceId), workspaceId)
      }
      case IpcChannel.SessionOpen: {
        const workspaceId = requireString(p.workspaceId, 'workspaceId')
        const sessionId = requireString(p.sessionId, 'sessionId')
        const result = sessions.open(registry.pathOf(workspaceId), sessionId)
        return result satisfies SessionOpenResult
      }
      default:
        throw new Error(`CAR-E-DESKTOP: 未知 IPC 通道（${channel}）——契约面见 src/shared/ipc-contract.ts`)
    }
  }

  return { dispatch }
}
