import { useEffect, useState } from 'react'
import type { DeployInfoDTO, HostProbeResult, UpdateStatusPush } from '../../shared/ipc-contract'
import { DEPLOY_REPO } from '../../shared/deploy'

/**
 * T-DY 部署视图（原型 v-deploy 复刻——桌面分发面真数据 + 平台矩阵诚实空态）
 *
 * 口径：
 *  - **真数据纪律**：本机版本/内核 seam/更新通道状态/GitHub Releases 全部真值
 *    （api.github.com 通道已被 updater 首验证实可达；拉取失败 = 红字空态，禁假数据）；
 *  - 更新通道 = 三段显式（发现→用户下载→重启安装，禁静默升级——updater 横幅同源状态机）；
 *  - **平台环境矩阵 = 诚实空态**：平台 API 真桥未接线（平台侧待办）——四环境显示「未接线」，
 *    禁示意值；接线后此卡显示各环境版本/内核/最近部署（原型的 dev/sit/uat/prod 矩阵形态）；
 *  - 原型「重新部署/锁定」死按钮不搬（原型本身无行为）。
 */

const UPDATE_STATE_LABEL: Record<UpdateStatusPush['state'], string> = {
  disabled: '未启用（开发形态 / 未打包）',
  checking: '检查中…',
  available: '有新版本',
  'not-available': '已是最新',
  downloading: '下载中',
  downloaded: '已下载——待重启安装',
  error: '检查/下载失败',
}

const fmtTime = (ts: number | string): string => {
  const d = typeof ts === 'number' ? new Date(ts) : new Date(ts)
  return isNaN(d.getTime()) ? '—' : d.toLocaleString()
}

export function DeployView({
  update,
  probe,
  onStatus,
  onFail,
}: {
  update: UpdateStatusPush | null
  probe: HostProbeResult | null
  onStatus: (s: string) => void
  onFail: (e: unknown) => void
}) {
  const [info, setInfo] = useState<DeployInfoDTO | null>(null)

  const load = async (): Promise<void> => {
    try {
      setInfo(await window.car.deployInfo())
    } catch (e) {
      onFail(e)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <section className="card viewcard">
      <h2>部署</h2>
      <p className="dim">
        桌面端分发与版本治理（真数据）· 发布渠道 = GitHub Releases（更新通道同源）·
        平台环境矩阵为诚实空态（平台 API 真桥未接线——接线后显示各环境版本/内核/最近部署）。
      </p>

      {/* 本机版本面（真值） */}
      <div className="dy-card">
        <h3>本机版本面</h3>
        <div className="dy-rows">
          <div className="cp-row">
            <span>桌面版本</span>
            <b>{info?.appVersion ?? '…'}</b>
          </div>
          <div className="cp-row">
            <span>内核 seam</span>
            <b>
              {probe?.seamVersion ?? '—'}
              {probe?.symbolCount != null ? `（${probe.symbolCount} 符号）` : ''}
            </b>
          </div>
          <div className="cp-row">
            <span>更新通道</span>
            <b>GitHub Releases（{DEPLOY_REPO}）</b>
          </div>
          <div className="cp-row">
            <span>通道状态</span>
            <b className={update?.state === 'error' ? 'dy-err' : ''}>
              {update ? UPDATE_STATE_LABEL[update.state] : '—'}
              {update?.version ? `（${update.version}）` : ''}
              {update?.state === 'downloading' && update.percent != null ? ` ${update.percent}%` : ''}
            </b>
          </div>
          {update?.state === 'error' && update.message && <div className="dy-err">{update.message}</div>}
        </div>
        <div className="mem-ops">
          <button
            className="btn"
            onClick={() => {
              void window.car
                .checkUpdate()
                .then(() => onStatus('已发起更新检查——状态见本卡（横幅同步可见）'))
                .catch(onFail)
            }}
          >
            ⟳ 检查更新
          </button>
          <button
            className="btn"
            onClick={() => {
              void window.car.openReleases().catch(onFail)
            }}
          >
            ↗ 打开发布页
          </button>
        </div>
      </div>

      {/* 最近发布（真拉取） */}
      <div className="dy-card">
        <h3>最近发布（GitHub Releases）</h3>
        {info?.releasesError && <p className="dy-err">{info.releasesError}——发布表不可用（禁假数据）。</p>}
        {info?.releases && info.releases.length === 0 && <p className="dim">该仓暂无发布。</p>}
        {info?.releases && info.releases.length > 0 && (
          <table className="mtable">
            <thead>
              <tr>
                <th>Tag</th>
                <th>名称</th>
                <th>发布时间</th>
                <th>形态</th>
              </tr>
            </thead>
            <tbody>
              {info.releases.map((r) => (
                <tr key={r.tag}>
                  <td className="mono">{r.tag}</td>
                  <td>{r.name}</td>
                  <td className="dim2">{fmtTime(r.publishedAt)}</td>
                  <td>{r.prerelease ? <span className="dy-chip pre">预发布</span> : <span className="dy-chip stable">正式</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {info === null && <p className="dim">加载中…</p>}
      </div>

      {/* 平台环境矩阵（诚实空态——平台 API 真桥未接线） */}
      <div className="dy-card">
        <h3>平台环境矩阵</h3>
        <div className="dy-envs">
          {['dev', 'sit', 'uat', 'prod'].map((env) => (
            <div key={env} className="dy-env">
              <b>{env}</b>
              <span className="dy-chip offline">未接线</span>
            </div>
          ))}
        </div>
        <p className="dim">
          平台 API 真桥未接线（平台侧待办，与 MCP/PTC 真桥接线同批）——接线后此卡显示各环境平台版本 /
          内核版本 / 最近部署（原型矩阵的诚实形态）。桌面端禁示意数据。
        </p>
      </div>
    </section>
  )
}
