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
  sendTurn: (workspaceId, sessionId, text) => ipcRenderer.invoke(IpcChannel.TurnSend, { workspaceId, sessionId, text }),
  abortTurn: (workspaceId, sessionId) => ipcRenderer.invoke(IpcChannel.TurnAbort, { workspaceId, sessionId }),
  respondAuthz: (workspaceId, sessionId, requestId, decision) =>
    ipcRenderer.invoke(IpcChannel.AuthzRespond, { workspaceId, sessionId, requestId, decision }),
  sessionUsage: (workspaceId, sessionId) => ipcRenderer.invoke(IpcChannel.SessionUsage, { workspaceId, sessionId }),
  renameSession: (workspaceId, sessionId, title) =>
    ipcRenderer.invoke(IpcChannel.SessionRename, { workspaceId, sessionId, title }),
  deleteSession: (workspaceId, sessionId) => ipcRenderer.invoke(IpcChannel.SessionDelete, { workspaceId, sessionId }),
  setSessionModel: (workspaceId, sessionId, model) =>
    ipcRenderer.invoke(IpcChannel.SessionSetModel, { workspaceId, sessionId, model }),
  // —— S3：文件安全 / 安全中心设置 / 会话策略 / 备份 / 审计 / 计量 ——
  fileSecurityGet: () => ipcRenderer.invoke(IpcChannel.FileSecurityGet),
  fileSecuritySet: (rules) => ipcRenderer.invoke(IpcChannel.FileSecuritySet, { rules }),
  fileSecurityReset: () => ipcRenderer.invoke(IpcChannel.FileSecurityReset),
  securitySettingsGet: () => ipcRenderer.invoke(IpcChannel.SecuritySettingsGet),
  securitySettingsSet: (patch) => ipcRenderer.invoke(IpcChannel.SecuritySettingsSet, { patch }),
  setSessionPolicy: (workspaceId, sessionId, policy) =>
    ipcRenderer.invoke(IpcChannel.SessionSetPolicy, { workspaceId, sessionId, policy }),
  openBackupDir: () => ipcRenderer.invoke(IpcChannel.BackupOpenDir),
  auditReport: (workspaceId, sessionId) => ipcRenderer.invoke(IpcChannel.AuditReport, { workspaceId, sessionId }),
  auditExport: (workspaceId, sessionId) => ipcRenderer.invoke(IpcChannel.AuditExport, { workspaceId, sessionId }),
  meteringSummary: (workspaceId) => ipcRenderer.invoke(IpcChannel.MeteringSummary, { workspaceId }),
  onSessionEvent: (cb) => subscribe(IpcPushTopic.SessionEvent, cb),
  onAuthzPending: (cb) => subscribe(IpcPushTopic.AuthzPending, cb),
  onAuthzResolved: (cb) => subscribe(IpcPushTopic.AuthzResolved, cb),
}

contextBridge.exposeInMainWorld('car', bridge)
