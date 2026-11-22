import { useEffect, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import type { RepoWikiManifestDTO, RepoWikiPush, WorkspaceInfo } from '../../shared/ipc-contract'

/**
 * T-RW RepoWiki 视图（原型 v-repowiki 复刻 · CAR 全程本地化重构）
 *
 * 口径：
 *  - **生成 = 宿主编排**（扫描 fs_read 同管线 → LLM 大纲 → 逐页 LLM → 落盘
 *    userData/repo-wiki/<workspaceId>/——零上传、.git/node_modules/拒绝路径出厂排除）；
 *  - **落链承载 = 该工作区活跃会话**（D-46②——无会话 = 生成禁用 + 提示）；随时可停；
 *  - 进度经 push:repo-wiki（workspaceId 过滤——多工作区并行互不阻塞）；
 *  - 页面正文 = repoWikiGet 随 manifest 返回（≤6 页全量可承受），md 渲染 = marked + DOMPurify
 *    （FileViewer 同款）；与仓库内 CLAUDE.md/AGENTS.md 互补（人读 ≠ 模型读）。
 */

const fmtTime = (ts: number): string => new Date(ts).toLocaleString()

const RUN_STEPS = new Set(['scan', 'outline', 'page', 'write'])

export function RepoWikiView({
  workspaces,
  selected,
  openId,
  onStatus,
  onFail,
}: {
  workspaces: WorkspaceInfo[]
  selected: WorkspaceInfo | null
  /** 当前打开会话所属上下文（生成落链承载判定——需要 openId 存在） */
  openId: string | null
  onStatus: (s: string) => void
  onFail: (e: unknown) => void
}) {
  const [manifests, setManifests] = useState<Record<string, RepoWikiManifestDTO>>({})
  const [progress, setProgress] = useState<Record<string, RepoWikiPush>>({})
  const [activePage, setActivePage] = useState<string | null>(null)
  const [busyWs, setBusyWs] = useState<string | null>(null)

  const loadManifest = async (wid: string): Promise<void> => {
    try {
      const m = await window.car.repoWikiGet(wid)
      setManifests((prev) => {
        const next = { ...prev }
        if (m) next[wid] = m
        else delete next[wid]
        return next
      })
    } catch (e) {
      onFail(e)
    }
  }

  useEffect(() => {
    for (const w of workspaces) void loadManifest(w.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaces])

  // 进度订阅（workspaceId 过滤——多工作区并行各自成行）
  useEffect(() => {
    return window.car.onRepoWiki((p: RepoWikiPush) => {
      setProgress((prev) => ({ ...prev, [p.workspaceId]: p }))
      if (p.step === 'done' || p.step === 'aborted' || p.step === 'error') {
        void loadManifest(p.workspaceId)
        if (p.step === 'done') onStatus(`RepoWiki 已生成——${p.message}（repo-wiki/done 落链）`)
        else if (p.step === 'error') onStatus(`RepoWiki 生成失败：${p.error ?? p.message}`)
        else onStatus('RepoWiki 生成已停止（随时可停）')
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const generating = (wid: string): boolean => {
    const p = progress[wid]
    return p != null && RUN_STEPS.has(p.step)
  }
  const selManifest = selected ? (manifests[selected.id] ?? null) : null
  const selProgress = selected ? (progress[selected.id] ?? null) : null
  const pages = selManifest?.pages ?? []
  const currentMd = selManifest && activePage ? (pages.find((p) => p.id === activePage)?.md ?? null) : null

  const generate = async (w: WorkspaceInfo): Promise<void> => {
    if (!openId) {
      onFail(new Error('生成 RepoWiki 需要打开该工作区的会话（落链承载 = 活跃会话，D-46②）——先在侧栏打开/新建会话'))
      return
    }
    try {
      setBusyWs(w.id)
      const r = await window.car.repoWikiGenerate(w.id, openId)
      onStatus(`RepoWiki 生成已发起（${r.runId}）——进度见本页（随时可停止）`)
    } catch (e) {
      onFail(e)
    } finally {
      setBusyWs(null)
    }
  }

  const stop = async (wid: string): Promise<void> => {
    try {
      await window.car.repoWikiStop(wid)
      onStatus('已发停止信号——生成在当前步完成后中止（随时可停）')
    } catch (e) {
      onFail(e)
    }
  }

  // C2（RW-4 · Q-R4）：导出（main 侧目录对话框 → 宿主白名单写盘 + repo-wiki/export 落链；共享 = 用户自行 push）
  const exportWiki = async (wid: string): Promise<void> => {
    if (!openId) {
      onFail(new Error('导出 RepoWiki 需要打开该工作区的会话（落链承载 = 活跃会话）——先在侧栏打开/新建会话'))
      return
    }
    try {
      const r = await window.car.repoWikiExport(wid, openId)
      if (!r.ok) {
        onStatus('已取消导出（未选目录）')
        return
      }
      onStatus(`RepoWiki 已导出 ${r.fileCount} 件 → ${r.dir}（repo-wiki/export 落链；共享 = 自行 push，零自动上传）`)
    } catch (e) {
      onFail(e)
    }
  }

  return (
    <section className="card viewcard">
      <h2>RepoWiki</h2>
      <p className="dim">
        工作区级本地仓库文档：扫描（fs_read 同管线——脱敏/截断/拒绝路径排除）→ LLM 大纲（≤6 页）→ 逐页生成 →
        落盘 <code className="mono">userData/repo-wiki/</code>。<b>全程本地，零上传</b>；生成落当前会话审计链
        （repo-wiki/scan|outline|page|done）+ usage 计量；随时可停。
      </p>

      {/* 生成卡（当前选中工作区） */}
      {selected && (
        <div className="rw-gen">
          <div className="rw-gen-head">
            <b>◈ {selected.name}</b>
            {selManifest ? (
              <span className="dim">
                已生成 {selManifest.pages.length} 页 · {fmtTime(selManifest.generatedAt)}
                {selManifest.usage ? ` · usage in ${selManifest.usage.input}/out ${selManifest.usage.output}` : ''}
              </span>
            ) : (
              <span className="dim">未生成——生成全程本地，零上传</span>
            )}
          </div>
          {/* C1（RW-5 · Q-R1）：滞后检测提醒（读取时确定性对比——零 LLM 零副作用；重生成后自动消隐） */}
          {selManifest?.stale && selManifest.stale.files.length > 0 && (
            <div className="rw-stale">
              <span className="tag err">
                ⏳ 滞后：{selManifest.stale.files.length} 文件已变更{selManifest.stale.estimated ? '（估算口径）' : ''}——文档可能滞后于代码
              </span>
              <details>
                <summary className="dim2">变更清单</summary>
                <ul className="rw-stale-list">
                  {selManifest.stale.files.map((f) => (
                    <li key={f}>
                      <code className="mono">{f}</code>
                    </li>
                  ))}
                </ul>
              </details>
            </div>
          )}
          {selProgress && generating(selected.id) && (
            <div className="rw-progress">
              <div className="rw-bar">
                <div className="rw-fill" style={{ width: `${selProgress.pct}%` }} />
              </div>
              <div className="dim">
                {selProgress.message}
                {selProgress.pct > 0 ? `（${selProgress.pct}%）` : ''}
              </div>
            </div>
          )}
          <div className="mem-ops">
            <button
              className="btn primary"
              disabled={!openId || busyWs === selected.id || generating(selected.id)}
              onClick={() => void generate(selected)}
              title={openId ? '扫描→大纲→逐页→本地落盘（落当前会话链 + usage 计量）' : '需要打开该工作区的会话（落链承载）'}
            >
              {selManifest ? '↻ 重新生成' : '⬡ 生成 RepoWiki'}
            </button>
            {generating(selected.id) && (
              <button className="btn danger" onClick={() => void stop(selected.id)}>
                ■ 停止
              </button>
            )}
            {selManifest && (
              <button
                className="btn"
                disabled={!openId || generating(selected.id)}
                onClick={() => void exportWiki(selected.id)}
                title="另存对话框选目标目录 → pages/*.md + manifest 副本（白名单写盘；共享 = 自行 push）"
              >
                ⇩ 导出
              </button>
            )}
            {!openId && <span className="dim">⚠ 生成需要打开该工作区的会话（落链承载）——先在侧栏打开/新建会话</span>}
          </div>
        </div>
      )}

      {/* 页面树 + 正文双栏 */}
      {selManifest && pages.length > 0 && (
        <div className="rw-body">
          <div className="rw-tree">
            {pages.map((p) => (
              <button key={p.id} className={`rw-page${activePage === p.id ? ' sel' : ''}`} onClick={() => setActivePage(p.id)}>
                <code className="mono">{p.id}</code> {p.title}
                <small className="dim2"> {p.chars} 字符</small>
              </button>
            ))}
          </div>
          <div className="rw-content">
            {currentMd != null ? (
              <div className="fv-md rw-md" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(marked.parse(currentMd, { async: false })) }} />
            ) : (
              <p className="dim">选择左侧页面查看正文。</p>
            )}
          </div>
        </div>
      )}

      {/* 全部工作区 · 独立生成入口（并行互不阻塞——workspace 级 in-flight） */}
      {workspaces.length > 0 && (
        <table className="mtable rw-ws">
          <thead>
            <tr>
              <th>工作区</th>
              <th>状态</th>
              <th>上次生成</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {workspaces.map((w) => {
              const m = manifests[w.id]
              const gen = generating(w.id)
              const p = progress[w.id]
              return (
                <tr key={w.id}>
                  <td>
                    {w.name}
                    {selected?.id === w.id && <span className="dim2">（当前）</span>}
                  </td>
                  <td>{gen ? <span className="rw-running">{p?.message ?? '生成中…'}</span> : m ? `已生成 ${m.pages.length} 页` : '未生成'}</td>
                  <td className="dim2">{m ? fmtTime(m.generatedAt) : '—'}</td>
                  <td>
                    <span className="mem-ops">
                      <button className="mini" disabled={!openId || gen || busyWs === w.id} onClick={() => void generate(w)} title={openId ? '生成/重新生成（落链承载 = 当前会话）' : '需要打开会话'}>
                        {m ? '↻ 重新生成' : '⬡ 生成'}
                      </button>
                      {gen && (
                        <button className="mini danger" onClick={() => void stop(w.id)}>
                          ■ 停止
                        </button>
                      )}
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}

      {/* 与 ZCode 事件对照 · CAR 三原则（原型对照表） */}
      <table className="mtable">
        <thead>
          <tr>
            <th>维度</th>
            <th>CAR 口径</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>触发</td>
            <td>显式触发 · 随时可停（取消旗标步间检查）</td>
          </tr>
          <tr>
            <td>数据流</td>
            <td>全程本地零上传——落盘 userData/repo-wiki/（agent 不可写面）</td>
          </tr>
          <tr>
            <td>范围</td>
            <td>.git / node_modules / 拒绝规则路径出厂排除 · 文件数与字符双预算（禁全仓无界读）</td>
          </tr>
          <tr>
            <td>可审计</td>
            <td>repo-wiki/scan|outline|page|done 落会话链 · usage 计量 · 语料过 redact 脱敏</td>
          </tr>
        </tbody>
      </table>

      <p className="dim rw-foot">
        AI 取用：RepoWiki 面向人（与 CLAUDE.md/AGENTS.md 面向模型互补）· 更新策略 = 手动重新生成 ·
        页面正文经 DOMPurify 消毒渲染 · 语料与产出全程不出本机。
      </p>
    </section>
  )
}
