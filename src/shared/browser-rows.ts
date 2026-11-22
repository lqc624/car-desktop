/**
 * B-2 · 浏览器叙事行构造（纯函数——App 主面渲染；AuditView 全量面不动）
 *
 * 口径：browser/* 落链叙事此前仅审计页可见（B-1 登记缺口）——B-2 补主面分支；
 * 页面内容不进链（bash 输出同纪律），行面只呈现动作/状态/元数据。
 */

export interface BrowserRow {
  tone: 'dim' | 'warn' | 'ok'
  text: string
}

export function browserRow(type: string, p: Record<string, unknown>): BrowserRow | null {
  switch (type) {
    case 'browser/start':
      return { tone: 'dim', text: `浏览器导航 → ${String(p['url'] ?? '?')}（browser/start 已落链）` }
    case 'browser/exit':
      return {
        tone: p['reason'] === 'error' || p['reason'] === 'aborted' ? 'warn' : 'dim',
        text: `浏览器收口 · ${String(p['reason'] ?? '?')}（${String(p['durationMs'] ?? '?')}ms——browser/exit 已落链）`,
      }
    case 'browser/read':
      return {
        tone: 'dim',
        text: `页面读取 ${String(p['chars'] ?? '?')} 字符${p['truncated'] === true ? '（256KB 截断标注）' : ''}——内容不进链（redact 纪律）`,
      }
    case 'browser/act':
      return {
        tone: p['status'] === 'error' ? 'warn' : 'dim',
        text: `浏览器动作 ${String(p['action'] ?? '?')} → ${String(p['target'] ?? '?')} · ${String(p['status'] ?? '?')}${p['hitl'] === true ? ' · HITL 接管' : ''}（browser/act 已落链）`,
      }
    case 'browser/hitl':
      return {
        tone: p['phase'] === 'timeout' ? 'warn' : 'dim',
        text: `接管协议 ${String(p['phase'] ?? '?')}${p['reason'] ? ` · ${String(p['reason'])}` : ''}（browser/hitl 已落链——确定性特征探测非 LLM）`,
      }
    case 'browser/shot':
      return {
        tone: 'dim',
        text: `页面截图 ${String(p['shotId'] ?? '?')} · ${String(p['pngBytes'] ?? '?')}B${p['textTruncated'] === true ? ' · 摘录 256KB 截断' : ''}（browser/shot 已落链——PNG 字节不进链，判定走 visual 档）`,
      }
    case 'browser/verdict': {
      if (p['verdictUnparsed'] === true) {
        return {
          tone: 'warn',
          text: `视觉验收 verdict 未按契约解析（${String(p['subagentId'] ?? '?')}）——fail-visible，主面禁复判（§4.8）`,
        }
      }
      const pass = Number(p['passCount'] ?? 0)
      const fail = Number(p['failCount'] ?? 0)
      return {
        tone: fail > 0 ? 'warn' : 'dim',
        text: `视觉验收 verdict · pass ${pass} / fail ${fail}${fail > 0 ? '（判定 fail ≠ 工具执行 fail——两态分立）' : ''}（browser/verdict 已落链——即视觉门结果）`,
      }
    }
    default:
      return null
  }
}
