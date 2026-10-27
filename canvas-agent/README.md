# Infinite Canvas Agent

本地 Canvas Agent 用来连接画布网页和用户电脑上的 Codex / Claude Code。本地开发时优先连接 `http://localhost:3000`，不需要先使用线上站点。

需要 Node.js **22.19 或更高版本**：服务端 Pi 引擎依赖的模型适配层要求该版本。

## 容器化部署

本仓库 Dockerfile 已包含 Agent，Node 运行 Agent、Bun 运行 Web，Agent 仅监听容器回环 17371 并通过带工作区认证的同源代理访问。Agent 状态与 Codex 登录分别持久化到 /home/node/.infinite-canvas 和 /home/node/.codex；不把账号凭据放入镜像。Jenkins 的 deploy 分支发布和回滚配置见 [部署说明](../deploy/README.md)，真实 Codex 登录与容器运行仍需验收。

## 启动

```bash
npx -y @basketikun/canvas-agent@latest
```

带上 `@latest` 是因为 npx 会缓存已下载的版本，不加就可能一直运行旧版本。

需要排查连接、线程、Codex app-server 或工具调用问题时，可开启 Debug 模式：

```bash
npx -y @basketikun/canvas-agent@latest --debug
```

Debug 日志会以 `[DEBUG][HH:mm:ss]` 等传统格式输出到终端，并按启动日期保存到 `~/.infinite-canvas/logs/canvas-agent-YYYY-MM-DD.log`。终端日志带级别颜色，文件日志为纯文本；日志包含 HTTP、SSE、线程、turn、Codex app-server 和工具调用事件，token 与图片 Data URL 会自动隐藏。

本仓库开发时也可以直接运行：

```bash
cd canvas-agent
npm install
npm run build
node dist/index.js
```

启动后会输出本机地址和 token：

```txt
Local URL: http://127.0.0.1:17371
Connect token: xxxxxx
```

在画布右上角点击 `Agent`，填入地址和 token 后连接。

Codex app 插件会读取启动输出里的 Local URL 和 Connect token，并直接打开画布网页地址；Canvas Agent 不负责生成画布打开 URL。

Canvas Agent 默认只监听 `127.0.0.1`。网页第一次带正确 token 连接后，Canvas Agent 会记录该网页 Origin；之后其他 Origin 不能复用这个本地 Agent，除非用户清理 `~/.infinite-canvas/canvas-agent.json` 里的 `origins`。

## 发布

`canvas-agent` 使用自己的 `package.json` 版本号，不跟仓库根目录 `VERSION` 绑定。推送到 `main` 后，GitHub Actions 会检查 npm 上是否已经存在当前包版本；不存在时才发布 `@basketikun/canvas-agent`。

发布前需要在 GitHub 仓库 Secrets 中配置 `NPM_TOKEN`。

## Codex MCP

如果希望 Codex 终端能直接操作画布，需要先把 Canvas Agent 注册成 Codex MCP。

直接运行 `npx -y @basketikun/canvas-agent@latest` 只启动本地 Agent 服务，不会安装 MCP，也不会增加 Codex 工具上下文。只有安装 Codex app 插件，或手动执行 `codex mcp add` 后，`infinite-canvas` 工具才会进入 Codex 上下文；由于工具较多，不使用时建议移除。

通过插件安装时移除插件：

```bash
codex plugin remove infinite-canvas
```

手动添加 MCP 时移除 MCP：

```bash
codex mcp remove infinite-canvas
```

### Codex app 插件

仓库内提供了 Codex app 插件：`plugins/infinite-canvas`。在 Codex app 中添加本仓库的 marketplace 后，可以安装 `Infinite Canvas` 插件；插件会注册同一个 `infinite-canvas` MCP，并带上画布操作说明。

添加本地 marketplace 时建议使用仓库绝对路径，避免 Codex 从其他工作目录解析失败：

```bash
cd /path/to/infinite-canvas
codex plugin marketplace add "$(pwd)"
codex plugin add infinite-canvas@infinite-canvas-local
```

插件默认通过 npm 启动 MCP；这个命令只提供 MCP 工具，不会把 MCP 写入全局配置，也不会在退出时自动卸载：

