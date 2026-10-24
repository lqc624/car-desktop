/**
 * 自动更新（T-23 / D-V03-4：GitHub Releases 渠道先行，源 = lqc123qwe/car-desktop——
 * 占位坐标，实际仓库名定稿后在 package.json build.publish 修改一行即可）
 *
 * 口径：
 *  - electron-updater + GitHub provider：更新包校验沿发布链纪律——latest.yml sha512 +
 *    blockmap 分片校验由 electron-updater 内建承载（发布产物缺 latest.yml = 更新面不可用）；
 *  - autoDownload = false：发现新版本 → 渲染层横幅用户显式下载（进度推送）→ downloaded
 *    后显式「重启安装」——三段都可见，禁静默升级；
 *  - 失败 fail-visible：error 事件全文推送渲染层横幅 + 打开发布页手动下载降级入口
 *    （R-11：GitHub 国内波动 / 开发机 443 阻断仅影响开发侧——终端用户可达性另计）；
 *  - dev/未打包形态 = disabled 状态推送（checkForUpdates 在 dev 抛错，前置短路不触网）；
 *  - 本模块属 main 侧 shell 能力（同 workspace:pick 先例——不入宿主 dispatch，
 *    host-core 零 Electron 纪律不变）。
 */
import { app, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateStatusPush } from '../shared/ipc-contract.ts'

/** 发布页（手动下载降级入口——与 package.json build.publish 同仓） */
export const RELEASES_URL = 'https://github.com/lqc123qwe/car-desktop/releases'

let push: ((s: UpdateStatusPush) => void) | null = null
let lastPercent = -1

function emit(state: UpdateStatusPush['state'], extra: Omit<UpdateStatusPush, 'state' | 'ts'> = {}): void {
  push?.({ state, ts: Date.now(), ...extra })
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function initUpdater(onPush: (s: UpdateStatusPush) => void): void {
  push = onPush
  if (!app.isPackaged) {
    emit('disabled', { message: '开发形态不启用自动更新（未打包）' })
    return
  }
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('checking-for-update', () => emit('checking'))
  autoUpdater.on('update-available', (info) => emit('available', { version: info.version }))
  autoUpdater.on('update-not-available', (info) => emit('not-available', { version: info.version }))
  autoUpdater.on('download-progress', (p) => {
    const percent = Math.round(p.percent)
    if (percent !== lastPercent) {
      lastPercent = percent
      emit('downloading', { percent })
    }
  })
  autoUpdater.on('update-downloaded', (info) => emit('downloaded', { version: info.version }))
  autoUpdater.on('error', (err) => emit('error', { message: messageOf(err) }))
}

/** 手动检查（启动检查/横幅重试共用）；checkForUpdates 拒绝时 error 事件已推送，此处不重复抛 */
export async function checkForUpdates(): Promise<void> {
  if (!app.isPackaged) {
    emit('disabled', { message: '开发形态不启用自动更新（未打包）' })
    return
  }
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    console.error('[updater] 检查更新失败：', messageOf(err))
  }
}

export async function downloadUpdate(): Promise<void> {
  if (!app.isPackaged) return
  lastPercent = -1
  try {
    await autoUpdater.downloadUpdate()
  } catch (err) {
    console.error('[updater] 下载更新失败：', messageOf(err))
  }
}

export function installUpdate(): void {
  if (!app.isPackaged) return
  autoUpdater.quitAndInstall(false, true)
}

export function openReleases(): Promise<void> {
  return shell.openExternal(RELEASES_URL)
}
