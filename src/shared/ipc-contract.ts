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
  /** S5（D-S5-2）：立即压缩（内核 applyCompaction——append-only compact 事件；fail-visible CAR-E-COMPACT-*） */
  SessionCompact: 'session:compact',
  // —— S6：白盒记忆面（K-MEM-1 消费面；内核 1.15.x MemoryStore——落链承载 = 调用时活跃会话，D-46 ②） ——
  /** 记忆列表（只读——无会话也可查看；updatedAt 降序） */
  MemoryList: 'memory:list',
  /** 创建记忆（需活跃会话——无句柄显式拒绝，D-S6-1） */
  MemoryWrite: 'memory:write',
  /** 修改记忆（需活跃会话；链上 before/after 全文 = rollback 数据源） */
  MemoryEdit: 'memory:edit',
  /** 删除记忆（需活跃会话；补偿事件 + 文件移除） */
  MemoryRemove: 'memory:remove',
  /** 回滚记忆（需活跃会话；内核 undo 栈单步回退——返回 null = 已回退到删除态） */
  MemoryRollback: 'memory:rollback',
  // —— T-24（D2-S1）：能力库条目面（PRD C-1 本地目录 .car/capabilities/；CRUD 落链承载 = 活跃会话） ——
  /** 能力条目列表（只读——无会话也可查看；updatedAt 降序 + 损坏条目告警） */
  CapabilityList: 'capability:list',
  /** 新建条目（id 即文件名；重复 = 显式拒绝） */
  CapabilityWrite: 'capability:write',
  /** 编辑条目（patch 合并；spec 超限 fail-visible） */
  CapabilityEdit: 'capability:edit',
  CapabilityDelete: 'capability:delete',
  /** 引用条目（选中即落链 add——meta.injection:'capability'，EventKind 零新增） */
  CapabilityRefAdd: 'capability:ref-add',
  /** 撤销引用（remove 补偿事件落链） */
  CapabilityRefRemove: 'capability:ref-remove',
  // —— T-25（D2-S2）：附件面（PRD C-3 双形态；选择器 = main 侧 dialog，同 workspace:pick 先例） ——
  /** 系统文件选择器（多选；用户取消 = null） */
  AttachmentPick: 'attachment:pick',
  /** 附件登记（file/attach 恒落链；工作区外/拒绝规则路径硬拒） */
  AttachmentAdd: 'attachment:add',
  /** 撤销附件（file/attach-remove 补偿事件） */
  AttachmentRemove: 'attachment:remove',
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
  // —— S3-S4：审计报告 + 取证包导出（链校验单一权威在内核载入面——D-S3-6） ——
  /** 审计报告：事件全集 + 链校验状态（断链定位 brokenAt） */
  AuditReport: 'audit:report',
  /** 取证包导出：断链即中止 + 落盘 userData/exports + 读回重验 */
  AuditExport: 'audit:export',
  // —— S3-S5：计量聚合（usage 事实本体在会话 JSONL——禁估算；R-D5 价目两模式） ——
  /** 工作区计量汇总（四卡/7 日柱/按模型/turn 明细；价目未同步金额 = null 禁 0） */
  MeteringSummary: 'metrics:summary',
  // —— S4-S1：插件/MCP 只读装载面（F-D4；授权门经工具调用留痕） ——
  /** 插件登记清单 + 最近装载状态 */
  PluginsList: 'plugins:list',
  /** 登记插件（file + manifest；装载在下次会话创建时发生） */
  PluginsAdd: 'plugins:add',
  PluginsRemove: 'plugins:remove',
  /** MCP 双传输状态 + 工具清单（car.config mcp.servers 驱动） */
  McpList: 'mcp:list',
  // —— S4-S2：doctor 全项 + 自定义端点（safeStorage 凭据 main 独占） + 模型元数据 ——
  /** doctor 全项（凭据在位/连通性/seam——值不打印，输出面只有布尔/键名/耗时/错误类别） */
  DoctorRun: 'doctor:run',
  /** 模型元数据（内置静态表 + 端点声明——ctx 百分比真值来源；Key 永不出面） */
  ModelsMeta: 'models:meta',
  /**
   * 端点 Key 内存推送（main safeStorage 解密后独占调用——渲染层不触达；
   * host 内存缓存，不落盘不打印——N-D1）
   */
  CredentialsKeyPush: 'credentials:key-push',
  /** 保存自定义端点（main 侧 safeStorage 加密落盘；测试连通由渲染层先走 doctor 面探测） */
  CredentialsSave: 'credentials:save',
  /** 端点元数据（baseUrl/model/contextWindow——不含 Key） */
  CredentialsMeta: 'credentials:meta',
  CredentialsClear: 'credentials:clear',
  // —— T-23（D-V03-4）：自动更新（main 侧能力——GitHub Releases 渠道，不入宿主 dispatch） ——
  /** 手动检查更新（dev/未打包形态 = disabled 状态推送，不触网） */
  UpdateCheck: 'update:check',
  /** 下载更新包（available 态后调用；进度经 UpdateStatus 推送） */
  UpdateDownload: 'update:download',
  /** 下载完成后退出并安装（仅 downloaded 态可调） */
  UpdateInstall: 'update:install',
  /** 打开发布页（fail-visible 降级手动下载入口——更新失败禁静默） */
  UpdateOpenReleases: 'update:open-releases',
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
  /** T-23：自动更新状态机推送（available/downloading/downloaded/error——fail-visible 横幅数据源） */
  UpdateStatus: 'push:update-status',
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
  /** K2（1.16 子 Agent）：子链的父会话 id（session-start 载荷；普通会话 = null——列表面「子 Agent」徽标数据源） */
  parentSessionId?: string | null
  /** 上下文窗口（tokens）——模型元数据表/端点声明；无值 = null（渲染层不显示百分比，D-C5） */
  contextWindow?: number | null
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
  /** 内核 EventKind 镜像（1.15 实查：+usage/compact/routing/memory） */
  kind: 'user' | 'assistant' | 'toolCall' | 'toolResult' | 'turnEnd' | 'goalUpdate' | 'hostRaw' | 'fork' | 'system' | 'usage' | 'compact' | 'routing' | 'memory'
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

