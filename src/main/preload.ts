/**
 * preload 白名单桥（安全基线四件套之一，R-D4）
 *
 * 口径：本文件是 src/ 域内唯一允许出现 ipcRenderer 的位置（CI 门禁断言，
 * test/gates.spec.ts）；暴露面 = ipc-contract.ts 的 CarBridge 逐方法映射
 * （S2 含推送订阅——ipcRenderer.on 封装在 preload 内，渲染层零逃逸），
 * 无自由通道、无远端加载、无 Node 能力透出（sandbox: true 受限集）。
 */
import { contextBridge, ipcRenderer } from 'electron'
import { IpcChannel, IpcPushTopic, type CarBridge } from '../shared/ipc-contract.ts'

function subscribe<T>(topic: string, cb: (p: T) => void): () => void {
  const listener = (_event: unknown, payload: T): void => cb(payload)
  ipcRenderer.on(topic, listener)
  return () => {
    ipcRenderer.removeListener(topic, listener)
  }
}

const bridge: CarBridge = {
  probe: () => ipcRenderer.invoke(IpcChannel.HostProbe),
  pickAndRegisterWorkspace: () => ipcRenderer.invoke(IpcChannel.WorkspacePick),
  registerWorkspaceByPath: (path) => ipcRenderer.invoke(IpcChannel.WorkspaceRegister, { path }),
  listWorkspaces: () => ipcRenderer.invoke(IpcChannel.WorkspaceList),
  createSession: (workspaceId) => ipcRenderer.invoke(IpcChannel.SessionCreate, { workspaceId }),
  listSessions: (workspaceId) => ipcRenderer.invoke(IpcChannel.SessionList, { workspaceId }),
  // C8（AD-3）：afterSeq 提供时 = 游标增量装载（渲染层投影缓存——首装全量）
  openSession: (workspaceId, sessionId, afterSeq) =>
    ipcRenderer.invoke(IpcChannel.SessionOpen, { workspaceId, sessionId, ...(afterSeq != null ? { afterSeq } : {}) }),
  sendTurn: (workspaceId, sessionId, text, memoryInject) =>
    ipcRenderer.invoke(IpcChannel.TurnSend, { workspaceId, sessionId, text, ...(memoryInject !== undefined ? { memoryInject } : {}) }),
  abortTurn: (workspaceId, sessionId) => ipcRenderer.invoke(IpcChannel.TurnAbort, { workspaceId, sessionId }),
  /** Z-7（D-V12-2）：FileViewer 反向感知上报（渲染层 → main 单向；main 持态防抖写 viewer-state.json） */
  fileviewerReport: (state) => ipcRenderer.invoke(IpcChannel.FileviewerReport, state),
  /** Z-1（0.13.0 / D-Z13-3）：会话内分叉（upToSeq 缺省 = 整链——宿主侧派生） */
  sessionFork: (workspaceId, sessionId, upToSeq) =>
    ipcRenderer.invoke(IpcChannel.SessionFork, { workspaceId, sessionId, ...(typeof upToSeq === 'number' ? { upToSeq } : {}) }),
  respondAuthz: (workspaceId, sessionId, requestId, decision, note) =>
    ipcRenderer.invoke(IpcChannel.AuthzRespond, { workspaceId, sessionId, requestId, decision, ...(typeof note === 'string' && note.trim() ? { note: note.slice(0, 500) } : {}) }),
  sessionUsage: (workspaceId, sessionId) => ipcRenderer.invoke(IpcChannel.SessionUsage, { workspaceId, sessionId }),
  renameSession: (workspaceId, sessionId, title) =>
    ipcRenderer.invoke(IpcChannel.SessionRename, { workspaceId, sessionId, title }),
  deleteSession: (workspaceId, sessionId) => ipcRenderer.invoke(IpcChannel.SessionDelete, { workspaceId, sessionId }),
  // —— S3：文件安全 / 安全中心设置 / 会话策略 / 备份 / 审计 / 计量 ——
  fileSecurityGet: () => ipcRenderer.invoke(IpcChannel.FileSecurityGet),
  fileSecuritySet: (payload) => ipcRenderer.invoke(IpcChannel.FileSecuritySet, payload),
  fileSecurityReset: () => ipcRenderer.invoke(IpcChannel.FileSecurityReset),
  securitySettingsGet: () => ipcRenderer.invoke(IpcChannel.SecuritySettingsGet),
  securitySettingsSet: (patch) => ipcRenderer.invoke(IpcChannel.SecuritySettingsSet, { patch }),
  setSessionPolicy: (workspaceId, sessionId, policy) =>
    ipcRenderer.invoke(IpcChannel.SessionSetPolicy, { workspaceId, sessionId, policy }),
  openBackupDir: () => ipcRenderer.invoke(IpcChannel.BackupOpenDir),
  auditReport: (workspaceId, sessionId) => ipcRenderer.invoke(IpcChannel.AuditReport, { workspaceId, sessionId }),
  auditExport: (workspaceId, sessionId) => ipcRenderer.invoke(IpcChannel.AuditExport, { workspaceId, sessionId }),
  meteringSummary: (workspaceId) => ipcRenderer.invoke(IpcChannel.MeteringSummary, { workspaceId }),
  pluginsList: () => ipcRenderer.invoke(IpcChannel.PluginsList),
  pluginsAdd: (file, manifest) => ipcRenderer.invoke(IpcChannel.PluginsAdd, { file, manifest }),
  pluginsRemove: (id) => ipcRenderer.invoke(IpcChannel.PluginsRemove, { id }),
  mcpList: (workspaceId) => ipcRenderer.invoke(IpcChannel.McpList, { workspaceId }),
  doctorRun: (workspaceId) => ipcRenderer.invoke(IpcChannel.DoctorRun, workspaceId ? { workspaceId } : {}),
  modelsMeta: (workspaceId) => ipcRenderer.invoke(IpcChannel.ModelsMeta, workspaceId ? { workspaceId } : {}),
  credentialsSave: (payload) => ipcRenderer.invoke(IpcChannel.CredentialsSave, payload),
  credentialsMeta: () => ipcRenderer.invoke(IpcChannel.CredentialsMeta),
  credentialsClear: () => ipcRenderer.invoke(IpcChannel.CredentialsClear),
  // —— K6-ME（多端点）：列表 / 删槽 / 切换 active ——
  credentialsList: () => ipcRenderer.invoke(IpcChannel.CredentialsList),
  credentialsRemove: (id) => ipcRenderer.invoke(IpcChannel.CredentialsRemove, { id }),
  credentialsActivate: (id) => ipcRenderer.invoke(IpcChannel.CredentialsActivate, { id }),
  setSessionModel: (workspaceId, sessionId, model, contextWindow, reasoningEffort) =>
    ipcRenderer.invoke(IpcChannel.SessionSetModel, {
      workspaceId,
      sessionId,
      model,
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    }),
  // —— S5：立即压缩（append-only compact 事件） ——
  compactNow: (workspaceId, sessionId) => ipcRenderer.invoke(IpcChannel.SessionCompact, { workspaceId, sessionId }),
  // —— S6：白盒记忆面（K-MEM-1 消费面） ——
  memoryList: (workspaceId) => ipcRenderer.invoke(IpcChannel.MemoryList, { workspaceId }),
  memoryWrite: (workspaceId, sessionId, input) => ipcRenderer.invoke(IpcChannel.MemoryWrite, { workspaceId, sessionId, ...input }),
  memoryEdit: (workspaceId, sessionId, id, text, tags, meta) =>
    ipcRenderer.invoke(IpcChannel.MemoryEdit, { workspaceId, sessionId, id, text, ...(tags !== undefined ? { tags } : {}), ...(meta ? { meta } : {}) }),
  memoryRemove: (workspaceId, sessionId, id) => ipcRenderer.invoke(IpcChannel.MemoryRemove, { workspaceId, sessionId, id }),
  memoryRollback: (workspaceId, sessionId, id) => ipcRenderer.invoke(IpcChannel.MemoryRollback, { workspaceId, sessionId, id }),
  // —— T-24：能力库条目面（能力库视图 + 引用菜单） ——
  capabilityList: (workspaceId) => ipcRenderer.invoke(IpcChannel.CapabilityList, { workspaceId }),
  capabilityWrite: (workspaceId, sessionId, entry) => ipcRenderer.invoke(IpcChannel.CapabilityWrite, { workspaceId, sessionId, entry }),
  capabilityEdit: (workspaceId, sessionId, id, patch) => ipcRenderer.invoke(IpcChannel.CapabilityEdit, { workspaceId, sessionId, id, patch }),
  capabilityDelete: (workspaceId, sessionId, id) => ipcRenderer.invoke(IpcChannel.CapabilityDelete, { workspaceId, sessionId, id }),
  capabilityRefAdd: (workspaceId, sessionId, refId) => ipcRenderer.invoke(IpcChannel.CapabilityRefAdd, { workspaceId, sessionId, refId }),
  capabilityRefRemove: (workspaceId, sessionId, refId) => ipcRenderer.invoke(IpcChannel.CapabilityRefRemove, { workspaceId, sessionId, refId }),
  // —— SKILL.md 导入互认（pick = main 侧 dialog；import = 宿主解析写盘落链） ——
  capabilityImportPick: () => ipcRenderer.invoke(IpcChannel.CapabilityImportPick),
  capabilityImport: (workspaceId, sessionId, paths) => ipcRenderer.invoke(IpcChannel.CapabilityImport, { workspaceId, sessionId, paths }),
  capabilityImportPreview: (workspaceId, sessionId, paths) => ipcRenderer.invoke(IpcChannel.CapabilityImportPreview, { workspaceId, sessionId, paths }),
  // —— C1：工具源热更新开关（缺省关；Set 即时生效） ——
  toolSourceHotGet: () => ipcRenderer.invoke(IpcChannel.ToolSourceHotGet),
  toolSourceHotSet: (enabled) => ipcRenderer.invoke(IpcChannel.ToolSourceHotSet, { enabled }),
  // —— C3-B1：受控浏览器（main 侧；缺省关；Set 重启宿主生效） ——
  browserGet: () => ipcRenderer.invoke(IpcChannel.BrowserGet),
  browserSet: (enabled) => ipcRenderer.invoke(IpcChannel.BrowserSet, { enabled }),
  browserClearData: (cookies, cache) => ipcRenderer.invoke(IpcChannel.BrowserClearData, { cookies, cache }),
  // —— C3-B2：HITL 接管卡动作（前置受控窗口）+ consent 授权记录清除（宿主 revoke） ——
  browserFocus: () => ipcRenderer.invoke(IpcChannel.BrowserFocus),
  browserRevokeGrants: () => ipcRenderer.invoke(IpcChannel.BrowserRevokeGrants),
  // —— B-3：截图证据清除（main 侧 userData 能力——返回刷新后设置态） ——
  browserClearEvidence: () => ipcRenderer.invoke(IpcChannel.BrowserClearEvidence),
  // —— T-25：附件面（选择器 = main 侧 dialog；登记/撤销落链） ——
  attachmentPick: () => ipcRenderer.invoke(IpcChannel.AttachmentPick),
  attachmentAdd: (workspaceId, sessionId, paths) => ipcRenderer.invoke(IpcChannel.AttachmentAdd, { workspaceId, sessionId, paths }),
  attachmentRemove: (workspaceId, sessionId, path) => ipcRenderer.invoke(IpcChannel.AttachmentRemove, { workspaceId, sessionId, path }),
  // —— T-FV：文件查看器（预览/落链 = 宿主；shell 打开 = main 侧，可执行扩展拒绝面） ——
  filePreview: (workspaceId, sessionId, path) => ipcRenderer.invoke(IpcChannel.FilePreview, { workspaceId, sessionId, path }),
  fileOpen: (workspaceId, sessionId, path, how) => ipcRenderer.invoke(IpcChannel.FileOpen, { workspaceId, sessionId, path, how }),
  fileShellOpen: (path, how) => ipcRenderer.invoke(IpcChannel.FileShellOpen, { path, how }),
  // —— T-FV-2：任务控制面（停子代理 / bash 输出尾部 / 停 bash——宿主动作不过授权门） ——
  killSubagent: (workspaceId, sessionId, subagentId) => ipcRenderer.invoke(IpcChannel.SubagentKill, { workspaceId, sessionId, subagentId }),
  bashOutput: (workspaceId, sessionId, taskId) => ipcRenderer.invoke(IpcChannel.BashOutput, { workspaceId, sessionId, taskId }),
  bashKill: (workspaceId, sessionId, taskId) => ipcRenderer.invoke(IpcChannel.BashKill, { workspaceId, sessionId, taskId }),
  // —— T-ME：记忆进化（LLM 直调核——批准落盘走内核 MemoryStore；模式 = 端侧偏好同步） ——
  memoryEvolve: (workspaceId, sessionId, auto) =>
    ipcRenderer.invoke(IpcChannel.MemoryEvolve, { workspaceId, sessionId, ...(auto !== undefined ? { auto } : {}) }),
  memoryEvolveDecide: (workspaceId, sessionId, runId, cid, approve, feedback) =>
    ipcRenderer.invoke(IpcChannel.MemoryEvolveDecide, { workspaceId, sessionId, runId, cid, approve, ...(feedback !== undefined ? { feedback } : {}) }),
  memoryEvolveMode: (workspaceId, mode) => ipcRenderer.invoke(IpcChannel.MemoryEvolveMode, { workspaceId, mode }),
  // —— T-MP：个性化设置（端侧偏好——应用于新会话快照） ——
  personalizationGet: () => ipcRenderer.invoke(IpcChannel.PersonalizationGet),
  personalizationSet: (patch) => ipcRenderer.invoke(IpcChannel.PersonalizationSet, patch),
  // —— WB-2：用户级画像（userData 级跨工作区——显式开关出厂关；应用于新会话快照） ——
  userProfileGet: () => ipcRenderer.invoke(IpcChannel.UserProfileGet),
  userProfileSet: (patch) => ipcRenderer.invoke(IpcChannel.UserProfileSet, patch),
  // —— T-RW：RepoWiki（生成进度经 onRepoWiki 订阅——workspaceId 过滤） ——
  repoWikiGet: (workspaceId) => ipcRenderer.invoke(IpcChannel.RepoWikiGet, { workspaceId }),
  repoWikiGenerate: (workspaceId, sessionId) => ipcRenderer.invoke(IpcChannel.RepoWikiGenerate, { workspaceId, sessionId }),
  repoWikiStop: (workspaceId) => ipcRenderer.invoke(IpcChannel.RepoWikiStop, { workspaceId }),
  // C2（RW-4）：导出（main 侧目录对话框注入 dir——渲染层只传 workspaceId/sessionId）
  repoWikiExport: (workspaceId, sessionId) => ipcRenderer.invoke(IpcChannel.RepoWikiExport, { workspaceId, sessionId }),
  // —— C7（AD-2）：后台任务完成接回设置（自动唤醒缺省关 deny-by-default） ——
  bashWakeupGet: () => ipcRenderer.invoke(IpcChannel.BashWakeupGet),
  bashWakeupSet: (autoWakeup) => ipcRenderer.invoke(IpcChannel.BashWakeupSet, { autoWakeup }),
  onRepoWiki: (cb) => subscribe(IpcPushTopic.RepoWiki, cb),
  // —— T-DY：部署视图数据（main 侧真拉取） ——
  deployInfo: () => ipcRenderer.invoke(IpcChannel.DeployInfo),
  onSessionEvent: (cb) => subscribe(IpcPushTopic.SessionEvent, cb),
  // 1.19.0：流式增量（渲染提示面——不落链，assistant 事件到达即收口清零）
  onSessionDelta: (cb) => subscribe(IpcPushTopic.SessionDelta, cb),
  onAuthzPending: (cb) => subscribe(IpcPushTopic.AuthzPending, cb),
  onAuthzResolved: (cb) => subscribe(IpcPushTopic.AuthzResolved, cb),
  // B-2：HITL 接管卡（detect/resolved/timeout/aborted 四相）
  onBrowserHitl: (cb) => subscribe(IpcPushTopic.BrowserHitl, cb),
  // —— T-23：自动更新（main 侧能力；状态经 onUpdateStatus 推送） ——
  checkUpdate: () => ipcRenderer.invoke(IpcChannel.UpdateCheck),
  downloadUpdate: () => ipcRenderer.invoke(IpcChannel.UpdateDownload),
  installUpdate: () => ipcRenderer.invoke(IpcChannel.UpdateInstall),
  openReleases: () => ipcRenderer.invoke(IpcChannel.UpdateOpenReleases),
  onUpdateStatus: (cb) => subscribe(IpcPushTopic.UpdateStatus, cb),
}

contextBridge.exposeInMainWorld('car', bridge)
