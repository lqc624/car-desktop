import { useCallback, useEffect, useState } from 'react'
import type { DoctorRowDTO, EndpointMetaDTO, ModelMetaDTO, WorkspaceInfo } from '../../shared/ipc-contract'

/**
 * S4-S2 设置/诊断（立项书 F-D5）：doctor 全项（凭据在位/LLM 连通性/seam——值不打印）
 * + 自定义模型端点（Base URL + Model ID + Key + 可选上下文窗口声明——safeStorage 加密落盘，
 * Key 经 main 解密后内存推宿主装配；渲染层只见「已配置」态，Key 永不回显——N-D1）。
 */

export function SettingsView({ selected, onEndpointChanged }: { selected?: WorkspaceInfo | null; onEndpointChanged?: () => void }) {
  const [rows, setRows] = useState<DoctorRowDTO[] | null>(null)
  const [endpoint, setEndpoint] = useState<EndpointMetaDTO | null>(null)
  const [meta, setMeta] = useState<Record<string, ModelMetaDTO> | null>(null)
  const [baseUrl, setBaseUrl] = useState('')
  const [key, setKey] = useState('')
  // K5-F：端点模型列表（一 URL 多模型——Claude Code 式；首行 = 装配锚点模型）
  const [models, setModels] = useState<Array<{ id: string; win: string }>>([{ id: '', win: '' }])
  // K5-D（V2）：适配器族（openai-compat | anthropic——anthropic 网关端点路线，缺省 openai-compat）
  const [adapterId, setAdapterId] = useState<'openai-compat' | 'anthropic'>('openai-compat')
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setError(null)
    try {
      const ep = await window.car.credentialsMeta()
      setEndpoint(ep)
      // K5-F：模型列表编辑器回填（一 URL 多模型——Claude Code 式；首行 = 装配锚点）
      // baseUrl 必须回填——否则空 URL 令保存键禁用（k5f 实测红条：编辑模型列表看似保存实则未触发）
      if (ep) setBaseUrl(ep.baseUrl)
      setModels(ep ? ep.models.map((m) => ({ id: m.id, win: m.contextWindow ? String(Math.round(m.contextWindow / 1000)) : '' })) : [{ id: '', win: '' }])
      setAdapterId(ep?.adapterId ?? 'openai-compat')
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
      const r = await window.car.doctorRun(selected?.id)
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
    // 工作区切换 = 诊断目标变化（adapterId/凭据键名/连通性 baseUrl 随工作区 car.config）
  }, [load, runDoctor, selected?.id])

  const save = async () => {
    setError(null)
    setStatus(null)
    try {
      // K5-F：模型列表（去空行；首行 = 装配锚点）；Key 留空 = 沿用已存加密 Key（改模型不重输 Key）
      const list = models.map((m) => ({ id: m.id.trim(), win: m.win.trim() })).filter((m) => m.id)
      if (!list.length) throw new Error('CAR-E-DESKTOP: 至少填写一个模型 ID（首行为装配锚点）')
      const ep = await window.car.credentialsSave({
        baseUrl: baseUrl.trim(),
        adapterId,
        models: list.map((m) => ({
          id: m.id,
          // 窗口单位换算：输入框标签是「窗口 k」，宿主 contextWindow 是 token 绝对值（1018 终验红条）
          ...(m.win ? { contextWindow: Number(m.win) * 1000 } : {}),
        })),
        ...(key.trim() ? { key: key.trim() } : {}),
      })
      setEndpoint(ep)
      setModels(ep.models.map((m) => ({ id: m.id, win: m.contextWindow ? String(Math.round(m.contextWindow / 1000)) : '' })))
      setKey('') // Key 不回显（值不打印红线）
      setStatus(key.trim() ? '端点已保存（safeStorage 加密）并推宿主装配——新会话生效' : '端点已更新（沿用已存 Key）并推宿主装配——新会话生效')
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

      <h3>自定义模型端点（一个 URL 配多个模型）</h3>
      {endpoint && (
        <div className="banner ok">
          已配置：<code className="mono">{endpoint.baseUrl}</code>
          {` · ${endpoint.adapterId === 'anthropic' ? 'Anthropic 形态' : 'OpenAI 兼容'}`}
          {` · 模型：${endpoint.models.map((m) => m.id + (m.contextWindow ? `(${Math.round(m.contextWindow / 1000)}k)` : '')).join('、')}`}
        </div>
      )}
      <div className="row wrap">
        <select value={adapterId} onChange={(e) => setAdapterId(e.target.value === 'anthropic' ? 'anthropic' : 'openai-compat')} style={{ width: 150 }} title="适配器族：OpenAI 兼容 = /chat/completions；Anthropic = /v1/messages（Claude Code 型网关，baseUrl 不带 /v1）">
          <option value="openai-compat">OpenAI 兼容</option>
          <option value="anthropic">Anthropic 形态</option>
        </select>
        <input className="grow mono" placeholder={adapterId === 'anthropic' ? 'Base URL（https://… 不带 /v1）' : 'Base URL（https://… OpenAI 兼容）'} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        <input placeholder="API Key（已存可留空——沿用）" type="password" value={key} style={{ width: 170 }} onChange={(e) => setKey(e.target.value)} />
      </div>
      <div style={{ margin: '8px 0' }}>
        <div className="dim" style={{ marginBottom: 4 }}>模型列表（首行为装配锚点——新建会话的默认模型；窗口 k 可选，声明后选中即武装 ctx 百分比与压缩阈值）</div>
        {models.map((m, i) => (
          <div key={i} className="row wrap" style={{ marginBottom: 4 }}>
            <input className="mono" placeholder={`模型 ID${i === 0 ? '（锚点）' : ''}`} value={m.id} style={{ width: 240 }} onChange={(e) => setModels(models.map((x, j) => (j === i ? { ...x, id: e.target.value } : x)))} />
            <input placeholder="窗口 k（可选）" value={m.win} style={{ width: 110 }} onChange={(e) => setModels(models.map((x, j) => (j === i ? { ...x, win: e.target.value.replace(/[^0-9]/g, '') } : x)))} />
            {i === 0 ? (
              <button className="btn" onClick={() => setModels([...models, { id: '', win: '' }])} title="追加模型（同一 URL 下的另一个模型 ID）">＋ 模型</button>
            ) : (
              <button className="btn danger" onClick={() => setModels(models.filter((_, j) => j !== i))} title="移除该模型">✕</button>
            )}
          </div>
        ))}
      </div>
      <div className="row wrap">
        <button
          className="btn primary"
          disabled={!baseUrl.trim() || models.every((m) => !m.id.trim()) || (!key.trim() && !endpoint)}
          onClick={() => void save()}
          title="保存 = safeStorage 加密落盘 + 推宿主装配（新会话生效）；首次保存必须填 Key，之后更新模型列表可留空沿用"
        >
          保存并使用
        </button>
        <button className="btn danger" disabled={!endpoint} onClick={() => void clear()}>
          清除端点
        </button>
      </div>
      <p className="dim">优先级 = 自定义端点 &gt; car.config llm（R-D6）· Key 经 safeStorage 加密（首次必填，之后更新可留空沿用）、解密后仅内存推宿主装配（不落盘、不回显、不打印）· Anthropic 形态 = Claude Code 型网关（商汤等）：baseUrl 不带 /v1、Key 走 ANTHROPIC_API_KEY 通道 · 窗口声明可选——无值时该模型 ctx 百分比不显示、压缩 token 阈值不武装（禁估算）。</p>

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