```bash
npx -y @basketikun/canvas-agent@latest mcp
```

使用时可以直接在 Codex 里说“打开 Infinite Canvas”，插件会启动本地 Agent，读取 Local URL 和 Connect token，然后在右侧打开 `https://canvas.best/` 并自动新建、连接画布；只有明确要求使用本地项目时才会启动本地前端。

Canvas Agent 启动后，给 Codex 添加 MCP：

```bash
codex mcp add infinite-canvas -- npx -y @basketikun/canvas-agent@latest mcp
```

本仓库开发时可以改成，实际使用建议替换为本机绝对路径：

```bash
codex mcp add infinite-canvas -- node /path/to/infinite-canvas/canvas-agent/dist/index.js mcp
```

Canvas Agent 源码使用 TypeScript 编写，MCP 协议层使用官方 `@modelcontextprotocol/sdk`，工具入参使用 `zod` 描述。

如果希望终端里的 Codex 不被 MCP 审批卡住，可以在 `~/.codex/config.toml` 里给这个 MCP 设置自动放行：

```toml
[mcp_servers.infinite-canvas]
command = "npx"
args = ["-y", "@basketikun/canvas-agent@latest", "mcp"]
default_tools_approval_mode = "approve"
```

可用工具：

- `canvas_get_state`
- `canvas_get_selection`
- `canvas_export_snapshot`
- `canvas_apply_ops`
- `canvas_create_text_node`
- `canvas_create_image_prompt_flow`
- `canvas_import_artifact`

`canvas_apply_ops` 示例：

```json
{
  "ops": [
    {
      "type": "add_node",
      "nodeType": "text",
      "title": "标题",
      "position": { "x": 0, "y": 0 },
      "metadata": { "content": "文本内容" }
    }
  ]
}
```

## 侧边栏 Codex

本地面板会把提示词发送给 Canvas Agent。Canvas Agent 使用官方 `@openai/codex` CLI 的 `codex app-server --stdio` 启动并复用同一个 Codex thread，启动时会注入 `infinite-canvas` MCP 配置并自动放行 MCP 审批，真正执行画布修改前仍由网页侧边栏二次确认。

侧边栏会展示 Codex 返回的 `thread.started`、`turn.started`、`item.*`、`turn.completed` 等结构化事件；Canvas Agent 会合并短时间内的回复、思考摘要和命令输出增量，网页使用同一条消息持续更新，并把任务进度、计划、搜索、文件修改与工具操作整理为中文过程时间线。

侧边栏上传或粘贴的图片会先发到本机 Canvas Agent，再由 Canvas Agent 临时写入本机文件并作为 app-server `localImage` 输入传给 Codex；前端会提示附件体积，单次请求体限制为 30MB。

其他类型的文件走本机工作区文件中心：选择后即以原始字节流式上传到 `<workspacePath>/.infinite-canvas/files/<fileId>/`，发送时提示词里只带文件绝对路径和元信息，Codex 用自身的读取能力打开这些路径。单个文件上限 100 MB、单条消息最多 10 个、单轮合计 300 MiB、工作区总量 2 GiB；文件按会话绑定，删除会话时同步删除，未发送的文件 24 小时后清理，已绑定文件保留 30 天。文件只存在本机工作区，不上传服务器媒体桶。Pi 引擎没有文件读取工具，因此不显示文件上传入口。

Codex 生成结果需要回到画布时调用 `canvas_import_artifact`，`path` 必须是当前工作区内的绝对路径：图片导入为图片节点，markdown、txt、csv、json 等文本类导入为文本节点，其他类型会被拒绝。手动确认模式下该工具和其他画布写入工具一样需要先确认。

## 服务端 Pi 引擎

面板标题栏可以在 **Codex** 和 **Pi** 两个引擎之间切换，Codex 链路完全保留。Pi 引擎基于 `@earendil-works/pi-agent-core`，在 Canvas Agent 进程内直接调用服务器配置里的文本渠道，不需要 Codex 登录、本机 MCP 或 app-server。

