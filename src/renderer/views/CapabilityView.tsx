import { useCallback, useEffect, useRef, useState } from 'react'
import type { CapabilityEntryDTO, CapabilityKindDTO, CapabilityStatusDTO, WorkspaceInfo } from '../../shared/ipc-contract'

/**
 * T-24 能力库视图（D2-S1 / PRD C-4 React 原生重写——D-C7 iframe 方案关闭）
 *
 * 口径：
 *  - 原型三栏同构：分类树（三分类 + 全部）/ 列表 / 详情；数据经 IPC 读 .car/capabilities/
 *    （白盒目录，同 .car/memory/ 纪律）；CRUD 落链承载 = 活跃会话（无活跃会话 = 操作禁用）；
 *  - 维护中/已退役条目可引用可编辑，状态徽标明示（禁静默）；
 *  - spec 超限 / id 非法 / 重复新建 = 宿主 fail-visible 红条。
 */

const KIND_LABEL: Record<CapabilityKindDTO, string> = { expert: '专家', skill: '技能', kb: '知识包' }
const STATUS_LABEL: Record<CapabilityStatusDTO, string> = { active: '启用', maintain: '维护中', retired: '已退役' }
const ID_RE = /^[a-z0-9-]+$/

const fmtTime = (ts: number): string => new Date(ts).toLocaleString()

interface FormState {
  id: string
  kind: CapabilityKindDTO
  name: string
  version: string
  author: string
  tags: string
  spec: string
  status: CapabilityStatusDTO
}

const emptyForm: FormState = { id: '', kind: 'expert', name: '', version: '', author: '', tags: '', spec: '', status: 'active' }

