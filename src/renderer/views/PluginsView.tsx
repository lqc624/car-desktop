import { useCallback, useEffect, useState } from 'react'
import type { PluginStateDTO, WorkspaceInfo } from '../../shared/ipc-contract'

/**
 * S4-S1 插件装载面（只读呈现——立项书 F-D4）：登记管理（userData/plugin-paths.json）+
 * 装载状态（mountPlugin 真实结果组合呈现——verify/topo 标注 SKIPPED，K-S4-1 候选登记）+
 * 工具清单（T-22 缺省 write——工具调用过 M3 授权门留痕）。
 */

export function PluginsView({ selected }: { selected: WorkspaceInfo | null }) {
  const [registrations, setRegistrations] = useState<Array<{ id: string; file: string; manifest: unknown }>>([])
  const [states, setStates] = useState<PluginStateDTO[] | null>(null)
  const [file, setFile] = useState('')
  const [name, setName] = useState('')
  const [version, setVersion] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const r = await window.car.pluginsList()
      setRegistrations(r.registrations)
      setStates(r.states)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const add = async () => {
    setError(null)
    setStatus(null)
    try {
      const r = await window.car.pluginsAdd(file.trim(), { name: name.trim(), version: version.trim() || '1.0.0' })
      setRegistrations(r.registrations)
      setStates(r.states)
      setFile('')
      setName('')
      setVersion('')
      setStatus('已登记——装载发生在下一次会话创建（工作区内生效，工具过 M3 授权门）')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const remove = async (id: string) => {
    setError(null)
    try {
      const r = await window.car.pluginsRemove(id)
      setRegistrations(r.registrations)
      setStates(r.states)
      setStatus('已移除登记（下次会话创建生效）')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <section className="card viewcard">
      <h2>插件</h2>
      <p className="dim">
        装载走内核 mountPlugin 全纪律（manifest 校验 / erasable-only 门 / ApiImpl 收集）· 工具调用一律过
        M3 授权门留痕（T-22：未声明 sideEffect 按最高约束）· 签名门完整报告面随内核候选 K-S4-1。
      </p>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {status && <div className="status">{status}</div>}

      <h3>登记插件</h3>
      <div className="row wrap">
        <input className="grow mono" placeholder="插件模块绝对路径（默认导出 (api) => void）" value={file} onChange={(e) => setFile(e.target.value)} />
        <input placeholder="name" value={name} style={{ width: 140 }} onChange={(e) => setName(e.target.value)} />
        <input placeholder="version" value={version} style={{ width: 100 }} onChange={(e) => setVersion(e.target.value)} />
        <button className="btn primary" disabled={!file.trim() || !name.trim()} onClick={() => void add()}>
          ＋ 登记
        </button>
      </div>

      <h3>装载状态</h3>
      {states === null && <p className="dim">尚未装载（创建会话时发生）。</p>}
      {states?.length === 0 && <p className="dim">无登记插件。</p>}
      {states?.map((s) => (
        <div key={s.id} className={`banner ${s.status === 'loaded' ? 'ok' : 'err'}`}>
          <b>{s.name ?? s.id}</b>
          {s.version && <small> @{s.version}</small>} · <span className="tag">{s.status === 'loaded' ? '已装载' : '装载失败'}</span>
          {s.status === 'loaded' && <div className="dim">工具：{s.tools.length ? s.tools.map((t) => <code key={t}>{t}</code>) : '（无工具注册）'}</div>}
          {s.error && <div className="dim">{s.error}</div>}
          <div className="dim">阶段：discover ✓ · parse ✓ · validate {s.status === 'loaded' ? '✓' : '✕'} · register {s.status === 'loaded' ? '✓' : 'SKIPPED'} · verify/topo SKIPPED（K-S4-1）</div>
        </div>
      ))}

      <h3>登记清单</h3>
      <table className="mtable">
        <thead>
          <tr>
            <th>id</th>
            <th>文件</th>
            <th>manifest</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {registrations.length === 0 && (
            <tr>
              <td colSpan={4} className="dim">
                无登记
              </td>
            </tr>
          )}
          {registrations.map((p) => (
            <tr key={p.id}>
              <td className="mono">{p.id}</td>
              <td className="mono dim2">{p.file}</td>
              <td className="mono">{JSON.stringify(p.manifest)}</td>
              <td>
                <button className="mini danger" onClick={() => void remove(p.id)}>
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="dim">工作区：{selected ? <code>{selected.path}</code> : '未选择（装载为应用级登记，工具随工作区会话生效）'}</p>
    </section>
  )
}
