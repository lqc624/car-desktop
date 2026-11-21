/**
 * 文件查看器（T-FV / 原型 fv-mask 复刻）：会话产出 / 附件点击预览。
 *
 * 口径：
 *  - 读取 = fs_read 同管线（宿主 file:preview：hardReject 拒 deny/工作区外、二进制拒读、
 *    256KB 截断、redact 脱敏——用户预览与模型读取同一纪律）；binary 类仅 stat 元信息；
 *  - md 渲染 = marked + DOMPurify（消毒后注入——零 dangerouslySetInnerHTML 裸面）；
 *  - html 预览 = iframe sandbox=""（全禁，不执行脚本）；「在浏览器中打开」= main 侧
 *    shell.openExternal（file URL）；
 *  - 打开动作落链（file/preview、file/open——shell 成功后调用，留痕 = 已发生事实）；
 *    回放会话 logged:false → 弹层注记「动作未落链」。
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import {
  classifyPreviewFile,
  extOf,
  formatBytes,
  parseCsvPreview,
  previewCsvDelimiter,
  previewIconOf,
} from '../shared/file-preview'
import type { FilePreviewResultDTO, ViewerStateDTO } from '../shared/ipc-contract'

export interface ViewerTarget {
  workspaceId: string
  sessionId: string
  /** 绝对路径（toolcard 相对路径已由调用方按工作区 root 解析） */
  path: string
  /** 徽标语义：fs_write 产出 / file/attach 附件 */
  source: 'produced' | 'attach'
}

const baseName = (p: string): string => p.split(/[\\/]/).pop() || p

function PreviewBody({ data, path }: { data: FilePreviewResultDTO; path: string }): ReactElement {
  if (data.kind === 'binary') {
    return (
      <div className="fv-meta-card">
        <div className="fv-ico-big">{previewIconOf(path)}</div>
        <div className="fv-name">{baseName(path)}</div>
        <p className="dim" style={{ margin: '6px 0 0' }}>
          {formatBytes(data.size)} · 无内嵌预览（二进制面）——完整内容经系统默认程序打开
        </p>
      </div>
    )
  }
  const notes: string[] = []
  if (data.redactedCount && data.redactedCount > 0) notes.push(`已脱敏 ${data.redactedCount} 处（密钥面不渲染——K-FS-4）`)
  if (data.truncated) notes.push('内容超 256KB 已截断')
  const noteLine = notes.length > 0 ? <p className="fv-note">{notes.join(' · ')}</p> : null
  if (data.kind === 'csv' && data.content != null) {
    const csv = parseCsvPreview(data.content, 20, previewCsvDelimiter(path))
    const [head, ...body] = csv.rows
    return (
      <div>
        {noteLine}
        <table className="fv-table">
          {head && (
            <thead>
              <tr>{head.map((c, i) => <th key={i}>{c}</th>)}</tr>
            </thead>
          )}
          <tbody>
            {body.map((r, i) => (
              <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>
            ))}
          </tbody>
        </table>
        <p className="fv-note" style={{ marginTop: 10, textAlign: 'center' }}>
          {extOf(path) === '.tsv' ? 'TSV' : 'CSV'} · 预览前 {csv.rows.length} 行（共 {csv.totalRows} 行）· 完整内容以系统程序打开为准
        </p>
      </div>
    )
  }
  if (data.kind === 'html' && data.content != null) {
    return (
      <div>
        {noteLine}
        <iframe className="fv-frame" sandbox="" srcDoc={data.content} title={baseName(path)} />
        <p className="fv-note" style={{ marginTop: 8, textAlign: 'center' }}>
          HTML 报表内嵌预览（沙盒，不执行脚本）· 点「在浏览器中打开」获得完整页面
        </p>
      </div>
    )
  }
  // text：md/markdown 渲染（marked + DOMPurify），其余等宽原文
  if (data.content != null && (extOf(path) === '.md' || extOf(path) === '.markdown')) {
    const html = DOMPurify.sanitize(marked.parse(data.content, { async: false }))
    return (
      <div>
        {noteLine}
        <div className="fv-md" dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    )
  }
  return (
    <div>
      {noteLine}
      <pre className="fv-pre">{data.content ?? '（空文件）'}</pre>
    </div>
  )
}

