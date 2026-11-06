# dsh-rea

把 [REA](https://github.com/morluto/rea) **6.8.0 原版 MCP 全量工具**及同版本 Skill 接入 DeepSeek Harness。[English](README.md)

**默认按需加载**：229 个工具的 schema 与 Skill 只在运行 `/rea` 之后才进入请求；在那之前它们不占上下文（native 模式实测 273,264 字节 / 每次请求，PTC 模式约 171 KB）。

## 按需加载（v0.4 起的默认行为）

工具与 Skill 现在是**按 agent 惰性可见**的，协议与进程都不变：

- MCP 连接、单个 REA 进程、六个原版 prompt 与补全**始终在线**——`/` 菜单随时可用，选模板不依赖是否已解锁。
- 每个 agent 默认带一条 `tools.restrict({ deny })` 掩码，点掉当前 `mcp__rea__*` 的全部名称。原生 schema 与 PTC 的 SDK 提示词都从同一个 scope 视图投影，所以两处一起消失。
- Skill 只在首次解锁时注册一次，最后一个解锁的会话执行 `/rea off` 后即释放；未解锁的会话连目录行都不付，`/rea off` 之后也不再付。
- 桥接重新同步（`notifications/tools/list_changed`）后掩码自动重建，不会漏掉新一代名称；已解锁的 agent 不会被中途收走工具。
- 恢复的会话按日志里已有的 `command/run` 重新判定：这些记录会**按顺序重放**，以最后一条 `/rea` 或 `/rea off` 为准，`/rea status` 记录被忽略；昨天 `/rea` 过的会话今天不会又被藏起来。历史读不出来时一律判为 **hidden**，目录绝不会被意外展开。

### `/rea` 是开关，关键词不是

```text
/rea                  只解锁，然后等你说要做什么
/rea 看看这个 apk      解锁，并把这句话原样发给模型
/rea on               等同于单独一条 /rea
/rea status           查看当前是 hidden 还是 revealed
/rea off              在本次会话里重新隐藏目录
```

命令会先解锁，再把 `/rea` 后面的话**作为一条普通用户消息**投递给模型——因为命令本身不会进入模型，不转发就等于把你的请求吞掉。

`/rea off` 会立刻重新装上掩码，并且能跨重载保持：结束时是 hidden 的会话，重新打开仍然是 hidden。它只影响执行该命令的会话。

**为什么不靠关键词自动判断**：判断只能靠猜，猜错的代价是整套目录（native 模式 530 KB）。而且它在最贵的地方必然猜错——讨论这个门禁本身，就一定会说出它的触发词。所以 `/rea` 是权威开关。

确实还留了关键词路径，需要显式打开：

```yaml
- id: dsh-rea
  config:
    keywordUnlock: true
```

回到旧行为（常驻全量）：

```yaml
- id: dsh-rea
  config:
    exposure: always
```
## 只加载需要的部分（类别）

完整揭示整套目录，每次请求要多付 273,264 字节的模型侧 schema（REA 6.8.0 默认公布紧凑的输入 schema；设置 `REA_MCP_INPUT_SCHEMA_PROFILE=full` 会更大），而大多数会话只用到其中一小块。每个上游工具恰好属于一个**类别**，会话可以只揭示自己需要的类别。以下数据来自 REA 6.8.0 的 `node verify/measure.mjs`：

| 类别 | 工具数 | 模型侧 schema 字节 |
|---|---:|---:|
| `native` | 76 | 92,276 |
| `android` | 32 | 23,073 |
| `apple` | 13 | 11,423 |
| `managed` | 8 | 13,301 |
| `web` | 28 | 46,094 |
| `wasm` | 2 | 3,625 |
| `dynamic` | 24 | 29,218 |
| `providers` | 7 | 6,020 |
| `firmware` | 9 | 15,453 |
| `capture` | 6 | 8,207 |
| `reconstruction` | 24 | 24,344 |

各行之和比整套目录少约 200 字节（JSON 数组的标点）。`native` 是覆盖面最广的二进制分析族，也是最大的一个，所以只用 native 的会话大约只带整套目录的 34%（少约 66%）。任何规则都没覆盖的新名字会落进 `other`，它和别的类别一样可加载；`test/categories.test.mjs` 会在 REA 升级后仍有工具落在那里时失败。

```text
/rea                       揭示默认类别（不收窄就是全部）
/rea on native,android     只揭示这些类别（逗号或空格分隔）
/rea add web               在已揭示的基础上再加 web
/rea on all                揭示全部类别
/rea off                   重新隐藏目录
/rea status                已加载的类别及大小，以及其余类别各自的代价
/rea list                  列出每个类别的说明、工具数和大小，* 表示已加载
```

含未知类别的列表会被整体拒绝，而不是只应用一半；`/rea on this binary` 仍然是一条请求（出现不是类别的词，整段就当请求）。

**模型可以自己加载类别（需要显式开启）。** 设置 `modelLoader: true`（仅 lazy 模式）后，插件会注册两个小工具 `rea_load({ categories })` 与 `rea_unload()`，名字不带 `mcp__rea__` 前缀，所以门禁不会把它们藏起来。`rea_load` 只对调用它的会话生效，一次最多新增 `loaderMaxPerCall`（默认 3）个类别，要加载的都已加载时什么都不做，并返回这次新增了多少工具、多少 KB。加载会改变请求前缀并造成一次 prompt 缓存未命中，所以工具描述会提醒模型每个任务只加载一次。默认关闭：这两个工具会出现在每次请求里，并且让模型不经 `/rea` 就能自行扩大可见范围。

恢复会话时，`/rea on|add|off` 与每一次成功的 `rea_load`/`rea_unload` 会按顺序重放，所以会话回来时类别与结束时完全一致。

Windows 上做 native 分析的推荐配置（REA 的抓包/信号工具只支持 Linux）：

```yaml
- id: dsh-rea
  config:
    defaultCategories: [native]
    keywordCategories: [native]
    alwaysDeny: [capture]
```

## 保留什么

- **229 个原版工具，一个不删**：反编译、交叉引用、字符串搜索、Android/ADB、托管代码、JavaScript/Electron、运行时分析等。取消自行设计的 entry/navigate/analyze 档位。
- 原版输入 schema、参数和描述；DSH 公共名称为 `mcp__rea__<原工具名>`。
- 使用 DSH 官方 `@deepseek-ai/dsh-mcp-client` 处理目录分页、目录变化、取消、生命周期、输出校验和附件投影，避免自行写一套不完整桥接。
- 原版 `reverse-engineer-anything` Skill、上游 tool_count 元数据及全部六篇 references。直接从固定依赖中注册，并指定其资源目录；不覆盖 Codex 或用户自己的技能。
- 运行原版有状态 MCP 进程，保留完整 Evidence 的 content 和 structuredContent，不缩减结果、不重新生成证据 ID。
- **六个原版 MCP prompts、25 个参数及原版动态补全**从输入框的 `/` 菜单进入，与 229 个工具**共用同一个 REA Client、进程与分析会话**。

REA 是固定版本的 npm 依赖，不是改写分析引擎。外部引擎、设备、商业授权要求与原版相同。

## `/` 菜单里的原版任务模板

六个原版 prompt 走的是输入框自己的 `/` 菜单，位于 `rea` 分组下（`/rea:investigate_feature`、`/rea:compare_application_versions`、`/rea:verify_reconstruction`、`/rea:trace_crash`、`/rea:audit_residual_unknowns`、`/rea:prepare_bounded_process_capture`）——也就是 Codex 呈现同一批 MCP prompts 的那个入口。**不额外增加按钮或常驻控件。**

选中某一项后打开该模板的参数表单：原版参数说明、上游动态补全（目标 document、provider、procedure、已保留 Evidence、capture、manifest、occurrence、未决 unknown），以及可插入草稿的**原文预览**。

保真约束：

- 发现与解析都是原版协议：菜单列 `prompts/list`，表单取 `prompts/get`，补全走 `completion/complete`，全都走工具已经在用的那个连接——不另起第二个 REA 进程，不改写模板，不缓存或编造补全项。
- 选中返回 `handled`：斜杠管线不插入、不改写任何文本，选模板本身不会改动草稿。
- 预览不执行任何分析；每次工具调用仍然由模型显式决定。
- 插入只是一次草稿写入：面板不会提交、不会发送、不会替你选目标，需自行编辑或发送。
- 连接换代后到达的迟到结果会被拒绝，过期模板不可能被插入。
- 菜单分组只在 Web 界面存在；CLI/无头 profile 走同一套按需加载规则，只是没有这个 `/` 分组。

由于 DSH 会在 Host 进程生命周期内缓存每个包的客户端元数据，升级后需要**重启一次 DSH**：已在旧版本挂载过 `dsh-rea` 的运行中 Host 已把它缓存为“仅宿主包”，重启前不会提供新的浏览器 bundle。无需改任何配置。

## 安装

本包**未发布到 npm**——npm 上的 `dsh-rea` 是另一个无关的同名适配器。请安装 GitHub Release 的 tarball，这正对应插件市场的 `github:` 来源格式：

```text
https://github.com/JeremyWangCY/dsh-rea/releases/download/v0.5.0/dsh-rea-0.5.0.tgz
```

必须使用 Release 资产（市场解析的是 `releases/download/<tag>/<name>-<version>.tgz` 这种 URL）。每个 Release 的说明里写明所固定的 `rea-agents` 版本。`@deepseek-ai/dsh-*` 是 peerDependencies，由 DSH 宿主提供，不由本包安装。

本地开发可通过插件管理器安装此源码目录的绝对路径。必须安装到**当前活动 profile**；使用 Web 界面不一定代表 `web` profile，桌面版也承载同一界面。

## 配置

默认按需加载，不强制改变 DSH 对其他工具的 native/PTC 呈现：

```yaml
- id: dsh-rea
  config:
    exposure: lazy
    serverName: rea
    toolCallTimeoutMs: 300000
    # 如果宿主可执行文件无法启动 REA 的分析子进程，显式指定受支持 Node：
    # nodeCommand: 'C:\path\to\node.exe'
```

| 字段 | 默认 | 含义 |
|---|---|---|
| enabled | true | 是否启用 |
| exposure | lazy | `lazy`：目录按 agent 惰性加载，运行 `/rea` 才可见；`always`：常驻全量（v0.3 行为） |
| keywordUnlock | false | 是否额外允许“真实用户消息命中逆向关键词”自动解锁。默认关闭，见上文原因 |
| defaultCategories | [all] | 单独的 `/rea` 或 `/rea <请求>` 揭示哪些类别。`all` 保持整套目录的行为；未知 id 会让激活失败 |
| keywordCategories | [native] | 关键词解锁揭示哪些类别（仅在开启 `keywordUnlock` 时） |
| modelLoader | false | 给模型注册 `rea_load` / `rea_unload`（仅 lazy 模式） |
| loaderMaxPerCall | 3 | 一次 `rea_load` 最多新增几个类别 |
| alwaysDeny | [] | 任何人都不能揭示的类别，即使用 `all` 也不行（例如 Windows 上的 `[capture]`） |
| serverName | rea | 官方桥接命名空间 |
| tools | all | 兼容标记；不再支持删减子集 |
| nodeCommand | 空 | 默认宿主可执行文件；Electron 加 ELECTRON_RUN_AS_NODE=1；必要时指定独立 Node |
| env | {} | 显式 REA provider 环境；官方桥接会清除继承环境中的凭据形态/DSH 变量 |
| toolCallTimeoutMs | 300000 | MCP 调用超时；不保证外层 agent/PTC 期限更长 |
| failOnStartupError | true | 启动失败明确报错，不静默伪装成“安装成功但没工具” |

Node 支持范围：`^22.19.0 || ^24.11.0 || >=26.0.0`，不支持 23/25。插件激活不安装/升级运行时或分析引擎，不修改无关审批/preset 设置。自动重连关闭：新 REA 进程会丢失当前目标/provider/保留证据，应断线后显式重载。

## native 与 PTC

两种方式都完整注册全部上游工具。PTC 是 DSH 的工具/agent preset 呈现方式，插件不擅自把其他工具全切换为 PTC。

真实 Cordis 部署实测：

| 方式 | 模型侧工具 JSON | 额外 SDK 提示文本 |
|---|---:|---:|
| native，229 个 | 273,264 字节 | 0 |
| PTC，仅 run_code | 944 字节 | 86,633 字节 |

这是**字节测量，不是 tokenizer 计数**。v0.1 中“54 万输入 tokens”的说法错把返回结果 schema 算成模型输入，已经撤回。PTC 不是零上下文；SDK 仍进入提示词。worker 默认墙钟上限 600 秒、计算时间 60 秒、输出 64MiB；只有 return/print 的值进入外层结果，需要完整证据时应完整返回。两种方式保持工具返回内容，但模型使用的接口不同，不能声称回答质量完全一致。

请使用原版 Skill 的目标路由、Evidence 与 provider 恢复指引。REA CLI 的 JSON 也包含完整 Evidence 和 evidence_id；区别是通常每次独立调用、不跨命令保留目标/provider。CLI 输出喂给模型仍然占上下文。

## 已验证与未验证

`verify/integration.mjs` 运行真实 Cordis ToolRuntime、原版 MCP 和 DSH worker-thread PTC，对返回结果逐字段深比较。覆盖：全部名称/描述/输入 schema、原版 Skill、六个原版 prompt 的元数据与渲染消息、一次原版 provider completion、JS 分析及数据流追踪、同会话 retained-reference 视图、证据包列表、含一条记录的离线 HAR、含文件的 ZIP 打开/检查/关闭、原版错误、调用前取消、卸载清理、启动失败明确报告。`test/client.test.mjs` 用最小 React/DOM 环境加载**真实浏览器 bundle** 并驱动真正的 `/` 源：空闲时槽位渲染 null 且不发任何请求、源注册、候选过滤、`handled` 选中不改动草稿、必填参数门控、补全请求载荷、预览原文、仅通过 `setDraft` 插入且保留原草稿、错误提示，以及升级后未重启的重启提示。`verify/connection.mjs` 挂载**已安装的** `WebServer` + `Connection` 并走真实线路：无浏览器会话为 401，随后 `prompts/list`/`get`/`complete` 与直连 MCP 深度相等，另验证信封、content-type、Host 信任栅栏与卸载。`test/gate.test.mjs` 覆盖按 agent 掩码、重新同步、恢复会话与“关键词默认不解锁”的策略；`test/command.test.mjs` 覆盖 `/rea` 的指令解析、转发、类别指令与带大小的状态；`test/categories.test.mjs` 启动已安装的 REA，任何工具落在命名类别之外即失败；`test/loader.test.mjs` 覆盖 `rea_load`/`rea_unload`；`verify/lazy-exposure.mjs` 挂载真实 `dsh-system-prompt`/`dsh-tools`/`dsh-skill`，实测被门控 agent 的组装里 REA schema 为零、而桥接仍保留完整世代。`pnpm test` 共 160 项单元/面板测试，`pnpm verify` 为 35 项差分校验，`pnpm verify:lazy` 为 10 项按需加载校验（含经真实命令服务的部分揭示）。需先用受支持 Node 和 pnpm 安装依赖；可选环境变量 `DSH_REA_TEST_MODULE_ROOT` 指向已安装 DSH 的模块根目录，以测试那个 Host 的精确服务版本，默认用本项目测试依赖。结果见源码中的 `verification/integration-report.json`。

**未声称**：全部操作实际执行；IDA/Ghidra/Hopper/JEB/ADB/浏览器捕获已验证；耗时操作中途取消已验证；LLM 回答完全相同；所有模型 provider 都接受全量 schema；所有外部 provider 的补全项都被穷尽测试。外部引擎须另做具体任务测试。

官方 `@deepseek-ai/dsh-mcp-client` 没有暴露共享连接钩子，因此 `lib/vendor/mcp-bridge.js` 是该桥接的 MIT 原文副本（文件头记录上游 SHA-256），只做**一处**受审查修改：增加可选的第四个 `onClient` 参数。工具注册、传输、重连、错误与卸载行为与上游逐字节一致，`test/plugin.test.mjs` 会重新推导并比对整份文件，确保它不会静默漂移。官方桥接也不把 MCP annotations 复制到 ToolRuntime 元数据，required-task 执行不受支持。具体环境、方法和边界见[验证报告](verification/README.md)。

## 从 v0.1 迁移

删除旧 `tools: entry/navigate/analyze`、`runner` 和 `version` 覆盖。版本由固定依赖控制，恢复所有工具，公开前缀从 `rea__` 改为官方桥接的 `mcp__rea__`。

## 授权

适配器 MIT。REA 为 morluto 及贡献者的 MIT 项目，以固定依赖提供并保留上游授权。第三方引擎授权不变。