export function CapabilityView({
  selected,
  openId,
  onFail,
  onStatus,
  onChanged,
}: {
  selected: WorkspaceInfo | null
  openId: string | null
  onFail: (e: unknown) => void
  onStatus: (s: string) => void
  /** 列表变化回调（App 侧引用菜单数据源刷新） */
  onChanged: () => void
}) {
  const [entries, setEntries] = useState<CapabilityEntryDTO[] | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const [kindFilter, setKindFilter] = useState<CapabilityKindDTO | 'all'>('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [form, setForm] = useState<FormState | null>(null)
  const [editId, setEditId] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!selected) return
    try {
      const r = await window.car.capabilityList(selected.id)
      setEntries(r.entries)
      setWarnings(r.warnings)
      onChanged()
    } catch (e) {
      onFail(e)
    }
  }, [selected, onFail, onChanged])
  // 副作用只随工作区切换重置表单/重载——onChanged/onFail 闭包身份不参与依赖（防父渲染重载循环吞表单状态）
  const loadRef = useRef(load)
  loadRef.current = load

  useEffect(() => {
    setEntries(null)
    setWarnings([])
    setSelectedId(null)
    setForm(null)
    setEditId(null)
    if (selected) void loadRef.current()
  }, [selected])

  const detail = entries?.find((e) => e.id === selectedId) ?? null
  const filtered = (entries ?? []).filter((e) => kindFilter === 'all' || e.kind === kindFilter)

  const startCreate = (): void => setForm({ ...emptyForm })
  const startEdit = (e: CapabilityEntryDTO): void => {
    setEditId(e.id)
    setForm({ id: e.id, kind: e.kind, name: e.name, version: e.version ?? '', author: e.author ?? '', tags: (e.tags ?? []).join(','), spec: e.spec, status: e.status })
  }

  const submit = async (): Promise<void> => {
    if (!selected || !openId || !form) return
    try {
      if (editId) {
        await window.car.capabilityEdit(selected.id, openId, editId, {
          name: form.name,
          kind: form.kind,
          spec: form.spec,
          status: form.status,
          ...(form.version ? { version: form.version } : {}),
          ...(form.author ? { author: form.author } : {}),
          ...(form.tags.trim() ? { tags: form.tags.split(/[,，;；\s]+/).filter(Boolean) } : { tags: [] }),
        })
        onStatus(`条目已更新（capability/edit 落链）`)
      } else {
        if (!ID_RE.test(form.id)) throw new Error('条目 id 非法——仅允许小写字母、数字、连字符')
        await window.car.capabilityWrite(selected.id, openId, {
          id: form.id,
          kind: form.kind,
          name: form.name,
          spec: form.spec,
          status: form.status,
          ...(form.version ? { version: form.version } : {}),
          ...(form.author ? { author: form.author } : {}),
          ...(form.tags.trim() ? { tags: form.tags.split(/[,，;；\s]+/).filter(Boolean) } : {}),
        })
        onStatus(`条目已创建（capability/write 落链；白盒文件 .car/capabilities/${form.id}.json）`)
      }
      setForm(null)
      setEditId(null)
      await load()
    } catch (e) {
      onFail(e)
    }
  }

  const remove = async (id: string): Promise<void> => {
    if (!selected || !openId) return
    try {
      await window.car.capabilityDelete(selected.id, openId, id)
      onStatus(`条目已删除（capability/delete 落链）`)
      if (selectedId === id) setSelectedId(null)
      await load()
    } catch (e) {
      onFail(e)
    }
  }

  if (!selected) return <div className="view-empty">先选择工作区</div>

  return (
    <div className="cap-view">
      <div className="cap-tree">
        <div className="cap-title">
          能力库
          <button className="mini" disabled={!openId} onClick={startCreate} title="新建条目（CRUD 落链需活跃会话）">
            ＋ 新建
          </button>
        </div>
        {(['all', 'expert', 'skill', 'kb'] as const).map((k) => (
          <button key={k} className={`item ${kindFilter === k ? 'sel' : ''}`} onClick={() => setKindFilter(k)}>
            <span className="ico">{k === 'all' ? '◈' : '◆'}</span>
            <span>
              <b>{k === 'all' ? '全部条目' : KIND_LABEL[k]}</b>
              <small>{k === 'all' ? (entries ?? []).length : (entries ?? []).filter((e) => e.kind === k).length} 条</small>
            </span>
          </button>
        ))}
        <div className="cap-note">引用 = prompt 注入（纯文本进上下文）——不注册工具、不装载代码（PRD 分界红线）</div>
      </div>
      <div className="cap-list">
        {warnings.map((w) => (
          <div key={w} className="error" role="alert">
            条目载入跳过：{w}
          </div>
        ))}
        {filtered.length === 0 && <div className="empty">暂无条目</div>}
        {filtered.map((e) => (
          <button key={e.id} className={`item ${selectedId === e.id ? 'sel' : ''}`} onClick={() => setSelectedId(e.id)}>
            <span className="ico">◆</span>
            <span>
              <b>
                {e.name}
                {e.status !== 'active' && <small className={`cap-status cap-status-${e.status}`}> {STATUS_LABEL[e.status]}</small>}
              </b>
              <small>
                {KIND_LABEL[e.kind]} · {e.id} · {e.spec.length} 字符
              </small>
            </span>
          </button>
        ))}
      </div>
      <div className="cap-detail">
        {form && (
          <div className="cap-form">
            <div className="cap-title">{editId ? `编辑：${editId}` : '新建条目'}</div>
            {!editId && (
              <input placeholder="id（小写字母数字连字符，即文件名）" value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value })} />
            )}
            <input placeholder="名称" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <div className="cap-form-row">
              <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as CapabilityKindDTO })}>
                {(['expert', 'skill', 'kb'] as const).map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABEL[k]}
                  </option>
                ))}
              </select>
              <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as CapabilityStatusDTO })}>
                {(['active', 'maintain', 'retired'] as const).map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABEL[s]}
                  </option>
                ))}
              </select>
            </div>
            <div className="cap-form-row">
              <input placeholder="版本（可选）" value={form.version} onChange={(e) => setForm({ ...form, version: e.target.value })} />
              <input placeholder="作者（可选）" value={form.author} onChange={(e) => setForm({ ...form, author: e.target.value })} />
            </div>
            <input placeholder="标签（逗号分隔，可选）" value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} />
            <textarea
              placeholder="规范正文（注入物；≤ 20,000 字符，超限 fail-visible）"
              rows={14}
              value={form.spec}
              onChange={(e) => setForm({ ...form, spec: e.target.value })}
            />
            <div className="cap-form-row">
              <span className="dim">{form.spec.length} / 20,000 字符</span>
              <button className="btn" onClick={() => { setForm(null); setEditId(null) }}>
                取消
              </button>
              <button className="btn primary" disabled={!openId || !form.name.trim() || !form.spec.trim()} onClick={() => void submit()}>
                保存（落链）
              </button>
            </div>
            {!openId && <div className="dim">无活跃会话——CRUD 落链需活跃会话（先打开一个会话）</div>}
          </div>
        )}
        {!form && detail && (
          <div className="cap-meta">
            <div className="cap-title-row">
              <b>{detail.name}</b>
              <span className={`cap-status cap-status-${detail.status}`}>{STATUS_LABEL[detail.status]}</span>
            </div>
            <div className="dim">
              {KIND_LABEL[detail.kind]} · {detail.id}
              {detail.version ? ` · v${detail.version}` : ''}
              {detail.author ? ` · ${detail.author}` : ''}
            </div>
            {detail.tags && detail.tags.length > 0 && <div className="cap-tags">{detail.tags.map((t) => <span key={t} className="cap-tag">{t}</span>)}</div>}
            <div className="dim">
              创建 {fmtTime(detail.createdAt)} · 更新 {fmtTime(detail.updatedAt)} · 规范 {detail.spec.length} 字符
            </div>
            <pre className="cap-spec">{detail.spec}</pre>
            <div className="cap-form-row">
              <button className="btn" disabled={!openId} onClick={() => startEdit(detail)}>
                编辑
              </button>
              <button className="btn danger" disabled={!openId} onClick={() => void remove(detail.id)}>
                删除
              </button>
            </div>
          </div>
        )}
        {!form && !detail && <div className="empty">选择条目查看详情</div>}
      </div>
    </div>
  )
}
