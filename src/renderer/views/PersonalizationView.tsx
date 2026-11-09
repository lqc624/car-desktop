import { useCallback, useEffect, useState } from 'react'
import { TONE_STYLES, PERSONA_PROMPT_MAX_CHARS, isToneStyleId, type ToneStyleId } from '../../shared/personalization'

/**
 * T-MP 个性化面板（原型 v-persona 复刻——适配 CAR 口径）
 *
 * 口径：
 *  - **设置存端侧**（userData/personalization.json——本地 config · 不进审计链）；**应用于新会话**
 *    （创建时快照——改设置不影响已开会话）；指令以 system kind 事件落链进入模型上下文
 *    （注入必落链纪律），压缩折叠后按快照重注（风格跨压缩存活）；
 *  - 注入指令计入模型上下文（ctx-pop「风格指令」行可见）；
 *  - 「显示文件修改过程」= 渲染显示偏好（全局 localStorage，聊天流 fs_write/fs_delete 工具卡显隐）；
 *  - 原型「等待问候」（企业版死控件）与「本地记忆文件」（MemoryView 已覆盖）不纳入。
 */

const SHOW_FS_CARDS_KEY = 'car-desktop.showFsCards'

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
  const [toneStyle, setToneStyle] = useState<ToneStyleId>('default')
  const [customPrompt, setCustomPrompt] = useState('')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const s = await window.car.personalizationGet()
        if (cancelled) return
        setToneStyle(isToneStyleId(s.toneStyle) ? s.toneStyle : 'default')
        setCustomPrompt(s.customPrompt)
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
      await window.car.personalizationSet({ toneStyle, customPrompt })
      setDirty(false)
      onStatus('已保存（本地 config · 不进审计链）· 应用于新会话——已有会话保持创建时快照')
    } catch (e) {
      onFail(e)
    } finally {
      setSaving(false)
    }
  }, [toneStyle, customPrompt, saving, onStatus, onFail])

  const over = customPrompt.length > PERSONA_PROMPT_MAX_CHARS

  return (
    <section className="card viewcard">
      <h2>个性化</h2>
      <p className="dim">
        回复风格与自定义指令存端侧（本地 config · 不进审计链）· <b>应用于新会话</b>（创建时快照，已有会话不受影响）·
        指令以 system 事件落会话链进入模型上下文（注入必落链），压缩折叠后自动重注 · 注入文本在 ctx-pop「风格指令」行可见。
      </p>

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
        <h3>自定义指令</h3>
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
        <button className="btn primary" disabled={over || saving || (!dirty && !over)} onClick={() => void save()}>
          {saving ? '保存中…' : '保存设置'}
        </button>
        <span className="dim">已保存（本地 config · 不进审计链）· 应用于新会话</span>
      </div>
    </section>
  )
}
