# dsh-rea

把 [REA](https://github.com/morluto/rea) **6.4.0 原版 MCP 全量工具**及同版本 Skill 接入 DeepSeek Harness。[English](README.md)

## 保留什么

- **170 个原版工具，一个不删**：反编译、交叉引用、字符串搜索、Android/ADB、托管代码、JavaScript/Electron、运行时分析等。取消自行设计的 entry/navigate/analyze 档位。
- 原版输入 schema、参数和描述；DSH 公共名称为 `mcp__rea__<原工具名>`。
- 使用 DSH 官方 `@deepseek-ai/dsh-mcp-client` 处理目录分页、目录变化、取消、生命周期、输出校验和附件投影，避免自行写一套不完整桥接。
- 原版 `reverse-engineer-anything` Skill v37、170 工具元数据及全部六篇 references。直接从固定依赖中注册，并指定其资源目录；不覆盖 Codex 或用户自己的技能。
- 运行原版有状态 MCP 进程，保留完整 Evidence 的 content 和 structuredContent，不缩减结果、不重新生成证据 ID。
- **六个原版 MCP prompts、14 个参数及原版动态补全**从输入框的 `/` 菜单进入，与 170 个工具**共用同一个 REA Client、进程与分析会话**。

REA 是固定版本的 npm 依赖，不是改写分析引擎。外部引擎、设备、商业授权要求与原版相同。

## `/` 菜单里的原版任务模板

六个原版 prompt 走的是输入框自己的 `/` 菜单，位于 `rea` 分组下（`/rea:investigate_feature`、`/rea:compare_versions`、`/rea:verify_reconstruction`、`/rea:trace_crash`、`/rea:audit_residual_unknowns`、`/rea:prepare_bounded_process_capture`）——也就是 Codex 呈现同一批 MCP prompts 的那个入口。**不额外增加按钮或常驻控件。**

选中某一项后打开该模板的参数表单：原版参数说明、上游动态补全（目标 document、provider、procedure、已保留 Evidence、capture、manifest、occurrence、未决 unknown），以及可插入草稿的**原文预览**。

保真约束：

- 发现与解析都是原版协议：菜单列 `prompts/list`，表单取 `prompts/get`，补全走 `completion/complete`，全都走工具已经在用的那个连接——不另起第二个 REA 进程，不改写模板，不缓存或编造补全项。
- 选中返回 `handled`：斜杠管线不插入、不改写任何文本，选模板本身不会改动草稿。
- 预览不执行任何分析；每次工具调用仍然由模型显式决定。
- 插入只是一次草稿写入：面板不会提交、不会发送、不会替你选目标，需自行编辑或发送。
- 连接换代后到达的迟到结果会被拒绝，过期模板不可能被插入。
- 菜单分组只在 Web 界面存在；CLI/无头 profile 仍保留全部 170 个工具和 Skill，只是没有这个 `/` 分组。

由于 DSH 会在 Host 进程生命周期内缓存每个包的客户端元数据，升级后需要**重启一次 DSH**：已在旧版本挂载过 `dsh-rea` 的运行中 Host 已把它缓存为“仅宿主包”，重启前不会提供新的浏览器 bundle。无需改任何配置。

## 安装

尚未发布 npm，请在 DSH 插件管理器中从仓库安装：

```text
github:JeremyWangCY/dsh-rea
```

本地开发可通过插件管理器安装此源码目录的绝对路径。必须安装到**当前活动 profile**；使用 Web 界面不一定代表 `web` profile，桌面版也承载同一界面。

## 配置

默认全量，不强制改变 DSH 对其他工具的 native/PTC 呈现：

```yaml
- id: dsh-rea
  config:
    serverName: rea
    toolCallTimeoutMs: 300000
    # 如果宿主可执行文件无法启动 REA 的分析子进程，显式指定受支持 Node：
    # nodeCommand: 'C:\path\to\node.exe'
```

| 字段 | 默认 | 含义 |
|---|---|---|
| enabled | true | 是否启用 |
| serverName | rea | 官方桥接命名空间 |
| tools | all | 兼容标记；不再支持删减子集 |
| nodeCommand | 空 | 默认宿主可执行文件；Electron 加 ELECTRON_RUN_AS_NODE=1；必要时指定独立 Node |
| env | {} | 显式 REA provider 环境；官方桥接会清除继承环境中的凭据形态/DSH 变量 |
| toolCallTimeoutMs | 300000 | MCP 调用超时；不保证外层 agent/PTC 期限更长 |
| failOnStartupError | true | 启动失败明确报错，不静默伪装成“安装成功但没工具” |

Node 支持范围：`^22.19.0 || ^24.11.0 || >=26.0.0`，不支持 23/25。插件激活不安装/升级运行时或分析引擎，不修改无关审批/preset 设置。自动重连关闭：新 REA 进程会丢失当前目标/provider/保留证据，应断线后显式重载。

## native 与 PTC

两种方式都完整注册 170 个工具。PTC 是 DSH 的工具/agent preset 呈现方式，插件不擅自把其他工具全切换为 PTC。

真实 Cordis 部署实测：

| 方式 | 模型侧工具 JSON | 额外 SDK 提示文本 |
|---|---:|---:|
| native，170 个 | 436,594 字节 | 0 |
| PTC，仅 run_code | 944 字节 | 86,633 字节 |

这是**字节测量，不是 tokenizer 计数**。v0.1 中“54 万输入 tokens”的说法错把返回结果 schema 算成模型输入，已经撤回。PTC 不是零上下文；SDK 仍进入提示词。worker 默认墙钟上限 600 秒、计算时间 60 秒、输出 64MiB；只有 return/print 的值进入外层结果，需要完整证据时应完整返回。两种方式保持工具返回内容，但模型使用的接口不同，不能声称回答质量完全一致。

请使用原版 Skill 的目标路由、Evidence 与 provider 恢复指引。REA CLI 的 JSON 也包含完整 Evidence 和 evidence_id；区别是通常每次独立调用、不跨命令保留目标/provider。CLI 输出喂给模型仍然占上下文。

## 已验证与未验证

`verify/integration.mjs` 运行真实 Cordis ToolRuntime、原版 MCP 和 DSH worker-thread PTC，对返回结果逐字段深比较。覆盖：170 个名称/描述/输入 schema、原版 Skill、六个原版 prompt 的元数据与渲染消息、一次原版 provider completion、JS 分析及数据流追踪、同会话 retained-reference 视图、证据包列表、含一条记录的离线 HAR、含文件的 ZIP 打开/检查/关闭、原版错误、调用前取消、卸载清理、启动失败明确报告。`test/client.test.mjs` 用最小 React/DOM 环境加载**真实浏览器 bundle** 并驱动真正的 `/` 源：空闲时槽位渲染 null 且不发任何请求、源注册、候选过滤、`handled` 选中不改动草稿、必填参数门控、补全请求载荷、预览原文、仅通过 `setDraft` 插入且保留原草稿、错误提示，以及升级后未重启的重启提示。`verify/connection.mjs` 挂载**已安装的** `WebServer` + `Connection` 并走真实线路：无浏览器会话为 401，随后 `prompts/list`/`get`/`complete` 与直连 MCP 深度相等，另验证信封、content-type、Host 信任栅栏与卸载。`pnpm test` 共 13 项单元/面板测试，`pnpm verify` 为 35 项差分校验。需先用受支持 Node 和 pnpm 安装依赖；可选环境变量 `DSH_REA_TEST_MODULE_ROOT` 指向已安装 DSH 的模块根目录，以测试那个 Host 的精确服务版本，默认用本项目测试依赖。结果见源码中的 `verification/integration-report.json`。

**未声称**：170 个操作全部实际执行；IDA/Ghidra/Hopper/JEB/ADB/浏览器捕获已验证；耗时操作中途取消已验证；LLM 回答完全相同；所有模型 provider 都接受全量 schema；所有外部 provider 的补全项都被穷尽测试。外部引擎须另做具体任务测试。

官方 `@deepseek-ai/dsh-mcp-client` 没有暴露共享连接钩子，因此 `lib/vendor/mcp-bridge.js` 是该桥接的 MIT 原文副本（文件头记录上游 SHA-256），只做**一处**受审查修改：增加可选的第四个 `onClient` 参数。工具注册、传输、重连、错误与卸载行为与上游逐字节一致，`test/plugin.test.mjs` 会重新推导并比对整份文件，确保它不会静默漂移。官方桥接也不把 MCP annotations 复制到 ToolRuntime 元数据，required-task 执行不受支持。具体环境、方法和边界见[验证报告](verification/README.md)。

## 从 v0.1 迁移

删除旧 `tools: entry/navigate/analyze`、`runner` 和 `version` 覆盖。版本由固定依赖控制，恢复所有工具，公开前缀从 `rea__` 改为官方桥接的 `mcp__rea__`。

## 授权

适配器 MIT。REA 为 morluto 及贡献者的 MIT 项目，以固定依赖提供并保留上游授权。第三方引擎授权不变。