/**
 * T-23：自动更新状态推送（electron-updater 事件 → 渲染层横幅；error 必显——
 * D-V03-4 更新失败 fail-visible，降级手动下载入口 update:open-releases）
 */
export interface UpdateStatusPush {
  state: 'disabled' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
  /** 目标版本（available/downloading/downloaded/not-available） */
  version?: string
  /** 下载进度 0-100（downloading） */
  percent?: number
  /** 错误摘要（error 态——全文展示禁吞） */
  message?: string
  ts: number
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
  /** 上下文窗口（元数据表/端点声明；null = 渲染层不显示百分比——D-C5） */
  contextWindow?: number | null
  /** 全量回放（R-4：一次批量；此后增量经 IpcPushTopic.SessionEvent） */
  events: SessionEventDTO[]
  /**
   * T-22（D-S6-7）打开即恢复报告（null = 无恢复动作——alive 句柄 / 只读回放 / 干净链）。
   * interruptedTurns = 补记 turnEnd=interrupted 数；syntheticToolResults = 未配对 toolCall
   * 合成 toolResult 数；pendingSteers = 打开时待执行引导数（排队未跑——徽标数据源）。
   */
  recovery?: {
    interruptedTurns: number
    syntheticToolResults: number
    pendingSteers: number
    /** T-K2-4（1.16 K2）：子链恢复报告（仅在发生恢复/断链跳过时携带） */
    childSessions?: { recovered: number; broken: number }
  } | null
}

export interface TurnSendResult {
  turnId: string
  /** S6（D-S6-3）：true = 执行中引导发出（消息已落链排队，当前 turn 收口后 FIFO 续跑） */
  steer?: boolean
}

// ── 白盒记忆面（S6；内核 MemoryEntry 镜像——1.15 实查 id/text/tags/createdAt/updatedAt/sourceSession） ──

export interface MemoryEntryDTO {
  id: string
  text: string
  tags?: string[]
  createdAt: number
  updatedAt: number
  sourceSession?: string
}

