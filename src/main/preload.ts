/**
 * preload 白名单桥（安全基线四件套之一，R-D4）
 *
 * 口径：本文件是 src/ 域内唯一允许出现 ipcRenderer 的位置（CI 门禁断言，
 * test/gates.spec.ts）；暴露面 = ipc-contract.ts 的 CarBridge 逐方法映射，
 * 无自由通道、无远端加载、无 Node 能力透出（sandbox: true 受限集）。
 */
import { contextBridge, ipcRenderer } from 'electron'
import { IpcChannel, type CarBridge } from '../shared/ipc-contract.ts'

const bridge: CarBridge = {
  probe: () => ipcRenderer.invoke(IpcChannel.HostProbe),
  pickAndRegisterWorkspace: () => ipcRenderer.invoke(IpcChannel.WorkspacePick),
  registerWorkspaceByPath: (path) => ipcRenderer.invoke(IpcChannel.WorkspaceRegister, { path }),
  listWorkspaces: () => ipcRenderer.invoke(IpcChannel.WorkspaceList),
  createSession: (workspaceId) => ipcRenderer.invoke(IpcChannel.SessionCreate, { workspaceId }),
  listSessions: (workspaceId) => ipcRenderer.invoke(IpcChannel.SessionList, { workspaceId }),
  openSession: (workspaceId, sessionId) => ipcRenderer.invoke(IpcChannel.SessionOpen, { workspaceId, sessionId }),
}

contextBridge.exposeInMainWorld('car', bridge)
