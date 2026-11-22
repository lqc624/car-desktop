/**
 * car-browser-mcp · stdio MCP server（B-3 / 提案 §4.4 模块 D——BrowserTaskManager 能力的
 * MCP 封装形态；协议骨架 = 内核 src/host/stdio.ts 形态复刻，零 SDK 手写行协议）
 *
 * 协议面：
 *  - 换行分隔 JSON-RPC 2.0 over stdin/stdout；stderr 只放诊断（协议通道零污染）；
 *  - `initialize` 握手：protocolVersion 回显/缺省 '2024-11-05'（内核 stdio 客户端不发
 *    initialize 直取 tools/list——两形态兼容）；notifications/* 无 id 不响应；
 *  - `tools/list`：{ name, description, sideEffect?, inputSchema? }——sideEffect 为 CAR 私有
 *    扩展（内核消费端 T-22：未声明收敛 write）；browser_open/read = 'readonly'，browser_act
 *    缺省（= write）；
 *  - `tools/call`：成功 { content: [{type:'text', text: JSON}] }；失败 error -32000；
 *    未知方法 -32601；坏 JSON -32700（id:null）；串行派发（callChain）；
 *  - 安全姿态（README 明示）：授权责任上移消费方宿主（桌面 mcp_* 门 / 平台 McpGateway /
 *    第三方客户端策略）——server 自身无人审/网络轴/grant 面，只继承 fail-visible 护栏。
 */
import { createInterface } from 'node:readline'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { BrowserMcpDriver } from './driver.ts'

const PKG_VERSION = '0.1.0'
const PROTOCOL_VERSION_DEFAULT = '2024-11-05'

export interface McpToolSpec {
  name: string
  description: string
  /** CAR 私有扩展（官方 MCP 无此字段——内核消费端读取；标准客户端忽略） */
  sideEffect?: 'readonly' | 'write'
  inputSchema: Record<string, unknown>
  run: (args: Record<string, unknown>) => Promise<unknown>
}

export function buildToolSpecs(driver: BrowserMcpDriver): McpToolSpec[] {
  return [
    {
      name: 'browser_open',
      sideEffect: 'readonly',
      description:
        '在 CAR 受控浏览器窗口导航至 URL（陪伴形态：须桌面受控窗口在场）。' +
        '返回最终 url/title/status。注意：本工具经 MCP 消费时授权与网络轴由宿主承担（server 无内置门）。',
      inputSchema: {
        type: 'object',
        properties: { url: { type: 'string', description: '目标 URL（http/https）' } },
        required: ['url'],
      },
      run: async (args) => driver.open(String(args['url'] ?? '')),
    },
    {
      name: 'browser_read',
      sideEffect: 'readonly',
      description:
        '读取 CAR 受控浏览器当前页面的文本与元信息。返回 provenance 四件套（url/fetchedAt/排序口径/未获取字段）' +
        '+ 正文（脱敏 + 256KB 截断显式标注）。',
      inputSchema: { type: 'object', properties: {} },
      run: async () => driver.read(),
    },
    {
      name: 'browser_act',
      // sideEffect 缺省 = 消费端 T-22 收敛 write（最高约束）——act 声明 write 语义
      description:
        '在 CAR 受控浏览器当前页面执行动作：click（点击）/ type（输入，配 value）/ select（下拉选择，配 value）/' +
        'scroll（滚动）/ wait（等待）。高危动作（提交/支付/发送/删除类）请在宿主侧配置确认门；' +
        '登录页/验证码命中时返回 hitl-detected 报告（独立进程无接管卡面——由用户在受控窗口完成后继续）。',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['click', 'type', 'select', 'scroll', 'wait'], description: '动作类型' },
          selector: { type: 'string', description: 'CSS 选择器（click/type/select/scroll 目标）' },
          text: { type: 'string', description: 'click 备选：按可见文本匹配可点击元素' },
          value: { type: 'string', description: 'type/select 的输入值' },
          x: { type: 'number', description: 'scroll 纵向位移（px，正=下）' },
          y: { type: 'number', description: 'scroll 横向位移（px，正=右）' },
          timeoutMs: { type: 'number', description: 'wait 上限（缺省 5000，≤10000）' },
        },
        required: ['action'],
      },
      run: async (args) => driver.act(args),
    },
  ]
}

