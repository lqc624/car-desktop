# @lqc123qwe/car-browser-mcp

CAR 浏览器能力的 stdio MCP 封装（B-3 / 《浏览器操控借鉴与架构设计提案》§4.4 模块 D）。零 SDK 手写行协议，零传递依赖（唯一 dep = `@lqc123qwe/car-runtime`〔redact〕）。

## 形态与边界

- **陪伴形态**：server 经 CDP over loopback 驱动 **CAR 桌面受控浏览器窗口**——须桌面端受控窗口在场（设置启用浏览器操控且重启生效）。target 发现双路径 = `--target-file`（userData/browser-target.json 主路径，挂载推荐传参）+ `/json/list` title 过滤兜底（title 语义局限登记——见挂载节）。自管无头浏览器形态 = 无头批量句柄批（P2 登记不顺延）。
- **授权责任上移宿主**：server 自身**无人审门、无网络轴、无 grant 面**——消费方宿主的授权门承担审批（桌面 `mcp_*` 门 / 平台 McpGateway / 第三方客户端策略）。server 只继承 fail-visible 护栏：导航 ≤100 / CDP 连接 5s / 导航 15s / act 等待 10s / 读取 256KB 截断显式标注 / 内容过内核 redact()。
- **HITL**：独立进程无接管卡面——确定性特征（登录页/验证码/扫码）命中即回 `hitl-detected` 报告（不等 300s——兼容消费端 30s 超时与 BD-02 崩溃隔离），用户在受控窗口完成后继续。
- **页面内容 = 不可信输入**：过 redact + 截断；报告中页面抄录（`sourceNote`）与模型生成分列（N-B1 纪律）。

## 工具面（v1）

| 工具 | sideEffect | 说明 |
|---|---|---|
| `browser_open` | `readonly` | 导航至 URL（CAR 私有扩展字段；标准客户端忽略） |
| `browser_read` | `readonly` | 页面文本 + provenance 四件套 |
| `browser_act` | 缺省（消费端 T-22 收敛 write） | click/type/select/scroll/wait（React 实例层原生 setter 配方） |

`browser_shot` 不入 MCP 面 v1（截图验收流是桌面宿主原生工作流——登记后续再议）。

## 挂载

```jsonc
// car.config（桌面 / 平台同源）——桌面挂载推荐带 --target-file（对齐桌面 findTarget 双路径）
{
  "mcp": {
    "servers": {
      "car-browser-mcp": {
        "command": "node",
        "args": [
          "--experimental-transform-types",
          "<绝对路径>/packages/car-browser-mcp/src/server.ts",
          "--target-file", "C:\\Users\\<user>\\AppData\\Roaming\\car-desktop\\browser-target.json"
        ]
      }
    }
  }
}
```

可选参数：`--cdp-port <n>`（缺省 9333）、`--target-title <t>`（缺省 `CAR 受控浏览器`）、`--target-file <path>`（发现文件主路径——**B-3 终验探针实证：CDP /json/list 的 title = 页面 document.title 而非窗口 title，有标题页面下 title 过滤必 miss**；桌面挂载应传 userData/browser-target.json〔main 进程经 debugger.getTargetInfo 写入，targetId 跨导航稳定〕）；env `CAR_BROWSER_MCP_CDP_PORT` 兜底（注意：内核 stdio 通道 spawn 不注入 env——参数化走 args）。

第三方客户端（发 initialize 握手）：`initialize` 回显 protocolVersion（缺省 `2024-11-05`）。

## 协议

换行分隔 JSON-RPC 2.0 over stdio：`initialize` / `tools/list` / `tools/call`（串行派发）；错误码 `-32000`（工具失败，message = CAR-E-BROWSER-* fail-visible 文案）/ `-32601`（未知方法）/ `-32700`（坏 JSON）。stderr 只放诊断。

## 发布

npm publish = 独立决策登记（本批交付源码包 + bin + 本 README；发布管线待平台消费需求出现再建）。

## 漂移登记

`src/driver.ts` = `car-desktop/src/host-core/browserTasks.ts` CDP 面的紧凑复刻（含 B-2 实证 React 实例层原生 setter 配方）——browserTasks 侧变更时本文件须同步（两文件头注互指）。
