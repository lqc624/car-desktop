import { useCallback, useEffect, useState } from 'react'
import type { DoctorRowDTO, EndpointListDTO, ModelMetaDTO, WorkspaceInfo } from '../../shared/ipc-contract'

/**
 * S4-S2 设置/诊断（立项书 F-D5）：doctor 全项（凭据在位/LLM 连通性/seam——值不打印）
 * + 自定义模型端点（Base URL + Model ID + Key + 可选上下文窗口声明——safeStorage 加密落盘，
 * Key 经 main 解密后内存推宿主装配；渲染层只见「已配置」态，Key 永不回显——N-D1）。
 * K6-ME（多端点）：端点列表（各槽各 URL 各 Key）+ 新增/编辑/删除/切换使用中；save 即激活。
 */

export function SettingsView({ selected, onEndpointChanged }: { selected?: WorkspaceInfo | null; onEndpointChanged?: () => void }) {
  const [rows, setRows] = useState<DoctorRowDTO[] | null>(null)
  const [epList, setEpList] = useState<EndpointListDTO | null>(null)
  const [meta, setMeta] = useState<Record<string, ModelMetaDTO> | null>(null)
  // 编辑器状态：editingId = null → 新增模式；非空 → 编辑该槽（save 带 endpointId，Key 可留空沿用）
  const [editingId, setEditingId] = useState<string | null>(null)
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
      const list = await window.car.credentialsList()
      setEpList(list)
      // 编辑中槽被外部删除（另一窗/清空）→ 表单回到新增模式
      setEditingId((cur) => (cur && list.endpoints.some((e) => e.id === cur) ? cur : null))
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

  /** 编辑某槽：表单回填（Key 永不回显——留空即沿用） */
  const startEdit = (id: string) => {
    const ep = epList?.endpoints.find((e) => e.id === id)
    if (!ep) return
    setEditingId(ep.id)
    setBaseUrl(ep.baseUrl)
    setAdapterId(ep.adapterId)
    setModels(ep.models.map((m) => ({ id: m.id, win: m.contextWindow ? String(Math.round(m.contextWindow / 1000)) : '' })))
    setKey('')
    setError(null)
    setStatus(null)
  }

  /** 新增模式：清空表单 */
  const startAdd = () => {
    setEditingId(null)
    setBaseUrl('')
    setAdapterId('openai-compat')
    setModels([{ id: '', win: '' }])
    setKey('')
    setError(null)
    setStatus(null)
  }

  const save = async () => {
    setError(null)
    setStatus(null)
    try {
      // K5-F：模型列表（去空行；首行 = 装配锚点）；Key 留空 = 沿用该端点已存加密 Key（改模型不重输 Key）
      const list = models.map((m) => ({ id: m.id.trim(), win: m.win.trim() })).filter((m) => m.id)
      if (!list.length) throw new Error('CAR-E-DESKTOP: 至少填写一个模型 ID（首行为装配锚点）')
      const ep = await window.car.credentialsSave({
        ...(editingId ? { endpointId: editingId } : {}),
        baseUrl: baseUrl.trim(),
        adapterId,
        models: list.map((m) => ({
          id: m.id,
          // 窗口单位换算：输入框标签是「窗口 k」，宿主 contextWindow 是 token 绝对值（1018 终验红条）
          ...(m.win ? { contextWindow: Number(m.win) * 1000 } : {}),
        })),
        ...(key.trim() ? { key: key.trim() } : {}),
      })
      setEditingId(ep.id ?? null)
      setKey('') // Key 不回显（值不打印红线）
      await load()
      setStatus('端点已保存（safeStorage 加密）并推宿主装配——新会话生效')
      onEndpointChanged?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const removeEndpoint = async (id: string) => {
    setError(null)
    setStatus(null)
    try {
      const r = await window.car.credentialsRemove(id)
      if (editingId === id) startAdd()
      await load()
      setStatus(r.activeId ? '端点已删除——装配切换至剩余第一项' : '端点已删除——装配回退 car.config llm')
      onEndpointChanged?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const activate = async (id: string) => {
    setError(null)
    setStatus(null)
    try {
      await window.car.credentialsActivate(id)
      await load()
      setStatus('已切换使用端点并推宿主装配——新会话生效')
      onEndpointChanged?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const clearAll = async () => {
    setError(null)
    setStatus(null)
    try {
      await window.car.credentialsClear()
      startAdd()
      await load()
      setStatus('已清除全部端点——装配回退 car.config llm')
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

      <h3>自定义模型端点（多端点——一个 URL 一个端点，各配各的模型）</h3>
      {/* K6-ME：端点列表（各槽 id/baseUrl/adapter/模型——不含 Key） */}
      {epList && epList.endpoints.length > 0 && (
        <div style={{ margin: '8px 0' }}>
          {epList.endpoints.map((ep) => {
            const active = ep.id === epList.activeId
            return (
              <div key={ep.id} className={`banner ${active ? 'ok' : ''}`} style={{ margin: '6px 0', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ flex: 1, minWidth: 240 }}>
                  {active && <b>［使用中］</b>}
                  <code className="mono">{ep.baseUrl}</code>
                  {` · ${ep.adapterId === 'anthropic' ? 'Anthropic 形态' : 'OpenAI 兼容'}`}
                  {` · 模型：${ep.models.map((m) => m.id + (m.contextWindow ? `(${Math.round(m.contextWindow / 1000)}k)` : '')).join('、')}`}
                </span>
                {!active && (
                  <button className="btn" onClick={() => void activate(ep.id)} title="切换为使用中（装配推宿主——新会话生效）">
                    设为使用
                  </button>
                )}
                <button className="btn" onClick={() => startEdit(ep.id)} title="编辑该端点（Base URL/模型/Key——Key 留空沿用）">
                  编辑
                </button>
                <button className="btn danger" onClick={() => void removeEndpoint(ep.id)} title="删除该端点；删的是使用中端点时装配回退剩余第一项">
                  删除
                </button>
              </div>
            )
          })}
        </div>
      )}
      <div className="row wrap">
        <button className="btn" onClick={startAdd} title="新增一个自定义端点（不同 URL 各配各的模型）">
          ＋ 新端点
        </button>
        <span className="dim">{editingId ? '正在编辑已有端点' : '正在新增端点（保存后自动设为使用中）'}</span>
      </div>
      <div className="row wrap">
        <select value={adapterId} onChange={(e) => setAdapterId(e.target.value === 'anthropic' ? 'anthropic' : 'openai-compat')} style={{ width: 150 }} title="适配器族：OpenAI 兼容 = /chat/completions；Anthropic = /v1/messages（Claude Code 型网关，baseUrl 不带 /v1）">
          <option value="openai-compat">OpenAI 兼容</option>
          <option value="anthropic">Anthropic 形态</option>
        </select>
        <input className="grow mono" placeholder={adapterId === 'anthropic' ? 'Base URL（https://… 不带 /v1）' : 'Base URL（https://… OpenAI 兼容）'} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        <input placeholder={editingId ? 'API Key（留空沿用该端点已存 Key）' : 'API Key（必填）'} type="password" value={key} style={{ width: 190 }} onChange={(e) => setKey(e.target.value)} />
      </div>
      <div style={{ margin: '8px 0' }}>
        <div className="dim" style={{ marginBottom: 4 }}>模型列表（首行为装配锚点——新建会话的默认模型；窗口 k 可选，声明后选中即武装 ctx 百分比与压缩阈值 floor(k×0.78)——滑窗口径网关建议声明网关口径等效窗口，见 doctor「压缩武装」行）</div>
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
          disabled={!baseUrl.trim() || models.every((m) => !m.id.trim()) || (!key.trim() && !editingId)}
          onClick={() => void save()}
          title="保存 = safeStorage 加密落盘 + 设为使用中 + 推宿主装配（新会话生效）；新增端点必须填 Key，编辑已有端点可留空沿用该端点的 Key"
        >
          {editingId ? '保存并使用' : '新增并使用'}
        </button>
        <button className="btn danger" disabled={!epList || epList.endpoints.length === 0} onClick={() => void clearAll()}>
          清除全部端点
        </button>
      </div>
      <p className="dim">优先级 = 使用中的自定义端点 &gt; car.config llm（R-D6）· 多端点各槽各 Key，均经 safeStorage 加密（新增必填，编辑可留空沿用该槽 Key）、解密后仅内存推宿主装配（不落盘、不回显、不打印）· Anthropic 形态 = Claude Code 型网关（商汤等）：baseUrl 不带 /v1、Key 走 ANTHROPIC_API_KEY 通道 · 窗口声明可选——无值时该模型 ctx 百分比不显示、压缩 token 阈值不武装（禁估算）。</p>

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
