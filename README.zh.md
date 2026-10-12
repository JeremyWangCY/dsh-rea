# dsh-rea

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供逆向工程工具，底层由 [REA](https://github.com/morluto/rea) 驱动。

在没有源码的情况下检查已发布的产物与运行时行为：原生二进制、JavaScript/Electron 应用、
.NET/Java 程序集、打包归档、移动端安装包和网页。返回结果是结构化的 **Evidence（证据）**，
因此结论始终可追溯。

## 为什么需要这个插件

REA 的 MCP server 提供 **约 170 个工具，合计约 1.9 MB JSON Schema（约 54 万 tokens）**。
Harness 会把工具 schema 附加到**每一次**模型请求，而 `@deepseek-ai/dsh-mcp-client`
会注册 server 声明的**全部**工具——直接给 REA 加一条桥接配置，会在对话开始前就消耗掉
大半个上下文窗口。（REA 自带的 `compact` schema 配置也只能减少约 9%。）

`dsh-rea` 是一个**带筛选的** MCP 桥接。它以 `rea__` 命名空间注册精选子集：

| 层级 | 工具数 | schema 体积 | 内容 |
|---|---|---|---|
| `entry` **（默认）** | 9 | ~98 kB（约 2.7 万 tokens） | 每类目标各一个入口：识别目标并弄清它是什么 |
| `navigate` | +30 | ~280 kB（约 7.8 万 tokens） | 进入目标内部阅读：函数、字符串、成员、包内部结构 |
| `analyze` | +17 | ~319 kB（约 8.9 万 tokens） | 深度关联、对比、JS/Electron 运行时追踪 |
| `all` | 170 | ~1.9 MB（约 54 万 tokens） | REA 完整目录，通常并非所需 |

单工具的体积分布相当均匀（2–45 kB），所以起作用的杠杆是**数量**；不存在少数几个
特别重的工具可以单独删掉。

长尾功能依然随时可用：REA 的 CLI（`npx -y rea-agents@latest <command>`）
能访问全部 170 个工具，且**完全不占用模型上下文**。

## 安装

```bash
dsh plugin add dsh-rea
```

插件通过 `npx` 运行 REA，无需全局安装。需要受支持的 Node 运行时
（`^22.19.0 || ^24.11.0 || >=26`），Harness 自带的 Electron 运行时已满足。

## 配置

默认配置无需任何改动。通过 profile 的 `cordis.patch.yml` 覆盖：

```yaml
- id: dsh-rea
  name: dsh-rea
  config:
    tools: navigate        # entry（默认）| navigate | analyze | all，或具体的工具名数组
    version: '6.4.0'       # 固定的 rea-agents 版本，保证 schema 稳定
    toolCallTimeoutMs: 300000
    env:
      REA_MCP_INPUT_SCHEMA_PROFILE: compact   # 精简参数描述
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | 设为 `false` 时插件保留但不启用 |
| `tools` | `'entry'` | 层级名（`entry`/`navigate`/`analyze`/`all`）、具体的 REA 工具名数组，或 `null` 表示全部 |
| `version` | `'6.4.0'` | 固定的 `rea-agents` 版本号；固定版本可让工具 schema 跨重启保持一致 |
| `runner` | `'npx'` | 用于启动 REA 的包运行器 |
| `env` | `{}` | 额外的子进程环境变量，合并在继承环境之上 |
| `toolCallTimeoutMs` | `300000` | 单次调用超时；原生分析可能耗时较长 |
| `failOnStartupError` | `false` | REA 启动失败时拒绝激活插件，而不是退化为无工具 |

## 用法

注册的工具以 `rea__` 为前缀，按目标类型选择：

| 目标 | 首选工具 |
|---|---|
| ASAR 或解压后的 JavaScript/Electron 目录 | `rea__analyze_javascript_application` |
| 原生可执行文件 | `rea__open_binary`，然后 `rea__binary_overview` |
| 归档、ZIP/APK/IPA/MSIX 或 DMG | `rea__open_binary`，然后 `rea__inspect_artifact` |
| 托管的 PE/CLI 程序集 | `rea__inspect_managed_artifact` |
| 已打开的浏览器页面 | `rea__list_browser_targets` |
| 已启动的 Electron 运行时 | `rea__list_electron_targets` |

REA 会把每次结果标记为 `evidence_id`。当响应超出 stdio 传输预算时，REA 会明确说明，
并指引使用 `rea__export_evidence_bundle`（已包含在默认层中）取回保留的记录。

## 注意事项

- **原生分析需要外部引擎。** 需要自行安装 Hopper、Ghidra 或 IDA。
  静态 JavaScript 分析则不需要。
- **大型分析耗时较长，且可能超出 REA 的 stdio 响应预算。** 这是 REA 自身的限制，
  而非桥接层的问题；这类场景请使用证据包工具或 CLI。
- 工具名与配置的 `version` 绑定。升级版本后请确认 `tools` 列表仍与 REA 实际声明的
  一致——未知的工具名只会记录警告并跳过，不会导致失败。
- 商业反编译器（IDA Pro/Hex-Rays、Hopper、JEB）需要你自己持有合法许可证，
  本插件不提供任何授权。

## 致谢

REA 由 [morluto](https://github.com/morluto/rea) 及其贡献者开发（MIT 许可）。
本插件是独立的 DSH 桥接实现，不包含 REA 的源码。