/** 记忆操作请求载荷（write 可缺省 id = 内核派生 mem-*；edit/remove/rollback 以 id 定位） */
export interface MemoryOpRequest {
  workspaceId: string
  sessionId: string
  id?: string
  text?: string
  tags?: string[]
}

// ── T-24：能力库条目（PRD §2 schema v0.3 收窄——不做平台运营字段） ──

export type CapabilityKindDTO = 'expert' | 'skill' | 'kb'
export type CapabilityStatusDTO = 'active' | 'maintain' | 'retired'

export interface CapabilityEntryDTO {
  id: string
  kind: CapabilityKindDTO
  name: string
  version?: string
  author?: string
  tags?: string[]
  /** 规范正文（注入物）——≤ 20,000 字符（超限 fail-visible） */
  spec: string
  status: CapabilityStatusDTO
  createdAt: number
  updatedAt: number
}

/** 能力条目请求载荷（write 全量 / edit patch） */
export interface CapabilityEntryInput {
  id: string
  kind: CapabilityKindDTO
  name: string
  version?: string
  author?: string
  tags?: string[]
  spec: string
  status?: CapabilityStatusDTO
}

export interface CapabilityEditPatch {
  name?: string
  kind?: CapabilityKindDTO
  spec?: string
  status?: CapabilityStatusDTO
  version?: string
  author?: string
  tags?: string[]
}

