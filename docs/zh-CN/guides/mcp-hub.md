# 使用 MCP 中枢

把 MCP 服务添加到 ARC 一次，所有已连接的控制源（例如 Claude 或 ChatGPT）就能通过
现有的 ARC 连接使用它们。

## 开启

打开 设置 → 关于 → 实验性功能，开启 **MCP 中枢**。左下角导航胶囊会出现中枢入口。

## 让 Agent 添加服务

在任意已连接的控制源里直接提出：

> 把我现有的 Codex MCP 服务导入 ARC 的 MCP 中枢，并列出它们的工具。

> 把 https://example.com/mcp 这个 MCP 服务添加到 ARC 的 MCP 中枢，Authorization 请求头使用我的 API Key。

Agent 会调用 `mcp_configure`。导入会读取你的 Codex、Claude、Cursor 或 Gemini 配置，
中枢里已有的同名服务保持不变。添加后 ARC 会立即连接，并返回工具列表或失败原因。

## 使用工具

直接描述要做的事。控制源通过 `mcp_tools` 查看中枢工具，再用 `mcp_call` 调用。
同一个服务无需在每个控制源里重复添加。

## 管理服务

中枢页面列出每个服务的状态、传输方式和工具。用开关停用服务，用重新连接按钮重试，
用删除按钮移除服务。命令、地址或凭据的修改交给 Agent 完成。

## 限制

- 中枢是实验性功能，默认关闭。
- 服务在本机以你的权限运行，只添加你信任的服务。
- 支持 stdio 和 Streamable HTTP，不支持旧版 SSE。
- 仅支持 OAuth 的服务需要显式提供 Authorization 请求头。
- ARC 派发的 Agent 继续使用各自的 MCP 配置。
