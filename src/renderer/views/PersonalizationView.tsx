import { useCallback, useEffect, useState } from 'react'
import {
  TONE_STYLES,
  PERSONA_PROMPT_MAX_CHARS,
  PERSONA_TEXT_MAX_CHARS,
  ADDRESS_NAME_MAX_CHARS,
  isToneStyleId,
  type ToneStyleId,
} from '../../shared/personalization'
import {
  buildUserProfileText,
  isUserProfileEntryKind,
  USER_PROFILE_ENTRY_MAX_CHARS,
  USER_PROFILE_ENTRY_MAX_COUNT,
  USER_PROFILE_TOTAL_MAX_CHARS,
  type UserProfileEntry,
  type UserProfileEntryKind,
} from '../../shared/userProfile'

/**
 * T-MP 个性化面板（WorkBuddy 个性化面板五项对照——2026-11-22 用户裁决）+ 通用行为
 *
 * 五项映射：称呼 → addressName（助手对用户的称呼）· 回复风格 → toneStyle 八档 ·
 * 指令 → customPrompt · 人格设定 → personaText（SOUL.md 形态自由文本）·
 * 长期记忆 → userProfileStore（WB-2 跨工作区 store，profile/convention 两 kind）。
 *
 * 口径：
 *  - **设置存端侧**（userData/personalization.json——本地 config · 不进审计链）；**实时跟随**
 *    （WB-2P：改设置后已开会话下一 turn 生效——注入对账见 session-handle）；指令以 system kind
 *    事件落链进入模型上下文（注入必落链纪律），压缩折叠后重注（风格跨压缩存活）；
 *  - **长期记忆**（userData/user-profile.json——跨工作区）：显式开关**出厂关**（D-46 禁静默
 *    选择性注入——用户显式开启后才有注入），预算 fail-visible（单条 ≤1000 / 条数 ≤16 /
 *    注入渲染实长 ≤4000），关闭或零条目 = 零注入零落链；
 *  - 注入指令计入模型上下文（ctx-pop「风格指令」/「长期记忆」行可见）；
 *  - 「显示文件修改过程」= 渲染显示偏好（全局 localStorage，聊天流 fs_write/fs_delete 工具卡显隐）。
 */

const SHOW_FS_CARDS_KEY = 'car-desktop.showFsCards'

/** 新条目 id（渲染层生成——store 侧 normalizeEntry 亦兜底补发） */
function newEntryId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  } catch { /* 降级时间戳 id */ }
  return 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

const KIND_LABEL: Record<UserProfileEntryKind, string> = { profile: '画像', convention: '约定' }