OpenAI 兼容渠道自动读取 `/models`，优先按上游的逐模型协议能力选择 Responses 或 Chat Completions；没有协议元数据时由 Pi 内置模型目录和模型 ID 推断。Gemini 渠道使用原生协议；模型与 API Key 从服务端配置读取，浏览器仅获取可选模型和密钥是否已配置的状态。

- 保存渠道地址与密钥后，Pi 自动发现该密钥可用的对话模型，无需在渠道里逐个添加；已配置的文本模型保留，图片、视频、音频等模型不进入助手。连接、切换到 Pi 或保存渠道时重新读取列表，发送时复用服务端发现结果；发现失败时保留同一渠道的已有结果和手动模型。
- 精确模型 ID 优先复用 Pi 内置目录的输入类型、推理能力、上下文窗口、输出上限与兼容参数；上游提供的参数和显式模型覆盖优先。未知型号保留原有 128000 上下文 / 8192 输出默认值，不猜测具体容量。非推理模型不显示思考程度选择器。
- 全部 34 个画布工具的 zod 入参通过 `zod-to-json-schema` 转成 JSON Schema 后注册给 Pi，`execute` 仍调用同一套 `CanvasSession.callTool`，因此浏览器确认、超时、多标签页归属和附件链路完全复用。
- 会话按工作区保存在 `<workspace>/.infinite-canvas/pi-threads/`，未知版本或损坏文件会被拒绝读取而不是覆盖。
- Pi 引擎暂不支持 Codex 沙箱权限和内置生图，相关入口在 Pi 模式下隐藏。

### Skill 支持

Pi 引擎直接读取工作空间的 `.agents/skills`，和 Codex 技能页、画布内新建的 Skill 是同一份文件，使用 pi 官方 `@earendil-works/pi-coding-agent` 的 `loadSkillsFromDir` 与 `formatSkillsForPrompt`，因此目录结构和 frontmatter 校验与 Agent Skills 标准一致。

- 系统提示词只注入**已启用** Skill 的名称、描述和路径，正文按需加载，不长期占用上下文。
- 模型通过 `read_skill` 工具按名称读取 `SKILL.md` 正文；该工具是 Pi 引擎额外提供的第 35 个工具。
- 网页技能页点「使用」即为显式调用，会把该 Skill 正文作为本轮前置说明，不依赖模型自行判断描述是否命中。
- 启停状态保存在 `<workspace>/.infinite-canvas/pi-skills.json`（`{ version: 1, disabled: [...] }`），未知版本按原文件保留处理。
- 启停或增删 Skill 后再次发送任务时会重建运行时上下文，`pi-coding-agent` 的技能扫描在同一进程内没有额外成本。

Pi 模式下的技能页只提供启停和使用，新建、编辑、删除仍由 Codex 技能页完成，避免两个引擎同时写入同一份 `SKILL.md`。

新增的 HTTP 路由：`/agent/pi/models`、`/agent/pi/skills`、`/agent/pi/skills/:name/enabled`、`/agent/pi/threads`、`/agent/pi/threads/:id`、`/agent/pi/threads/new`、`/agent/pi/threads/:id/resume`、`/agent/pi/threads/:id/delete`、`/agent/pi/turn`、`/agent/pi/interrupt`。

## Claude Code

Claude Code Adapter 代码暂时保留，但当前网页侧边栏只开放 Codex。后续开放 Claude 入口时，Canvas Agent 会调用本机 `claude -p --output-format stream-json` 并把流式 JSON 事件转发到侧边栏。

如果希望 Claude Code 也能操作画布，需要给 Claude Code 添加同一个 MCP。建议用 user scope，避免 Canvas Agent 从不同目录启动时找不到配置：

```bash
claude mcp add --scope user --transport stdio infinite-canvas -- npx -y @basketikun/canvas-agent@latest mcp
```

本仓库开发时可以改成：

```bash
claude mcp add --scope user --transport stdio infinite-canvas -- node /path/to/infinite-canvas/canvas-agent/dist/index.js mcp
```

Canvas Agent 调用 Claude Code 时会默认带上 `--allowedTools mcp__infinite-canvas__*`，画布写操作仍由网页侧边栏确认。
