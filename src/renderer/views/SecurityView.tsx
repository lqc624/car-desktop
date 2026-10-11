import { useCallback, useEffect, useState } from 'react'
import type { FileRuleDTO, NetworkRuleDTO, SecuritySettings } from '../../shared/ipc-contract'

/**
 * S3-S3 安全中心设置页（对照原型 v0.3；S3-S2/S3-S3 通道消费）：
 * 规则表（首条命中语义——数组序 = 优先级）+ 备份开关/上限 + 新建会话默认策略。
 * 规则编辑 = 工作副本 + 显式「保存变更」（fileSecurity:set 全量替换，宿主校验 fail-visible）。
 */

const TIERS = ['allow', 'ask', 'deny'] as const
type Tier = (typeof TIERS)[number]
const TIER_LABEL: Record<Tier, string> = { allow: '允许', ask: '询问', deny: '拒绝' }
const POLICY_LABEL = { default: '默认安全', session: '会话内放行', readonly: '只读模式' } as const

export function SecurityView() {
  const [rules, setRules] = useState<FileRuleDTO[]>([])
  const [dirty, setDirty] = useState(false)
  const [settings, setSettings] = useState<SecuritySettings | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [newPath, setNewPath] = useState('')
  const [quotaInput, setQuotaInput] = useState('2000')
  const [netRules, setNetRules] = useState<NetworkRuleDTO[]>([])
  const [netPattern, setNetPattern] = useState('')
  const [netTier, setNetTier] = useState<'allow' | 'ask' | 'deny'>('ask')

  const load = useCallback(async () => {
    setError(null)
    try {
      const st = await window.car.fileSecurityGet()
      setRules(st.rules)
      setNetRules(st.networkRules)
      setDirty(false)
      setSettings(await window.car.securitySettingsGet())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (settings) setQuotaInput(String(Math.round(settings.autoBackup.maxTotalBytes / (1024 * 1024))))
  }, [settings])

  const saveRules = async () => {
    setError(null)
    setStatus(null)
    try {
      const st = await window.car.fileSecuritySet({ version: 2, rules, networkRules: netRules })
      setRules(st.rules)
      setNetRules(st.networkRules)
      setDirty(false)
      setStatus(`规则已保存（文件 ${st.rules.length} 条 · 网络 ${st.networkRules.length} 条·首条命中优先）`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const resetRules = async () => {
    setError(null)
    setStatus(null)
    try {
      const st = await window.car.fileSecurityReset()
      setRules(st.rules)
      setNetRules(st.networkRules)
      setDirty(false)
      setStatus('已重置为出厂预设（8 条）')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const addRule = () => {
    const p = newPath.trim()
    if (!p) return
    setRules((prev) => [{ id: 'r-' + Date.now().toString(36), path: p, read: 'ask', write: 'ask', delete: 'ask' }, ...prev])
    setNewPath('')
    setDirty(true)
    setStatus('已添加到顶部（未命中规则时保持现有安全策略；记得保存）')
  }

  const setTier = (i: number, k: 'read' | 'write' | 'delete', v: Tier) => {
    setRules((prev) => prev.map((r, idx) => (idx === i ? { ...r, [k]: v } : r)))
    setDirty(true)
  }
  const move = (i: number, dir: -1 | 1) => {
    setRules((prev) => {
      const j = i + dir
      if (j < 0 || j >= prev.length) return prev
      const next = [...prev]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
    setDirty(true)
  }
  const remove = (i: number) => {
    setRules((prev) => prev.filter((_, idx) => idx !== i))
    setDirty(true)
  }

  const saveSettings = async (patch: Parameters<typeof window.car.securitySettingsSet>[0]) => {
    setError(null)
    setStatus(null)
    try {
      setSettings(await window.car.securitySettingsSet(patch))
      setStatus('设置已保存')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <section className="card viewcard">
      <h2>安全中心</h2>
      <p className="dim">
        按路径分别配置读取、写入和删除权限；未命中规则时保持现有安全策略。判定顺序 = 文件规则 → 会话 grant →
        M3 授权门；规则判决 100% 落审计链。
      </p>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {status && <div className="status">{status}</div>}

      <h3>文件安全规则</h3>
      <div className="row">
        <input
          className="grow"
          placeholder="例如：%USERPROFILE%\.cache\myapp\（尾分隔符 = 目录规则；变量白名单 USERPROFILE/WORKSPACE/APPDATA）"
          value={newPath}
          onChange={(e) => setNewPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && newPath.trim()) addRule()
          }}
        />
        <button className="btn" disabled={!newPath.trim()} onClick={addRule}>
          ＋ 添加（默认询问×3）
        </button>
      </div>
      <p className="dim">规则按从上到下顺序匹配，命中第一条后停止；新规则默认添加到顶部。带尾分隔符 = 目录规则（含子树），不带 = 精确文件规则。</p>
      <div className="rules">
        {rules.map((r, i) => (
          <div key={r.id} className={`rule-row ${i === 0 ? 'first' : ''}`}>
            <span className="idx">{i === 0 ? '最先匹配' : `#${i + 1}`}</span>
            {r.preset && <span className="tag ok">预设</span>}
            <code className="path">{r.path}</code>
            {(['read', 'write', 'delete'] as const).map((k) => (
              <span key={k} className="tier">
                <label>{k === 'read' ? '读取' : k === 'write' ? '写入' : '删除'}</label>
                <select value={r[k]} onChange={(e) => setTier(i, k, e.target.value as Tier)}>
                  {TIERS.map((t) => (
                    <option key={t} value={t}>
                      {TIER_LABEL[t]}
                    </option>
                  ))}
                </select>
              </span>
            ))}
            <span className="ops">
              <button className="mini" title="上移（提高优先级）" disabled={i === 0} onClick={() => move(i, -1)}>
                ▲
              </button>
              <button className="mini" title="下移" disabled={i === rules.length - 1} onClick={() => move(i, 1)}>
                ▼
              </button>
              <button className="mini danger" title="删除规则" onClick={() => remove(i)}>
                ✕
              </button>
            </span>
          </div>
        ))}
      </div>
      <div className="row">
        <button className="btn primary" disabled={!dirty} onClick={() => void saveRules()}>
          {dirty ? '● 保存变更' : '保存变更'}
        </button>
        <button className="btn" onClick={() => void resetRules()}>
          ↺ 重置为默认
        </button>
      </div>

      <h3>网络规则（远程 MCP 工具 · net 类）</h3>
      <div className="row wrap">
        <input className="grow mono" placeholder="域名（example.com / *.example.com）或 URL 前缀（https://api.example.com/v1）" value={netPattern} onChange={(e) => setNetPattern(e.target.value)} />
        <select value={netTier} onChange={(e) => setNetTier(e.target.value as 'allow' | 'ask' | 'deny')}>
          <option value="allow">允许</option>
          <option value="ask">询问</option>
          <option value="deny">拒绝</option>
        </select>
        <button className="btn" disabled={!netPattern.trim()} onClick={() => { setNetRules((prev) => [...prev, { id: 'net-' + Date.now().toString(36), pattern: netPattern.trim(), tier: netTier }]); setNetPattern(''); setDirty(true) }}>
          ＋ 添加（默认{netTier === 'allow' ? '允许' : netTier === 'ask' ? '询问' : '拒绝'}）
        </button>
      </div>
      <p className="dim">首条命中；未命中 = ask（MCP 工具全过人审门）。domain 精确/子域、*.domain 仅子域、URL 前缀精确匹配。</p>
      <div className="rules">
        {netRules.length === 0 && <p className="dim">无网络规则。</p>}
        {netRules.map((r, i) => (
          <div key={r.id} className="rule-row">
            <span className="idx">{i === 0 ? '最先匹配' : '#' + (i + 1)}</span>
            <code className="path">{r.pattern}</code>
            <span className="tier">
              <select value={r.tier} onChange={(e) => { setNetRules((prev) => prev.map((x, xi) => (xi === i ? { ...x, tier: e.target.value as 'allow' | 'ask' | 'deny' } : x))); setDirty(true) }}>
                <option value="allow">允许</option>
                <option value="ask">询问</option>
                <option value="deny">拒绝</option>
              </select>
            </span>
            <span className="ops">
              <button className="mini" disabled={i === 0} onClick={() => { setNetRules((prev) => { const next = [...prev]; [next[i], next[i - 1]] = [next[i - 1], next[i]]; return next }); setDirty(true) }}>▲</button>
              <button className="mini" disabled={i === netRules.length - 1} onClick={() => { setNetRules((prev) => { const next = [...prev]; [next[i], next[i + 1]] = [next[i + 1], next[i]]; return next }); setDirty(true) }}>▼</button>
              <button className="mini danger" onClick={() => { setNetRules((prev) => prev.filter((_, xi) => xi !== i)); setDirty(true) }}>✕</button>
            </span>
          </div>
        ))}
      </div>
      <h3>自动备份</h3>
      {settings && (
        <div className="row wrap">
          <label className="inline">
            <input
              type="checkbox"
              checked={settings.autoBackup.enabled}
              onChange={(e) => void saveSettings({ autoBackup: { enabled: e.target.checked } })}
            />
            fs_write 覆盖前 / fs_delete 删除前自动备份原件（备份失败则变更不落盘——先保后变）
          </label>
          <label className="inline">
            备份总上限
            <input
              type="number"
              min={1}
              max={1024 * 1024}
              value={quotaInput}
              style={{ width: 90 }}
              onChange={(e) => setQuotaInput(e.target.value)}
            />
            MB · LRU 淘汰
            <button
              className="btn"
              onClick={() => void saveSettings({ autoBackup: { maxTotalBytes: Math.max(1, Number(quotaInput) || 1) * 1024 * 1024 } })}
            >
              应用上限
            </button>
          </label>
          <button className="btn" onClick={() => void window.car.openBackupDir()}>
            打开备份目录
          </button>
        </div>
      )}

      <h3>新建会话默认策略</h3>
      {settings && (
        <div className="row">
          <select
            value={settings.sessionDefaultPolicy}
            onChange={(e) => void saveSettings({ sessionDefaultPolicy: e.target.value as 'default' | 'readonly' })}
          >
            <option value="default">默认安全（白名单外弹审批门）</option>
            <option value="readonly">只读模式（写/删一律拒绝留痕）</option>
          </select>
          <span className="dim">「会话内放行」仅可在会话内切换（chat 工具栏策略菜单），不作为出厂默认。</span>
        </div>
      )}
    </section>
  )
}
