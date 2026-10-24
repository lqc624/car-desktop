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
  openSession: (workspaceId, sessionId) => ipcRenderer.invoke(IpcChannel.SessionOpen, { workspaceId, sessionId }),
  sendTurn: (workspaceId, sessionId, text, memoryInject) =>
    ipcRenderer.invoke(IpcChannel.TurnSend, { workspaceId, sessionId, text, ...(memoryInject !== undefined ? { memoryInject } : {}) }),
  abortTurn: (workspaceId, sessionId) => ipcRenderer.invoke(IpcChannel.TurnAbort, { workspaceId, sessionId }),
  respondAuthz: (workspaceId, sessionId, requestId, decision) =>
    ipcRenderer.invoke(IpcChannel.AuthzRespond, { workspaceId, sessionId, requestId, decision }),
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
  memoryEdit: (workspaceId, sessionId, id, text, tags) =>
    ipcRenderer.invoke(IpcChannel.MemoryEdit, { workspaceId, sessionId, id, text, ...(tags !== undefined ? { tags } : {}) }),
  memoryRemove: (workspaceId, sessionId, id) => ipcRenderer.invoke(IpcChannel.MemoryRemove, { workspaceId, sessionId, id }),
  memoryRollback: (workspaceId, sessionId, id) => ipcRenderer.invoke(IpcChannel.MemoryRollback, { workspaceId, sessionId, id }),
  // —— T-24：能力库条目面（能力库视图 + 引用菜单） ——
  capabilityList: (workspaceId) => ipcRenderer.invoke(IpcChannel.CapabilityList, { workspaceId }),
  capabilityWrite: (workspaceId, sessionId, entry) => ipcRenderer.invoke(IpcChannel.CapabilityWrite, { workspaceId, sessionId, entry }),
  capabilityEdit: (workspaceId, sessionId, id, patch) => ipcRenderer.invoke(IpcChannel.CapabilityEdit, { workspaceId, sessionId, id, patch }),
  capabilityDelete: (workspaceId, sessionId, id) => ipcRenderer.invoke(IpcChannel.CapabilityDelete, { workspaceId, sessionId, id }),
  capabilityRefAdd: (workspaceId, sessionId, refId) => ipcRenderer.invoke(IpcChannel.CapabilityRefAdd, { workspaceId, sessionId, refId }),
  capabilityRefRemove: (workspaceId, sessionId, refId) => ipcRenderer.invoke(IpcChannel.CapabilityRefRemove, { workspaceId, sessionId, refId }),
  // —— T-25：附件面（选择器 = main 侧 dialog；登记/撤销落链） ——
  attachmentPick: () => ipcRenderer.invoke(IpcChannel.AttachmentPick),
  attachmentAdd: (workspaceId, sessionId, paths) => ipcRenderer.invoke(IpcChannel.AttachmentAdd, { workspaceId, sessionId, paths }),
  attachmentRemove: (workspaceId, sessionId, path) => ipcRenderer.invoke(IpcChannel.AttachmentRemove, { workspaceId, sessionId, path }),
  onSessionEvent: (cb) => subscribe(IpcPushTopic.SessionEvent, cb),
  onAuthzPending: (cb) => subscribe(IpcPushTopic.AuthzPending, cb),
  onAuthzResolved: (cb) => subscribe(IpcPushTopic.AuthzResolved, cb),
  // —— T-23：自动更新（main 侧能力；状态经 onUpdateStatus 推送） ——
  checkUpdate: () => ipcRenderer.invoke(IpcChannel.UpdateCheck),
  downloadUpdate: () => ipcRenderer.invoke(IpcChannel.UpdateDownload),
  installUpdate: () => ipcRenderer.invoke(IpcChannel.UpdateInstall),
  openReleases: () => ipcRenderer.invoke(IpcChannel.UpdateOpenReleases),
  onUpdateStatus: (cb) => subscribe(IpcPushTopic.UpdateStatus, cb),
}

contextBridge.exposeInMainWorld('car', bridge)