export function PersonalizationView({
  showFsCards,
  onShowFsCardsChange,
  onStatus,
  onFail,
}: {
  showFsCards: boolean
  onShowFsCardsChange: (next: boolean) => void
  onStatus: (s: string) => void
  onFail: (e: unknown) => void
}) {
  const [addressName, setAddressName] = useState('')
  const [toneStyle, setToneStyle] = useState<ToneStyleId>('default')
  const [customPrompt, setCustomPrompt] = useState('')
  const [personaText, setPersonaText] = useState('')
  const [upEnabled, setUpEnabled] = useState(false)
  const [upEntries, setUpEntries] = useState<UserProfileEntry[]>([])
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const s = await window.car.personalizationGet()
        const up = await window.car.userProfileGet()
        if (cancelled) return
        setAddressName(typeof s.addressName === 'string' ? s.addressName : '')
        setToneStyle(isToneStyleId(s.toneStyle) ? s.toneStyle : 'default')
        setCustomPrompt(s.customPrompt)
        setPersonaText(typeof s.personaText === 'string' ? s.personaText : '')
        setUpEnabled(up.enabled)
        setUpEntries(up.entries.filter((e) => isUserProfileEntryKind(e.kind)))
        setDirty(false)
      } catch (e) {
        if (!cancelled) onFail(e)
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const save = useCallback(async () => {
    if (saving) return
    setSaving(true)
    try {
      await window.car.personalizationSet({ addressName, toneStyle, customPrompt, personaText })
      await window.car.userProfileSet({
        enabled: upEnabled,
        entries: upEntries.map((e) => ({ id: e.id, kind: e.kind, text: e.text })),
      })
      setDirty(false)
      onStatus('已保存（本地 config · 不进审计链）· 实时跟随：已开会话下一 turn 生效（新会话同款）')
    } catch (e) {
      onFail(e)
    } finally {
      setSaving(false)
    }
  }, [addressName, toneStyle, customPrompt, personaText, upEnabled, upEntries, saving, onStatus, onFail])

  const over = customPrompt.length > PERSONA_PROMPT_MAX_CHARS
  const nameOver = addressName.length > ADDRESS_NAME_MAX_CHARS
  const personaOver = personaText.length > PERSONA_TEXT_MAX_CHARS
  // 长期记忆预算面（与 store set 校验同口径——渲染实长 fail-visible，超限禁保存）
  const entryOver = upEntries.some((e) => e.text.length > USER_PROFILE_ENTRY_MAX_CHARS)
  const countOver = upEntries.length > USER_PROFILE_ENTRY_MAX_COUNT
  const renderedLen = buildUserProfileText({ enabled: upEnabled, entries: upEntries }).length
  const totalOver = renderedLen > USER_PROFILE_TOTAL_MAX_CHARS
  const upBlocked = entryOver || countOver || totalOver

  const updateEntry = (id: string, patch: Partial<Pick<UserProfileEntry, 'kind' | 'text'>>) => {
    setUpEntries((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch, updatedAt: Date.now() } : e)))
    setDirty(true)
  }
  const addEntry = (kind: UserProfileEntryKind) => {
    setUpEntries((prev) => [...prev, { id: newEntryId(), kind, text: '', updatedAt: Date.now() }])
    setDirty(true)
  }
  const removeEntry = (id: string) => {
    setUpEntries((prev) => prev.filter((e) => e.id !== id))
    setDirty(true)
  }

  return (
    <section className="card viewcard">
      <h2>个性化</h2>
      <p className="dim">
        称呼 / 回复风格 / 指令 / 人格设定存端侧（本地 config · 不进审计链）· <b>实时跟随</b>（改设置后已开会话下一 turn 生效）·
        指令以 system 事件落会话链进入模型上下文（注入必落链），压缩折叠后自动重注 · 注入文本在 ctx-pop「风格指令」行可见 ·
        长期记忆为跨工作区伴生面（显式开启后注入，出厂关；关闭后停止新增，旧注入随前缀保留）。
      </p>

      <div className="ps-card">
        <h3>称呼</h3>
        <input
          className="mem-input"
          style={{ width: '100%' }}
          placeholder="例如：水生、老板、老师……（助手对你的称呼；留空 = 不注入）"
          value={addressName}
          onChange={(e) => {
            setAddressName(e.target.value)
            setDirty(true)
          }}
        />
        <div className={`ps-count${nameOver ? ' over' : ''}`}>
          {addressName.length} / {ADDRESS_NAME_MAX_CHARS}
          {nameOver && ' —— 超限，请精简后再保存'}
        </div>
      </div>

      <div className="ps-card">
        <h3>回复风格</h3>
        <div className="ps-grid">
          {TONE_STYLES.map((t) => (
            <button
              key={t.id}
              className={`ps-tile${toneStyle === t.id ? ' sel' : ''}`}
              onClick={() => {
                setToneStyle(t.id)
                setDirty(true)
              }}
              title={t.directive || '不注入风格指令'}
            >
              <b>{t.label}</b>
              <small>{t.desc}</small>
            </button>
          ))}
        </div>
      </div>

      <div className="ps-card">
        <h3>指令</h3>
        <textarea
          className="mem-textarea"
          style={{ minHeight: 96 }}
          placeholder="例如：回答一律用中文；代码注释用英文；先给可运行的最小实现……（应用于新会话）"
          value={customPrompt}
          onChange={(e) => {
            setCustomPrompt(e.target.value)
            setDirty(true)
          }}
        />
        <div className={`ps-count${over ? ' over' : ''}`}>
          {customPrompt.length} / {PERSONA_PROMPT_MAX_CHARS}
          {over && ' —— 超限，请精简后再保存'}
        </div>
      </div>

      <div className="ps-card">
        <h3>人格设定</h3>
        <textarea
          className="mem-textarea"
          style={{ minHeight: 96 }}
          placeholder="例如：冷静、有主见、不捧场；先给结论再给证据；对营销话术直接指出；不用表情符号……（助手基调，长期有效）"
          value={personaText}
          onChange={(e) => {
            setPersonaText(e.target.value)
            setDirty(true)
          }}
        />
        <div className={`ps-count${personaOver ? ' over' : ''}`}>
          {personaText.length} / {PERSONA_TEXT_MAX_CHARS}
          {personaOver && ' —— 超限，请精简后再保存'}
        </div>
      </div>

      <div className="ps-card">
        <h3>长期记忆（跨工作区）</h3>
        <p className="dim" style={{ marginTop: 0 }}>
          对本机所有工作区的会话生效（userData 级存储）· 画像 = 你是谁/常用栈/项目上下文；约定 = 跨项目通行的纪律与偏好 ·
          <b>显式开启后</b>以 system 事件落会话链（出厂关——禁静默注入）· 实时跟随（改设置后已开会话下一 turn 生效）· ctx-pop「长期记忆」行可见。
        </p>
        <label className="ps-toggle">
          <input
            type="checkbox"
            checked={upEnabled}
            onChange={(e) => {
              setUpEnabled(e.target.checked)
              setDirty(true)
            }}
          />
          <span>
            启用长期记忆注入
            <small>开启后新会话每轮上下文常驻记忆文本（关闭 = 零注入零落链）</small>
          </span>
        </label>

        {upEntries.map((e) => {
          const eOver = e.text.length > USER_PROFILE_ENTRY_MAX_CHARS
          return (
            <div key={e.id} style={{ marginTop: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <button
                  className="btn"
                  style={{ padding: '1px 10px', fontSize: 12 }}
                  title="点击切换条目种类（画像 / 约定）"
                  onClick={() => updateEntry(e.id, { kind: e.kind === 'profile' ? 'convention' : 'profile' })}
                >
                  {KIND_LABEL[e.kind]}
                </button>
                <span className={`ps-count${eOver ? ' over' : ''}`} style={{ flex: 1 }}>
                  {e.text.length} / {USER_PROFILE_ENTRY_MAX_CHARS}
                </span>
                <button className="btn" style={{ padding: '1px 10px', fontSize: 12 }} onClick={() => removeEntry(e.id)}>
                  删除
                </button>
              </div>
              <textarea
                className="mem-textarea"
                style={{ minHeight: 56 }}
                placeholder={e.kind === 'profile' ? '例如：称呼「水生」；主力栈 TypeScript / Python；正在做 CAR 桌面端……' : '例如：回答一律用中文；GitHub 克隆走国内镜像；给用户的 .bat 必须纯 ASCII……'}
                value={e.text}
                onChange={(ev) => updateEntry(e.id, { text: ev.target.value })}
              />
            </div>
          )
        })}

        <div className="mem-ops" style={{ marginTop: 10 }}>
          <button className="btn" disabled={upEntries.length >= USER_PROFILE_ENTRY_MAX_COUNT} onClick={() => addEntry('profile')}>
            + 画像条目
          </button>
          <button className="btn" disabled={upEntries.length >= USER_PROFILE_ENTRY_MAX_COUNT} onClick={() => addEntry('convention')}>
            + 约定条目
          </button>
        </div>
        <div className={`ps-count${countOver || totalOver ? ' over' : ''}`} style={{ marginTop: 6 }}>
          {upEntries.length} / {USER_PROFILE_ENTRY_MAX_COUNT} 条
          {upEnabled ? ` · 注入渲染 ${renderedLen} / ${USER_PROFILE_TOTAL_MAX_CHARS} 字符` : ' · 未启用（零注入）'}
          {countOver && ' —— 条数超限'}
          {totalOver && ' —— 注入总量超预算'}
        </div>
      </div>

      <div className="ps-card">
        <h3>通用行为</h3>
        <label className="ps-toggle">
          <input
            type="checkbox"
            checked={showFsCards}
            onChange={(e) => onShowFsCardsChange(e.target.checked)}
          />
          <span>
            显示文件修改过程
            <small>聊天流展示 fs_write / fs_delete 工具卡（关闭仅隐藏卡片——审计流水页恒全量可查；端侧偏好不落链）</small>
          </span>
        </label>
      </div>

      <div className="mem-ops">
        <button className="btn primary" disabled={over || nameOver || personaOver || upBlocked || saving || (!dirty && !over && !nameOver && !personaOver && !upBlocked)} onClick={() => void save()}>
          {saving ? '保存中…' : '保存设置'}
        </button>
        <span className="dim">已保存（本地 config · 不进审计链）· 应用于新会话</span>
      </div>
    </section>
  )
}
