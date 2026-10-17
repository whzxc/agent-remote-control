# 接入其他客户端

[English](../../guides/other-clients.md) | **简体中文**

在 ARC 首页添加客户端，选择匹配的认证，再把 MCP URL 填到客户端。端点准备见 [HTTPS 提供商](connections.md)；[Claude](claude.md) 和 [ChatGPT](chatgpt.md) 有独立指南。

| 客户端 | 预设传输 / 认证 | ARC 预设状态 | 配置方式 |
| --- | --- | --- | --- |
| Grok (`grok`) | https / oauth | conditional | Plugins → New Connector → Custom；OAuth |
| Microsoft Copilot (`microsoft-copilot`) | https / bearer | conditional | Copilot Studio：Authorization 头或已注册 OAuth 客户端 |
| Notion (`notion`) | https / bearer | supported | Custom Agents；需工作区权限 |
| Slack (`slack`) | https / oauth | conditional | DCR 或本机预注册 OAuth；不支持 Bearer |
| Cursor (`cursor`) | https / bearer | supported | 远程 HTTP MCP，使用 Authorization 头 |
| GitHub Copilot (`github-copilot`) | https / bearer | supported | 在 IDE 或 CLI 宿主配置 MCP |
| Raycast (`raycast`) | https / bearer | supported | 在 AI MCP 设置配置 HTTP Headers |
| Custom (`custom`) | https / bearer | custom | 按客户端匹配传输与认证 |

Bearer 连接把入口令牌填到客户端的 `Authorization: Bearer <token>` 头。OAuth 连接完成客户端授权流程，并在 ARC 同意。随后从客户端执行连接验证提示词。

列表外客户端使用 Custom。同一种客户端可添加多条连接，使用容易区分的显示名；固定监听端口不要重复。`cli ingress presets` 返回当前注册表、官方客户端文档链接和支持的认证方式。

## 限制

supported 表示 ARC 有对应传输与认证路径；conditional 还需要客户端注册、租户或请求头配置。客户端套餐和管理员策略仍适用。ARC 不实现 Slack 身份签名、任意 API-key 头或 query token。不同连接共享任务空间。
