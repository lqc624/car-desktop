/**
 * IPC 契约单一源（立项书 D-S1-2 / S1 规划 D-S1-2）
 *
 * 口径：
 *  - 渲染层 ↔ 宿主的唯一类型源：通道白名单枚举制——新增通道 = 本文件一处登记，
 *    preload 仅映射本契约、main 仅 handle 本契约、host-core 仅 dispatch 本契约；
 *  - 双域可用：本文件同时被 tsconfig.json（NodeNext，显式 .ts 后缀 import）
 *    与 tsconfig.renderer.json（bundler，扩展名省略 import）消费——
 *    故只放类型与常量，零运行时依赖、零 Node API；
 *  - CI 门禁（test/gates.spec.ts）：renderer 域禁 electron/ipcRenderer/require 逃逸。
 */

/** 通道白名单：渲染层可见 IPC 面的穷举枚举 */
export const IpcChannel = {
  /** seam 版本/符号面探测（doctor 展示位） */
  HostProbe: 'host:probe',
  /** 系统目录选择器选工作区并注册（main 侧 dialog，选中后转宿主装载校验；用户取消 = null） */
  WorkspacePick: 'workspace:pick',
  /** 按绝对路径注册工作区（manual 输入/测试通道；装载校验 fail-visible） */
  WorkspaceRegister: 'workspace:register',
  WorkspaceList: 'workspace:list',
  SessionCreate: 'session:create',
  SessionList: 'session:list',
  SessionOpen: 'session:open',
} as const

export type IpcChannelName = (typeof IpcChannel)[keyof typeof IpcChannel]

// ── DTO ──────────────────────────────────────────────────────────────────

/** seam 探测结果（展示性信息——不冻结内核符号清单副本，见 S1 规划 D-S1-6） */
export interface HostProbeResult {
  seamVersion: string
  nodeVersion: string
  symbolCount: number
  /** dist/seam.d.ts 的 export type 计数（尽力展示；不可得 = null） */
  typeCount: number | null
  symbols: string[]
}

export interface WorkspaceInfo {
  /** 绝对路径 SHA-256 前 8 hex——跨重启稳定、同路径幂等 */
  id: string
  name: string
  path: string
  /** 实际装载的配置文件路径；工作区无 car.config.ts/=.json 为正常态（null） */
  configPath: string | null
  /** 非空 = 装载失败（fail-visible；本字段恒 null——失败在注册时即抛错拒绝，登记语义用） */
  configError: string | null
}

export interface SessionInfo {
  sessionId: string
  workspaceId: string
  /** 文件 birthtime（ms） */
  createdAt: number
  /** JSONL 事件行数 */
  eventCount: number
}

export interface SessionOpenResult {
  sessionId: string
  exists: boolean
  eventCount: number
}

/** 各通道请求载荷（宿主 dispatch 校验面） */
export interface IpcRequestMap {
  [IpcChannel.HostProbe]: undefined
  [IpcChannel.WorkspacePick]: undefined
  [IpcChannel.WorkspaceRegister]: { path: string }
  [IpcChannel.WorkspaceList]: undefined
  [IpcChannel.SessionCreate]: { workspaceId: string }
  [IpcChannel.SessionList]: { workspaceId: string }
  [IpcChannel.SessionOpen]: { workspaceId: string; sessionId: string }
}

// ── 渲染层可见 API 面（preload 经 contextBridge 暴露为 window.car） ────────

export interface CarBridge {
  probe(): Promise<HostProbeResult>
  /** 打开系统目录选择器；用户取消返回 null */
  pickAndRegisterWorkspace(): Promise<WorkspaceInfo | null>
  registerWorkspaceByPath(path: string): Promise<WorkspaceInfo>
  listWorkspaces(): Promise<WorkspaceInfo[]>
  createSession(workspaceId: string): Promise<SessionInfo>
  listSessions(workspaceId: string): Promise<SessionInfo[]>
  openSession(workspaceId: string, sessionId: string): Promise<SessionOpenResult>
}