export interface ServerOptions {
  cdpPort?: number
  targetTitle?: string
  /** 发现文件主路径（userData/browser-target.json——桌面挂载推荐传参，对齐 findTarget 双路径） */
  targetFile?: string
  driverDeps?: ConstructorParameters<typeof BrowserMcpDriver>[0]
}

/** 串行派发链（tools/call 逐个执行——并发调用排队，内核 host/stdio 同款） */
export function createDispatcher(specs: McpToolSpec[]): (name: string, args: Record<string, unknown>) => Promise<unknown> {
  const byName = new Map(specs.map((s) => [s.name, s]))
  return (name, args) => {
    const spec = byName.get(name)
    if (!spec) throw new Error(`CAR-E-MCP-TOOL: 未知工具（${name}）——tools/list 核对`)
    return spec.run(args)
  }
}

/**
 * 协议循环（行分隔 JSON-RPC 2.0）。可注入 io 供测试（缺省 = process.stdin/stdout 行协议）。
 * 返回收口 promise（stdin 关闭即 resolve——消费端关流 = server 退出）。
 */
export function serve(
  opts: ServerOptions = {},
  io: { input: AsyncIterable<string>; write: (line: string) => void } = {
    input: createInterface({ input: process.stdin }),
    write: (line) => process.stdout.write(line + '\n'),
  },
): { done: Promise<void>; dispatch: (name: string, args: Record<string, unknown>) => Promise<unknown> } {
  const driver = new BrowserMcpDriver({ cdpPort: opts.cdpPort, targetTitle: opts.targetTitle, targetFile: opts.targetFile, ...(opts.driverDeps ?? {}) })
  const specs = buildToolSpecs(driver)
  const dispatch = createDispatcher(specs)
  let callChain: Promise<void> = Promise.resolve()
  const done = (async () => {
    for await (const line of io.input) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let req: { id?: number | null; method?: string; params?: Record<string, unknown> }
      try {
        req = JSON.parse(trimmed) as { id?: number | null; method?: string; params?: Record<string, unknown> }
      } catch {
        io.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }))
        continue
      }
      const id = req.id
      if (id === undefined || id === null) continue // notifications/* 无 id 不响应
      if (req.method === 'initialize') {
        io.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: (req.params as { protocolVersion?: string } | undefined)?.protocolVersion ?? PROTOCOL_VERSION_DEFAULT,
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: 'car-browser-mcp', version: PKG_VERSION },
            },
          }),
        )
        continue
      }
      if (req.method === 'tools/list') {
        io.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id,
            result: {
              tools: specs.map((s) => ({ name: s.name, description: s.description, ...(s.sideEffect ? { sideEffect: s.sideEffect } : {}), inputSchema: s.inputSchema })),
            },
          }),
        )
        continue
      }
      if (req.method === 'tools/call') {
        const name = String((req.params as { name?: unknown } | undefined)?.['name'] ?? '')
        const args = ((req.params as { arguments?: unknown } | undefined)?.['arguments'] ?? {}) as Record<string, unknown>
        callChain = callChain.then(async () => {
          try {
            const result = await dispatch(name, args)
            io.write(JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result ?? {}) }] } }))
          } catch (e) {
            io.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: e instanceof Error ? e.message : String(e) } }))
          }
        })
        continue
      }
      io.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method: ${String(req.method)}` } }))
    }
    driver.close()
  })()
  return { done, dispatch }
}

/** CLI 入口（bin）：--cdp-port / --target-title / --target-file（缺省 9333 / CAR 受控浏览器 / 无） */
export function main(argv: string[] = process.argv.slice(2)): void {
  const opts: ServerOptions = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--cdp-port' && argv[i + 1]) opts.cdpPort = Number(argv[i + 1])
    if (argv[i] === '--target-title' && argv[i + 1]) opts.targetTitle = argv[i + 1]
    if (argv[i] === '--target-file' && argv[i + 1]) opts.targetFile = argv[i + 1]
  }
  if (process.env.CAR_BROWSER_MCP_CDP_PORT && !opts.cdpPort) opts.cdpPort = Number(process.env.CAR_BROWSER_MCP_CDP_PORT)
  const { done } = serve(opts)
  done.then(
    () => process.exit(0),
    (e) => {
      console.error('[car-browser-mcp] fatal:', e instanceof Error ? e.message : e)
      process.exit(1)
    },
  )
}

// 主入口判定（node --experimental-transform-types 下 import.meta.url 可用）——被测试 import 时不自启
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main()
