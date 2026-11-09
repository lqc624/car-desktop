/**
 * 文件查看器（T-FV / 原型 fv-mask 复刻）共享纯函数：扩展名分类 + CSV 表格预览解析。
 * 双侧共用（宿主判定读取形态 / 渲染层渲染分支），零依赖。
 * 读取纪律 = fs_read 同管线（宿主侧复用 fsReadTool：二进制拒读 / 256KB 截断 / redact 脱敏——K-FS-4）；
 * binary 类（pdf/xlsx/图片等）不读内容——仅 stat 元信息 + 系统打开（xlsx 不引入解析依赖：npm `xlsx`
 * 包历史 CVE，audit 门风险；csv 原生表格预览）。
 */

export type FilePreviewKind = 'text' | 'csv' | 'html' | 'binary'

/** 文本类扩展名（走 fs_read 管线读内容）——查看器口径（比附件 fulltext 面更宽，含 ini/toml/env 等） */
const TEXT_EXTS = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonc', '.yml', '.yaml', '.xml', '.ini', '.cfg', '.conf', '.toml', '.log',
  '.env', '.env.example', '.gitignore', '.gitattributes', '.license',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.css', '.scss', '.less',
  '.py', '.go', '.rs', '.java', '.c', '.h', '.cpp', '.hpp', '.sh', '.sql',
])

const CSV_EXTS = new Set(['.csv', '.tsv'])
const HTML_EXTS = new Set(['.html', '.htm'])

/**
 * 系统打开拒绝面（可执行/脚本——chat 产出路径双击 = 误执行面；查看器仅供预览，
 * 内容照常可读）。.js/.reg 等 Windows 可被解释执行的扩展一并拦。
 */
const EXECUTABLE_OPEN_EXTS = new Set([
  '.exe', '.bat', '.cmd', '.msi', '.ps1', '.scr', '.com', '.jar', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.lnk', '.reg',
])

export function extOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name
  const i = base.lastIndexOf('.')
  return i <= 0 ? '' : base.slice(i).toLowerCase()
}

export function classifyPreviewFile(name: string): FilePreviewKind {
  const ext = extOf(name)
  if (CSV_EXTS.has(ext)) return 'csv'
  if (HTML_EXTS.has(ext)) return 'html'
  if (TEXT_EXTS.has(ext)) return 'text'
  return 'binary'
}

export function isExecutableOpenBlocked(name: string): boolean {
  return EXECUTABLE_OPEN_EXTS.has(extOf(name))
}

export function previewCsvDelimiter(name: string): string {
  return extOf(name) === '.tsv' ? '\t' : ','
}

/** 类型图标（原型 fv-ico 同款 emoji 面） */
export function previewIconOf(name: string): string {
  const ext = extOf(name)
  if (ext === '.md' || ext === '.markdown') return '📝'
  if (HTML_EXTS.has(ext)) return '🌐'
  if (CSV_EXTS.has(ext) || ext === '.xlsx' || ext === '.xls') return '📊'
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp'].includes(ext)) return '🖼️'
  return '📄'
}

/** 元信息字节格式（3.8 KB / 284 KB / 1.9 MB——原型 meta 同款） */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * 工作区相对路径 → 绝对路径（渲染层无 node:path——词法解析，Windows 盘符优先；
 * 与宿主 fsReadTool 的 path.isAbsolute 判定同口径）。
 */
export function resolveViewerPath(root: string, rawPath: string): string {
  if (/^[a-za-z]:[\\/]/i.test(rawPath) || rawPath.startsWith('\\\\') || rawPath.startsWith('/')) return rawPath
  const sep = root.includes('/') && !root.includes('\\') ? '/' : '\\'
  return root.replace(/[\\/]+$/, '') + sep + rawPath.replace(/^[\\/]+/, '')
}

export interface CsvPreview {
  rows: string[][]
  totalRows: number
  truncated: boolean
}

/**
 * RFC4180 近似解析（引号字段含逗号/换行/"" 转义；CRLF/CR/LF 均为一行界）——预览面 only，
 * 完整内容以系统程序打开为准（原型脚注口径）。返回前 maxRows 行 + 真实行数（禁伪造总数）。
 */
export function parseCsvPreview(text: string, maxRows = 20, delimiter = ','): CsvPreview {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let total = 0
  const pushField = (): void => {
    row.push(field)
    field = ''
  }
  const pushRow = (): void => {
    pushField()
    total++
    if (rows.length < maxRows) rows.push(row)
    row = []
  }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += c
      }
    } else if (c === '"') {
      inQuotes = true
    } else if (c === delimiter) {
      pushField()
    } else if (c === '\n') {
      pushRow()
    } else if (c === '\r') {
      if (text[i + 1] === '\n') i++
      pushRow()
    } else {
      field += c
    }
  }
  if (field !== '' || row.length > 0) pushRow()
  return { rows, totalRows: total, truncated: total > rows.length }
}
