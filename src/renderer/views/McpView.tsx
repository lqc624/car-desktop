import { useCallback, useEffect, useState } from 'react'
import type { McpServerStateDTO, WorkspaceInfo } from '../../shared/ipc-contract'

/**
 * S4-S1 MCP 装载面（只读呈现——立项书 F-D4）：car.config `mcp.servers` 驱动 +
 * McpGateway 双传输状态（stdio / Streamable HTTP，逐 server 隔离）+ 工具清单
 * （mcp_<server>_<tool> 桥——调用过 M3 授权门；远程 server = net 类 → 网络轴判定）。
 */

export function McpView({ selected }: { selected: WorkspaceInfo | null }) {
  const [states, setStates] = useState<McpServerStateDTO[] | null>(null)
  const [tools, setTools] = useState<Array<{ name: string; declaredSideEffect: 'readonly' | 'write' }> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    if (!selected) return
    setError(null)
    setLoading(true)
    try {
      const r = await window.car.mcpList(selected.id)
      setStates(r.states)
      setTools(r.tools)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [selected])

  useEffect(() => {
    setStates(null)
    setTools(null)
    if (selected) void load()
  }, [selected, load])

  return (
    <section className="card viewcard">
      <h2>MCP 服务</h2>
      <p className="dim">
        McpGateway 统一边界 · 本地 stdio + 远程 Streamable HTTP · 工具桥
        <code className="mono"> mcp_&lt;server&gt;_&lt;tool&gt;</code> 一律过 M3 授权门（T-22 缺省
        write）· 远程 server 工具 = net 类 → 安全中心网络规则判定（未命中 = 人审门）。
      </p>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {!selected && <p className="dim">先在侧栏选择工作区（装载源 = 工作区 car.config `mcp.servers`）。</p>}
      {selected && (
        <button className="btn" style={{ margin: '8px 0' }} disabled={loading} onClick={() => void load()}>
          {loading ? '装载中…' : '↻ 重新装载状态'}
        </button>
      )}
      {states !== null && (
        <table className="mtable">
          <thead>
            <tr>
              <th>serverId</th>
              <th>传输</th>
              <th>状态</th>
              <th>URL</th>
              <th>工具数</th>
              <th>备注</th>
            </tr>
          </thead>
          <tbody>
            {states.length === 0 && (
              <tr>
                <td colSpan={6} className="dim">
                  工作区 car.config 未登记 mcp.servers
                </td>
              </tr>
            )}
            {states.map((s) => (
              <tr key={s.serverId}>
                <td>
                  <b>{s.serverId}</b>
                </td>
                <td>{s.transport}</td>
                <td>
                  <span className={`tag ${s.status === 'connected' ? 'ok' : 'err'}`}>{s.status === 'connected' ? '已连接' : '装载失败'}</span>
                </td>
                <td className="mono dim2">{s.url ?? '—'}</td>
                <td>{s.tools.length}</td>
                <td className="dim2">{s.error ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {tools !== null && tools.length > 0 && (
        <>
          <h3>工具清单（过授权门）</h3>
          <table className="mtable">
            <thead>
              <tr>
                <th>桥名</th>
                <th>副作用声明</th>
              </tr>
            </thead>
            <tbody>
              {tools.map((t) => (
                <tr key={t.name}>
                  <td className="mono">{t.name}</td>
                  <td>{t.declaredSideEffect}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  )
}