export function FileViewer({ target, onClose }: { target: ViewerTarget; onClose: () => void }): ReactElement {
  const [data, setData] = useState<FilePreviewResultDTO | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  // ── Z-7 反向感知（0.12.0 / D-V12-2）：选区 + 滚动上报（main 持态防抖写盘 → fileviewer_get_view 数据源）──
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const reportTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const reportNow = useCallback(
    (viewOpen: boolean, extra?: { scrollPercent?: number; selectionText?: string }): void => {
      void window.car
        .fileviewerReport({
          viewOpen,
          ...(viewOpen ? { path: target.path } : {}),
          ...(extra?.scrollPercent !== undefined ? { scrollPercent: extra.scrollPercent } : {}),
          ...(extra?.selectionText ? { selectionText: extra.selectionText.slice(0, 2000), selectionChars: Math.min(extra.selectionText.length, 2000) } : {}),
          updatedAt: Date.now(),
        } satisfies ViewerStateDTO)
        .catch(() => { /* 上报失败静默——反向感知是增强面非功能面（fail-visible 红线不涉） */ })
    },
    [target.path],
  )

  const scheduleReport = useCallback(
    (extra?: { scrollPercent?: number; selectionText?: string }): void => {
      if (reportTimer.current) clearTimeout(reportTimer.current)
      reportTimer.current = setTimeout(() => reportNow(true, extra), 300)
    },
    [reportNow],
  )

  useEffect(() => {
    reportNow(true)
    const body = bodyRef.current
    const onScroll = (): void => {
      if (!body) return
      const span = body.scrollHeight - body.clientHeight
      scheduleReport({ scrollPercent: span > 0 ? Math.round((body.scrollTop / span) * 100) : 0 })
    }
    const onSelect = (): void => {
      const sel = window.getSelection()?.toString() ?? ''
      scheduleReport({ selectionText: sel.length ? sel.slice(0, 2000) : undefined })
    }
    body?.addEventListener('scroll', onScroll, { passive: true })
    document.addEventListener('selectionchange', onSelect)
    return () => {
      body?.removeEventListener('scroll', onScroll)
      document.removeEventListener('selectionchange', onSelect)
      if (reportTimer.current) clearTimeout(reportTimer.current)
      reportNow(false) // 关闭/切换 = 清态（main 写空态——host 工具见 viewOpen:false）
    }
  }, [reportNow, scheduleReport])

  useEffect(() => {
    let alive = true
    setData(null)
    setError(null)
    setActionError(null)
    window.car
      .filePreview(target.workspaceId, target.sessionId, target.path)
      .then((r) => {
        if (alive) setData(r)
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      alive = false
    }
  }, [target.path, target.sessionId, target.workspaceId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const shellOpen = async (how: 'system' | 'browser'): Promise<void> => {
    setActionError(null)
    const r = await window.car.fileShellOpen(target.path, how)
    if (!r.ok) {
      setActionError(r.error ?? '系统打开失败')
      return
    }
    try {
      await window.car.fileOpen(target.workspaceId, target.sessionId, target.path, how)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
      return
    }
    if (how === 'system') onClose()
  }

  const kind = classifyPreviewFile(target.path)
  const meta =
    data != null
      ? `${formatBytes(data.size)} · ${new Date(data.mtime).toLocaleString()} · ${target.source === 'produced' ? 'fs_write 产生 · 会话产出' : 'file/attach 已登记 · 只读上下文'}`
      : '读取中…'
  const badge =
    target.source === 'produced' ? 'fs_write 已落盘 · 会话哈希链' : 'file/attach 已登记 · 只读上下文'

  return (
    <div
      className="fv-mask"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="fv">
        <div className="fv-head">
          <span className="fv-ico">{previewIconOf(target.path)}</span>
          <div>
            <div className="fv-name">{baseName(target.path)}</div>
            <div className="fv-meta">{meta}</div>
          </div>
          <span className="fv-badge">{badge}</span>
          {data && !data.logged && <span className="fv-badge warn">回放会话 · 动作未落链</span>}
          <button className="fv-close" title="关闭" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="fv-body" ref={bodyRef}>
          {error != null ? (
            <p className="fv-err">{error}</p>
          ) : data == null ? (
            <p className="dim">读取中…（fs_read 同管线：redact 脱敏 · 256KB 截断 · 二进制拒读）</p>
          ) : (
            <PreviewBody data={data} path={target.path} />
          )}
        </div>
        <div className="fv-foot">
          <button className="btn sm" disabled={data == null} onClick={() => void shellOpen('system')}>
            在系统中打开
          </button>
          {kind === 'html' && (
            <button className="btn sm" disabled={data == null} onClick={() => void shellOpen('browser')}>
              在浏览器中打开
            </button>
          )}
          <button className="btn sm" onClick={onClose}>
            关闭
          </button>
          {actionError != null && <span className="fv-err">{actionError}</span>}
          <span className="fv-hint">
            预览与打开动作落审计链（file/preview · file/open）· 读取经 fs_read 同管线脱敏 · 路径值不打印
          </span>
        </div>
      </div>
    </div>
  )
}
