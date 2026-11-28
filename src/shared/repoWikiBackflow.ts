/**
 * v0.19 C1 · RW-2 知识回流文本装配（纯函数面，零 Electron 零 Node——渲染层/宿主共用）
 *
 * 口径（D-46 修订版红线——「有据可查的选择性注入」）：
 *  - **固定摘要 + 显式引用，非召回式注入**：不建索引、不做相关性筛选——总览页 = 固定定长
 *    注入（开关缺省关）；页面引用 = 用户显式 @动作，零自动召回；
 *  - 注入事实每次落链（meta.injection='repo-wiki' / 'wiki-page'——沿 WB-2L 个性化注入先例，
 *    EventKind 零新增）；sha256 provenance 落 meta（LF-1 回执自含同族——审计可回查注入版本）；
 *  - 总览注入 = 00 总览页正文定长预算头截断（超限为防御面非常态）；页面引用 = 单页上限
 *    头截断 + 截断标记（fail-visible 语义：truncated 落 meta，禁静默截断）；
 *  - 装配确定性 = chainNeedsConstantInjection 三判据同源（文本变 → 下一 turn 重注入）。
 */

/** D-V19-3：总览注入预算（00 总览页生成态远小于此——截断为防御面非常态） */
export const REPO_WIKI_OVERVIEW_BUDGET = 4000

/** D-V19-4：@页面引用单页注入上限（页生成态 ≤24k——引用面取头窗，全文经页面视图人读） */
export const REPO_WIKI_PAGE_REF_CAP = 12000

export const TRUNCATION_MARKER = '\n\n……〔截断〕'

/** 注入态（宿主装配产出——session-handle 落链消费；null = 未启用/页面缺失 = 零注入） */
export interface RepoWikiBackflowState {
  wsId: string
  pageId: '00'
  /** 注入文本（含装配头——确定性渲染，chainNeedsConstantInjection 对账键） */
  text: string
  /** 注入文本 sha256（回执自含——审计可回查注入版本） */
  pageSha256: string
  bytes: number
  truncated: boolean
}

export interface WikiPageContent {
  pageId: string
  title: string
  md: string
}

/** 头截断：超预算 = 头窗 + 截断标记（truncated 显性落 meta） */
export function truncateHead(text: string, budget: number): { text: string; truncated: boolean } {
  if (text.length <= budget) return { text, truncated: false }
  return { text: text.slice(0, budget) + TRUNCATION_MARKER, truncated: true }
}

/** 00 总览页注入装配（总览头 + 定长预算——固定摘要形态） */
export function buildOverviewInjectionText(md: string, budget = REPO_WIKI_OVERVIEW_BUDGET): { text: string; truncated: boolean } {
  const body = md.trim()
  const head = '## RepoWiki · 00 项目总览（知识回流 · 固定摘要）'
  const t = truncateHead(body, budget)
  return { text: `${head}\n\n${t.text}`, truncated: t.truncated }
}

/** @页面引用注入装配（页面头 + 单页上限——显式引用形态） */
export function assembleWikiPageRefText(page: WikiPageContent, cap = REPO_WIKI_PAGE_REF_CAP): { text: string; truncated: boolean } {
  const t = truncateHead(page.md.trim(), cap)
  return { text: `## ${page.title}（RepoWiki 页面 ${page.pageId}）\n\n${t.text}`, truncated: t.truncated }
}
