/**
 * 发布仓坐标（**单一事实源**——main 侧 deployInfo 拉取 / updater 发布页 / 渲染层通道标签同源）。
 *
 * 口径：
 *  - 坐标与 `package.json` 的 `build.publish.owner|repo` 必须同值；改坐标只改这里 + package.json，
 *    渲染层不再手抄字面量（曾因标签硬编码旧占位 `lqc123qwe` 与真拉取 `lqc624` 不一致，
 *    界面显示与事实分叉——D-10 登记）；
 *  - 渲染层可 import（零 electron 依赖）；main 侧仅用于拼 URL，不引入网络能力。
 */

/** 发布仓 owner/repo（GitHub） */
export const DEPLOY_REPO = 'lqc624/car-desktop'

/** 发布页（手动下载降级入口） */
export const RELEASES_URL = `https://github.com/${DEPLOY_REPO}/releases`
