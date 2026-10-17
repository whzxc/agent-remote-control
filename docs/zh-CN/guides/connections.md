# 选择 HTTPS 连接

[English](../../guides/connections.md) | **简体中文**

Claude 使用 HTTPS 入口和 OAuth；ChatGPT 优先使用 [Secure Tunnel](chatgpt.md)。每条入口有自己的提供商、凭据、URL 和工具列表。

| 提供商 | 需要填写 | 地址 |
| --- | --- | --- |
| Cloudflare 临时域名 | 无 | 自动生成的临时域名 |
| Cloudflare 固定域名 | Tunnel token、已配置的公开域名 | 固定域名 |
| ngrok | Authtoken；固定模式另填已配置域名 | 自动分配或固定域名 |
| Pinggy 临时域名 | 无 | 临时域名 |
| Pinggy 固定域名 | Token、已分配域名 | 固定域名 |
| LocalXpose | Access token、已保留或自定义域名 | 固定域名 |
| 自定义 | 公开 MCP URL、本机监听地址和端口 | 自建反向代理 |

## 连接

1. 在 ARC 打开控制源，编辑连接。
2. 选择提供商，填写所需字段；有**获取令牌**链接时可直接打开。
3. 选择客户端支持的认证：Claude 用 OAuth，支持 `Authorization` 头的客户端可用 Bearer。先保留默认工具列表。
4. 保存并连接。ARC 会按需下载提供商组件并管理进程。
5. 把显示的 MCP URL 填入客户端，在客户端执行连接验证提示词。

提供商凭据用于建立隧道，MCP 认证用于控制谁能通过隧道访问，两者分别填写。固定域名需要已在提供商账号中分配。

## 使用自定义反向代理

把公开 HTTPS 域名转发到 ARC 的本机监听端口。每条固定 Cloudflare 或自定义入口使用不同端口。OAuth 连接同时转发 `/mcp` 和 [OAuth 参考](../../reference/oauth.md#public-routes)列出的全部路由。ARC 管理 API 保持私有。

## 日常使用

长期使用选择固定地址。临时地址变化后，更新连接器 URL 并重新授权。提供商报错查看连接详情和记录；客户端问题查看[常见问题](../faq.md)。

## 限制

ARC 使用 Streamable HTTP，不提供独立的旧式 SSE 端点。LocalXpose 临时模式因首次请求跳转而不可用。提供商账号、域名、额度和出站连通性由你管理。认证选择 None 后，能访问端点的人均可使用其允许的工具。
