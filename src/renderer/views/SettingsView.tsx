import { useCallback, useEffect, useState } from 'react'
import type { DoctorRowDTO, EndpointMetaDTO, ModelMetaDTO } from '../../shared/ipc-contract'

/**
 * S4-S2 设置/诊断（立项书 F-D5）：doctor 全项（凭据在位/LLM 连通性/seam——值不打印）
 * + 自定义模型端点（Base URL + Model ID + Key + 可选上下文窗口声明——safeStorage 加密落盘，
 * Key 经 main 解密后内存推宿主装配；渲染层只见「已配置」态，Key 永不回显——N-D1）。
 */

export function SettingsView({ onEndpointChanged }: { onEndpointChanged?: () => void }) {
  const [rows, setRows] = useState<DoctorRowDTO[] | null>(null)
  const [endpoint, setEndpoint] = useState<EndpointMetaDTO | null>(null)
  const [meta, setMeta] = useState<Record<string, ModelMetaDTO> | null>(null)
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [key, setKey] = useState('')
  const [windowInput, setWindowInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setError(null)
    try {
      setEndpoint(await window.car.credentialsMeta())
      const m = await window.car.modelsMeta()
      setMeta(m.meta)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  const runDoctor = useCallback(async () => {
    setError(null)
    setBusy(true)
    try {
      const r = await window.car.doctorRun()
      setRows(r.rows)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    void load()
    void runDoctor()
  }, [load, runDoctor])

  const save = async () => {
    setError(null)
    setStatus(null)
    try {
      const ep = await window.car.credentialsSave({
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        key: key.trim(),
        ...(windowInput ? { contextWindow: Number(windowInput) } : {}),
      })
      setEndpoint(ep)
      setKey('') // Key 不回显（值不打印红线）
      setStatus('端点已保存（safeStorage 加密）并推宿主装配——新会话生效')
      onEndpointChanged?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const clear = async () => {
    setError(null)
    setStatus(null)
    try {
      await window.car.credentialsClear()
      setEndpoint(null)
      setStatus('已清除端点——装配回退 car.config llm')
      onEndpointChanged?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <section className="card viewcard">
      <h2>工作区与诊断</h2>
      <p className="dim">与 CLI 共享 car.config.ts · doctor 全项（值不打印）· 自定义模型端点（safeStorage 加密落盘——N-D1）</p>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {status && <div className="status">{status}</div>}

      <h3>doctor</h3>
      <button className="btn" style={{ margin: '8px 0' }} disabled={busy} onClick={() => void runDoctor()}>
        {busy ? '诊断中…' : '▶ 运行 doctor'}
      </button>
      {rows?.map((r, i) => (
        <div key={i} className={`banner ${r.ok ? 'ok' : 'err'}`} style={{ margin: '6px 0' }}>
          <b>{r.label}</b> · {r.ok ? '✓' : '✕'} {r.detail}
        </div>
      ))}

      <h3>自定义模型端点（OpenAI 兼容）</h3>
      {endpoint && (
        <div className="banner ok">
          已配置：<b>{endpoint.model}</b> @ <code className="mono">{endpoint.baseUrl}</code>
          {endpoint.contextWindow ? ` · 窗口 ${Math.round(endpoint.contextWindow / 1000)}k` : ' · 窗口未声明（ctx 百分比不显示）'}
        </div>
      )}
      <div className="row wrap">
        <input className="grow mono" placeholder="Base URL（https://… OpenAI 兼容）" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        <input placeholder="Model ID" value={model} style={{ width: 160 }} onChange={(e) => setModel(e.target.value)} />
        <input placeholder="API Key（safeStorage 加密，不回显）" type="password" value={key} style={{ width: 180 }} onChange={(e) => setKey(e.target.value)} />
        <input placeholder="窗口 k（可选）" value={windowInput} style={{ width: 110 }} onChange={(e) => setWindowInput(e.target.value.replace(/[^0-9]/g, ''))} />
        <button
          className="btn primary"
          disabled={!baseUrl.trim() || !model.trim() || !key.trim()}
          onClick={() => void save()}
          title="保存 = safeStorage 加密落盘 + 解密推宿主装配（新会话生效）"
        >
          保存并使用
        </button>
        <button className="btn danger" disabled={!endpoint} onClick={() => void clear()}>
          清除
        </button>
      </div>
      <p className="dim">优先级 = 自定义端点 &gt; car.config llm（R-D6）· Key 经 safeStorage 加密、解密后仅内存推宿主装配（不落盘、不回显、不打印）· 窗口声明可选——无值时 ctx 百分比不显示（禁估算）。</p>

      <h3>内置模型元数据</h3>
      <table className="mtable">
        <thead>
          <tr>
            <th>模型</th>
            <th>上下文窗口</th>
            <th>思考档位</th>
          </tr>
        </thead>
        <tbody>
          {meta === null && (
            <tr>
              <td colSpan={3} className="dim">
                载入中…
              </td>
            </tr>
          )}
          {meta &&
            Object.entries(meta).map(([model, m]) => (
              <tr key={model}>
                <td>
                  <b>{m.label}</b>
                  <small className="mono"> {model}</small>
                </td>
                <td>{Math.round(m.contextWindow / 1000)}k</td>
                <td>{m.thinking === 'none' ? '非思考档' : '深度思考（模型级）'}</td>
              </tr>
            ))}
        </tbody>
      </table>
    </section>
  )
}
