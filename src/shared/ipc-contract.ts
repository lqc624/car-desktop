/**
 * IPC 契约单一源（立项书 D-S1-2 / S1 规划 D-S1-2；S2 扩展：turn 链路 + 授权门 + 推送面）
 *
 * 口径：
 *  - 渲染层 ↔ 宿主的唯一类型源：通道白名单枚举制——新增通道 = 本文件一处登记，
 *    preload 仅映射本契约、main 仅 handle 本契约、host-core 仅 dispatch 本契约；
 *  - S2 新增宿主→渲染**推送面**（IpcPushTopic）：会话事件流（attachSink tap，与 JSONL
 *    同源同序——D-S2-1）+ 授权 pending/resolved；推送载荷由 main 经 webContents.send
 *    转发，preload 以订阅回调暴露（ipcRenderer 唯一持有者纪律不变）；
 *  - 双域可用：本文件被 tsconfig.json（NodeNext）与 tsconfig.renderer.json（bundler）
 *    同时消费——只放类型与常量，零运行时依赖、零 Node API；
 *  - SessionEventDTO 为内核 SessionEvent 结构镜像（1.12 实查）：推送载荷 = 落盘行
 *    JSON.parse 产物（零手抄漂移——事实本体在 JSONL）。
 */

/** 请求/响应通道白名单（renderer invoke → main → 宿主 dispatch） */
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
  /** 打开会话 = 常驻句柄 + 全量回放（R-4：回放一次批量，增量走推送） */
  SessionOpen: 'session:open',
  // —— S2：turn 链路 / 授权门 / 会话管理 ——
  /** 发送消息开 turn（立即返回 turnId；事件经推送面流式到达） */
  TurnSend: 'turn:send',
  /** 中断在途 turn（内核 abort 收口 + 未派发调用补记成对事件） */
  TurnAbort: 'turn:abort',
  /** 授权门响应（once = 批准本次 / session = 会话内始终允许 / deny = 拒绝） */
  AuthzRespond: 'authz:respond',
  /** 会话用量聚合（usage 事件真实值，禁估算——D-S2-4） */
  SessionUsage: 'session:usage',
  /** 会话重命名（rename 事件落链留痕） */
  SessionRename: 'session:rename',
  /** 会话删除（delete 事件落链留痕；JSONL 文件保留不销毁——审计红线） */
  SessionDelete: 'session:delete',
  /** 会话级模型切换（model/set 事件落链——D-S2-3） */
  SessionSetModel: 'session:set-model',
  // —— S3：文件安全设置面（SEC_SETTINGS；host 持久化 + 校验，渲染层接线 S3-S6） ——
  /** 读当前规则表（出厂预设 8 条 / 用户规则） */
  FileSecurityGet: 'fileSecurity:get',
  /** 全量规则表替换（宿主校验 fail-visible） */
  FileSecuritySet: 'fileSecurity:set',
  /** 重置为出厂预设 */
  FileSecurityReset: 'fileSecurity:reset',
  // —— S3-S3：安全中心设置 + 会话策略 + 备份目录 ——
  /** 安全中心设置读（默认策略 + 备份开关/上限） */
  SecuritySettingsGet: 'securitySettings:get',
  /** 安全中心设置部分更新（patch 合并；校验 fail-visible） */
  SecuritySettingsSet: 'securitySettings:set',
  /** 会话策略切换（default/session/readonly；session/policy 事件落链——D-S2-3 口径） */
  SessionSetPolicy: 'session:set-policy',
  /** 打开备份目录（main 侧 shell 能力——同 workspace:pick 先例，不入宿主 dispatch） */
  BackupOpenDir: 'backup:open-dir',
} as const

export type IpcChannelName = (typeof IpcChannel)[keyof typeof IpcChannel]