/** T-25：附件登记行（mode = fulltext 文本全文 / path-ref 路径登记——PRD C-3 双形态） */
export interface AttachmentRowDTO {
  path: string
  mode: 'fulltext' | 'path-ref'
  size: number
  mime: string
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
  /**
   * S5（D-S5-3 / K-MP-2b）：分段计量事实（provider 真实输出细分）——
   * 无分段能力 provider / 无事实 = 不带键（禁估算，ctx-pop 色条退化单色）
   */
  segments?: { reasoningTokens: number }
  /** 最近一次请求的分段事实（同上——无事实不带键） */
  lastSegments?: { reasoningTokens: number }
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
  version: number
  updatedAt: number
  rules: FileRuleDTO[]
  /** S4 网络轴：域名/通配/URL 前缀规则（首条命中；未命中 = ask 落人审门） */
  networkRules: NetworkRuleDTO[]
}
export interface NetworkRuleDTO {
  id: string
  pattern: string
  tier: FileTierDTO
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

// ── 插件/MCP 装载面 + doctor/端点（S4） ──
export interface PluginStateDTO {
  id: string
  name: string | null
  version: string | null
  status: 'loaded' | 'failed'
  tools: string[]
  error?: string
}
export interface McpServerStateDTO {
  serverId: string
  transport: 'stdio' | 'http'
  status: 'connected' | 'failed'
  url: string | null
  tools: string[]
  error?: string
}
export interface DoctorRowDTO {
  label: string
  ok: boolean
  detail: string
}
export interface ModelMetaDTO {
  contextWindow: number
  thinking: 'none' | 'model-level'
  label: string
}
export interface EndpointMetaDTO {
  baseUrl: string
  model: string
  contextWindow: number | null
}
/** S5（D-S5-4）：模型菜单池端点项（car.config modelPool——无池 = 空数组） */
export interface PoolMemberDTO {
  id: string
  baseUrl: string
  model: string
  adapterId: 'openai-compat' | 'anthropic'
}

// ── 审计报告 / 取证包（S3-S4） ────────────────────────────────────────────

export interface AuditChainStatus {
  intact: boolean
  /** 断链定位（内核 verifyChain 单点真值）；intact = null */
  brokenAt: number | null
}

export interface AuditReport {
  sessionId: string
  eventCount: number
  /** 事件全集（载入面读盘——链事实本体，与渲染层推送同构） */
  events: SessionEventDTO[]
  chain: AuditChainStatus
  /** 撕裂尾（崩溃半行被丢弃的显性报告） */
  tornTail: boolean
  encoding: 'plain' | 'zstd'
}

export interface AuditExportResult {
  ok: boolean
  /** 导出目录（userData/exports/<sessionId>-<ts>） */
  dir: string
  files: string[]
  eventCount: number
  /** 读回重验：逐文件 SHA-256 + manifest 对拍 */
  verify: { ok: boolean; brokenFile: string | null }
  /** 读回重验：载入面链校验（恒 true——失败即 throw 隔离导出目录） */
  chainIntact: boolean
}

// ── 计量聚合（S3-S5；计量设计 §4.6 口径——金额未同步 = null 禁 0 禁估算） ──────────

export interface MeteringDayBar {
  day: string
  input: number
  output: number
  cacheRead: number
  cost: number | null
}
export interface MeteringModelRow {
  model: string
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
  requests: number
  cost: number | null
}
export interface MeteringTurnRow {
  sessionId: string
  ts: number
  turnId: string
  model: string | null
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
  requests: number
  cost: number | null
  /** 关联能力列：turn 内工具集合（关联呈现，不跨能力求和——计量设计 §4.4） */
  tools: string[]
}
export interface MeteringSummary {
  generatedAt: number
  /** false = 渲染层「价目未同步」横幅（禁金额伪造） */
  priceSynced: boolean
  cards: {
    today: { input: number; output: number; cacheRead: number; cost: number | null }
    cacheHitRate: number | null
    usageCoverage: number | null
    turnsWithoutUsage: number
  }
  dailyBars: MeteringDayBar[]
  byModel: MeteringModelRow[]
  turns: MeteringTurnRow[]
  /** 解析失败跳过的会话告警（fail-visible 显性化） */
  warnings: string[]
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
  [IpcChannel.TurnSend]: { workspaceId: string; sessionId: string; text: string; memoryInject?: boolean }
  [IpcChannel.TurnAbort]: { workspaceId: string; sessionId: string }
  [IpcChannel.AuthzRespond]: { workspaceId: string; sessionId: string; requestId: string; decision: AuthzDecisionInput }
  [IpcChannel.SessionUsage]: { workspaceId: string; sessionId: string }
  [IpcChannel.SessionRename]: { workspaceId: string; sessionId: string; title: string }
  [IpcChannel.SessionDelete]: { workspaceId: string; sessionId: string }
  [IpcChannel.SessionSetModel]: { workspaceId: string; sessionId: string; model: string; contextWindow?: number; reasoningEffort?: 'off' | 'low' | 'medium' | 'high' }
  [IpcChannel.SessionCompact]: { workspaceId: string; sessionId: string }
  [IpcChannel.MemoryList]: { workspaceId: string }
  [IpcChannel.MemoryWrite]: MemoryOpRequest
  [IpcChannel.MemoryEdit]: MemoryOpRequest
  [IpcChannel.MemoryRemove]: MemoryOpRequest
  [IpcChannel.MemoryRollback]: MemoryOpRequest
  [IpcChannel.CapabilityList]: { workspaceId: string }
  [IpcChannel.CapabilityWrite]: { workspaceId: string; sessionId: string; entry: CapabilityEntryInput }
  [IpcChannel.CapabilityEdit]: { workspaceId: string; sessionId: string; id: string; patch: CapabilityEditPatch }
  [IpcChannel.CapabilityDelete]: { workspaceId: string; sessionId: string; id: string }
  [IpcChannel.CapabilityRefAdd]: { workspaceId: string; sessionId: string; refId: string }
  [IpcChannel.CapabilityRefRemove]: { workspaceId: string; sessionId: string; refId: string }
  [IpcChannel.AttachmentPick]: undefined
  [IpcChannel.AttachmentAdd]: { workspaceId: string; sessionId: string; paths: string[] }
  [IpcChannel.AttachmentRemove]: { workspaceId: string; sessionId: string; path: string }
  [IpcChannel.FileSecurityGet]: undefined
  [IpcChannel.FileSecuritySet]: FileSecuritySetRequest
  [IpcChannel.FileSecurityReset]: undefined
  [IpcChannel.SecuritySettingsGet]: undefined
  [IpcChannel.SecuritySettingsSet]: { patch: SecuritySettingsPatch }
  [IpcChannel.SessionSetPolicy]: SessionSetPolicyRequest
  [IpcChannel.BackupOpenDir]: undefined
  [IpcChannel.AuditReport]: { workspaceId: string; sessionId: string }
  [IpcChannel.AuditExport]: { workspaceId: string; sessionId: string }
  [IpcChannel.MeteringSummary]: { workspaceId: string }
  [IpcChannel.PluginsList]: undefined
  [IpcChannel.PluginsAdd]: { file: string; manifest: { name: string; version: string } }
  [IpcChannel.PluginsRemove]: { id: string }
  [IpcChannel.McpList]: { workspaceId: string }
  [IpcChannel.DoctorRun]: { workspaceId?: string }
  [IpcChannel.ModelsMeta]: { workspaceId?: string }
  [IpcChannel.CredentialsKeyPush]: { baseUrl: string; model: string; key: string; contextWindow?: number } | { clear: true }
  [IpcChannel.CredentialsSave]: { baseUrl: string; model: string; key: string; contextWindow?: number }
  [IpcChannel.CredentialsMeta]: undefined
  [IpcChannel.CredentialsClear]: undefined
  [IpcChannel.UpdateCheck]: undefined
  [IpcChannel.UpdateDownload]: undefined
  [IpcChannel.UpdateInstall]: undefined
  [IpcChannel.UpdateOpenReleases]: undefined
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
  sendTurn(workspaceId: string, sessionId: string, text: string, memoryInject?: boolean): Promise<TurnSendResult>
  abortTurn(workspaceId: string, sessionId: string): Promise<void>
  respondAuthz(workspaceId: string, sessionId: string, requestId: string, decision: AuthzDecisionInput): Promise<{ outcome: string }>
  sessionUsage(workspaceId: string, sessionId: string): Promise<SessionUsageResult>
  renameSession(workspaceId: string, sessionId: string, title: string): Promise<SessionInfo>
  deleteSession(workspaceId: string, sessionId: string): Promise<void>
  setSessionModel(workspaceId: string, sessionId: string, model: string, contextWindow?: number, reasoningEffort?: 'off' | 'low' | 'medium' | 'high'): Promise<void>
  /** S5（D-S5-2）：立即压缩（append-only compact 事件；无区间 = CAR-E-COMPACT-NORANGE fail-visible） */
  compactNow(workspaceId: string, sessionId: string): Promise<{ seq: number; compactedUpTo: number; compactedEvents: number }>
  // —— S6：白盒记忆面（K-MEM-1 消费面）——
  /** 记忆列表（只读，无会话可查；updatedAt 降序） */
  memoryList(workspaceId: string): Promise<MemoryEntryDTO[]>
  /** 创建（id 缺省内核派生；需活跃会话——无句柄 = 宿主显式拒绝） */
  memoryWrite(workspaceId: string, sessionId: string, input: { id?: string; text: string; tags?: string[] }): Promise<MemoryEntryDTO>
  /** 修改（需活跃会话） */
  memoryEdit(workspaceId: string, sessionId: string, id: string, text: string, tags?: string[]): Promise<MemoryEntryDTO>
  /** 删除（需活跃会话） */
  memoryRemove(workspaceId: string, sessionId: string, id: string): Promise<void>
  /** 回滚（undo 栈单步；返回 null = 已回退到删除态） */
  memoryRollback(workspaceId: string, sessionId: string, id: string): Promise<MemoryEntryDTO | null>
  // —— T-24：能力库条目面（能力库视图 + 引用菜单） ——
  /** 条目列表（只读；损坏条目经 warnings 显性化） */
  capabilityList(workspaceId: string): Promise<{ entries: CapabilityEntryDTO[]; warnings: string[] }>
  /** 新建条目（需活跃会话——CRUD 落链承载） */
  capabilityWrite(workspaceId: string, sessionId: string, entry: CapabilityEntryInput): Promise<CapabilityEntryDTO>
  capabilityEdit(workspaceId: string, sessionId: string, id: string, patch: CapabilityEditPatch): Promise<CapabilityEntryDTO>
  capabilityDelete(workspaceId: string, sessionId: string, id: string): Promise<void>
  /** 引用/撤销（选中即落链；撤销 = 补偿事件） */
  capabilityRefAdd(workspaceId: string, sessionId: string, refId: string): Promise<void>
  capabilityRefRemove(workspaceId: string, sessionId: string, refId: string): Promise<void>
  // —— T-25：附件面（选择器 = main 侧 dialog；登记/撤销落链） ——
  /** 系统文件选择器（多选；用户取消 = null） */
  attachmentPick(): Promise<string[] | null>
  /** 附件登记（工作区外/拒绝规则路径 fail-visible） */
  attachmentAdd(workspaceId: string, sessionId: string, paths: string[]): Promise<AttachmentRowDTO[]>
  attachmentRemove(workspaceId: string, sessionId: string, path: string): Promise<void>
  // —— S3：文件安全设置面（安全中心页） ——
  fileSecurityGet(): Promise<FileSecurityState>
  fileSecuritySet(payload: { version: number; rules: FileRuleDTO[]; networkRules: NetworkRuleDTO[] }): Promise<FileSecurityState>
  fileSecurityReset(): Promise<FileSecurityState>
  // —— S3：安全中心设置（默认策略 + 备份开关/上限） ——
  securitySettingsGet(): Promise<SecuritySettings>
  securitySettingsSet(patch: SecuritySettingsPatch): Promise<SecuritySettings>
  setSessionPolicy(workspaceId: string, sessionId: string, policy: SessionPolicyDTO): Promise<{ ok: boolean; policy: SessionPolicyDTO }>
  openBackupDir(): Promise<{ ok: boolean; error?: string }>
  // —— S4：插件/MCP 装载面（只读呈现） ——
  pluginsList(): Promise<{ registrations: Array<{ id: string; file: string; manifest: unknown }>; states: PluginStateDTO[] }>
  pluginsAdd(file: string, manifest: { name: string; version: string }): Promise<{ registrations: Array<{ id: string; file: string; manifest: unknown }>; states: PluginStateDTO[] }>
  pluginsRemove(id: string): Promise<{ registrations: Array<{ id: string; file: string; manifest: unknown }>; states: PluginStateDTO[] }>
  mcpList(workspaceId: string): Promise<{ states: McpServerStateDTO[]; tools: Array<{ name: string; declaredSideEffect: 'readonly' | 'write' }> }>
  // —— S4-S2：doctor / 模型元数据 / 自定义端点 ——
  doctorRun(workspaceId?: string): Promise<{ rows: DoctorRowDTO[] }>
  modelsMeta(workspaceId?: string): Promise<{ meta: Record<string, ModelMetaDTO>; endpoint: EndpointMetaDTO | null; pool: PoolMemberDTO[] }>
  credentialsSave(payload: { baseUrl: string; model: string; key: string; contextWindow?: number }): Promise<EndpointMetaDTO>
  credentialsMeta(): Promise<EndpointMetaDTO | null>
  credentialsClear(): Promise<unknown>
  // —— S3-S4：审计报告 / 取证导出（审计页） ——
  auditReport(workspaceId: string, sessionId: string): Promise<AuditReport>
  auditExport(workspaceId: string, sessionId: string): Promise<AuditExportResult>
  // —— S3-S5：计量汇总（仪表盘计量区） ——
  meteringSummary(workspaceId: string): Promise<MeteringSummary>
  // —— 推送订阅（返回退订函数；preload 内持 ipcRenderer，渲染层零逃逸） ——
  onSessionEvent(cb: (p: SessionEventPush) => void): () => void
  onAuthzPending(cb: (p: AuthzPendingPush) => void): () => void
  onAuthzResolved(cb: (p: AuthzResolvedPush) => void): () => void
  // —— T-23：自动更新（main 侧能力；状态经 onUpdateStatus 推送） ——
  checkUpdate(): Promise<void>
  downloadUpdate(): Promise<void>
  installUpdate(): Promise<void>
  openReleases(): Promise<void>
  onUpdateStatus(cb: (p: UpdateStatusPush) => void): () => void
}