/** 宿主→渲染推送主题白名单（main 转发 → preload 订阅） */
export const IpcPushTopic = {
  /** 会话事件流（与 JSONL 落盘行同源同序——D-S2-1） */
  SessionEvent: 'push:session-event',
  /** 授权门等待用户决策（120s 倒计时展示口径；超时判定真值在内核——D-S2-5） */
  AuthzPending: 'push:authz-pending',
  /** 授权门已决（用户响应 / 内核超时 / 会话关闭取消——横幅生命周期锚点） */
  AuthzResolved: 'push:authz-resolved',
} as const

export type IpcPushTopicName = (typeof IpcPushTopic)[keyof typeof IpcPushTopic]

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
  /** 展示标题 = 最近一次 session/rename 事件；无 = 「未命名会话」 */
  title: string
  /**
   * 仅 session:create / session:open 响应携带：模型装配失败原因（S2 修补——
   * 失败禁吞进 console，建会话当场 fail-visible）；装配成功 = null/缺省
   */
  modelError?: string | null
}

/**
 * 内核 SessionEvent 结构镜像（1.12 实查：seq/ts/actor/kind/turnId/payload/meta/prevHash/hash）。
 * 推送载荷 = store 落盘行 JSON.parse——桌面端不手抄内核序列化逻辑（事实本体在 JSONL）。
 */
export interface SessionEventDTO {
  seq: number
  ts: number
  actor: 'user' | 'model' | 'plugin' | 'runtime'
  kind: 'user' | 'assistant' | 'toolCall' | 'toolResult' | 'turnEnd' | 'goalUpdate' | 'hostRaw' | 'fork' | 'system' | 'usage'
  turnId: string
  payload: unknown
  meta?: Record<string, unknown> | null
  prevHash: string
  hash: string
}

/** 授权决策审计事件（内核 AuthzService #commit 形态：kind='turnEnd' + turnId='authz:*'） */
export function isAuthzAuditEvent(e: SessionEventDTO): boolean {
  return e.kind === 'turnEnd' && typeof e.turnId === 'string' && e.turnId.startsWith('authz:')
}

export interface SessionEventPush {
  workspaceId: string
  sessionId: string
  event: SessionEventDTO
}

/** 授权门等待决策（渲染层倒计时展示；超时判定真值在内核 decideByUser——D-S2-5） */
export interface AuthzPendingPush {
  kind: 'pending'
  workspaceId: string
  sessionId: string
  /** 内核 authorizationId（幂等锚点） */
  requestId: string
  tool: string
  capability: string
  resource: string
  reason?: string
  /** 与内核 AuthzService timeoutMs 同值（展示口径） */
  timeoutMs: number
  ts: number
}

export interface AuthzResolvedPush {
  kind: 'resolved'
  workspaceId: string
  sessionId: string
  requestId: string
  /** approved = 用户批准；denied = 用户拒绝；timeout = 内核 120s 默认拒绝；cancelled = 会话关闭 */
  outcome: 'approved' | 'denied' | 'timeout' | 'cancelled'
  decidedBy: 'user' | 'policy' | 'timeout' | 'host'
}

export interface SessionOpenResult {
  sessionId: string
  workspaceId: string
  exists: boolean
  eventCount: number
  title: string
  /** 当前会话模型（config llm.model 锚点 / model/set 后为会话覆盖值） */
  model: string | null
  /** 模型装配失败原因（alive 句柄；只读回放恒无模型面 = null） */
  modelError?: string | null
  /** 全量回放（R-4：一次批量；此后增量经 IpcPushTopic.SessionEvent） */
  events: SessionEventDTO[]
}

export interface TurnSendResult {
  turnId: string
}

/** 会话用量聚合（usage 事件真实值求和；无 usage 的 turn 计入分母不估算——D-S2-4） */
export interface SessionUsageResult {
  /** turnEnd 事件数（turn 总数） */
  turns: number
  /** usage 事件数（= 已采集请求数） */
  requests: number
  /** 出现 usage 事件的 turn 数 */
  turnsWithUsage: number
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
  /** 最近一次请求的真实 prompt/completion tokens（ctx-pop「已用」口径） */
  lastInput: number | null
  lastOutput: number | null
  /** turnsWithUsage / turns（turns=0 时 null——禁伪造 100%） */
  coverage: number | null
}

/** 授权门响应载荷（AuthzRespond 通道） */
export type AuthzDecisionInput = 'once' | 'session' | 'deny'

// ── 文件安全设置面（S3-S2；设计：桌面端文件安全设计.md §5/§8.2） ──────────

export type FileTierDTO = 'allow' | 'ask' | 'deny'

export interface FileRuleDTO {
  id: string
  /** 白名单变量（%USERPROFILE%/%WORKSPACE%/%APPDATA%）或物化绝对路径；尾分隔符 = 目录规则 */
  path: string
  read: FileTierDTO
  write: FileTierDTO
  delete: FileTierDTO
  preset?: boolean
}

export interface FileSecurityState {
  version: 1
  updatedAt: number
  rules: FileRuleDTO[]
}

export interface FileSecuritySetRequest {
  rules: FileRuleDTO[]
}

// ── 安全中心设置面（S3-S3；设计：桌面端安全中心设计.md §4/§5） ──────────

export type SessionPolicyDTO = 'default' | 'session' | 'readonly'

export interface SecuritySettings {
  version: 1
  updatedAt: number
  /** 新建会话默认策略（「会话内放行」不作出厂默认——deny-by-default 血统） */
  sessionDefaultPolicy: 'default' | 'readonly'
  autoBackup: {
    enabled: boolean
    maxTotalBytes: number
  }
}

export interface SecuritySettingsPatch {
  sessionDefaultPolicy?: 'default' | 'readonly'
  autoBackup?: {
    enabled?: boolean
    maxTotalBytes?: number
  }
}

export interface SessionSetPolicyRequest {
  workspaceId: string
  sessionId: string
  policy: SessionPolicyDTO
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
  [IpcChannel.TurnSend]: { workspaceId: string; sessionId: string; text: string }
  [IpcChannel.TurnAbort]: { workspaceId: string; sessionId: string }
  [IpcChannel.AuthzRespond]: { workspaceId: string; sessionId: string; requestId: string; decision: AuthzDecisionInput }
  [IpcChannel.SessionUsage]: { workspaceId: string; sessionId: string }
  [IpcChannel.SessionRename]: { workspaceId: string; sessionId: string; title: string }
  [IpcChannel.SessionDelete]: { workspaceId: string; sessionId: string }
  [IpcChannel.SessionSetModel]: { workspaceId: string; sessionId: string; model: string }
  [IpcChannel.FileSecurityGet]: undefined
  [IpcChannel.FileSecuritySet]: FileSecuritySetRequest
  [IpcChannel.FileSecurityReset]: undefined
  [IpcChannel.SecuritySettingsGet]: undefined
  [IpcChannel.SecuritySettingsSet]: { patch: SecuritySettingsPatch }
  [IpcChannel.SessionSetPolicy]: SessionSetPolicyRequest
  [IpcChannel.BackupOpenDir]: undefined
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
  sendTurn(workspaceId: string, sessionId: string, text: string): Promise<TurnSendResult>
  abortTurn(workspaceId: string, sessionId: string): Promise<void>
  respondAuthz(workspaceId: string, sessionId: string, requestId: string, decision: AuthzDecisionInput): Promise<{ outcome: string }>
  sessionUsage(workspaceId: string, sessionId: string): Promise<SessionUsageResult>
  renameSession(workspaceId: string, sessionId: string, title: string): Promise<SessionInfo>
  deleteSession(workspaceId: string, sessionId: string): Promise<void>
  setSessionModel(workspaceId: string, sessionId: string, model: string): Promise<void>
  // —— 推送订阅（返回退订函数；preload 内持 ipcRenderer，渲染层零逃逸） ——
  onSessionEvent(cb: (p: SessionEventPush) => void): () => void
  onAuthzPending(cb: (p: AuthzPendingPush) => void): () => void
  onAuthzResolved(cb: (p: AuthzResolvedPush) => void): () => void
}
