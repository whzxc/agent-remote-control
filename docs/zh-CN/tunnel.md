# 接入控制源：OpenAI Tunnel 与 HTTPS MCP

多个控制源入口可以同时运行并共享同一个 Core。每个入口都可以从首页拓扑独立新增、编辑，也可以使用 `cli ingress`；认证、工具策略、服务商配置、验证和生命周期都归属于该入口。固定 HTTPS 入口使用各自配置的本机监听端口；同一主机上的多个固定入口必须使用不同端口，并与反向代理路由保持一致。

[English](../tunnel.md) | **简体中文**

> 本文对应英文版本；若有差异，以[英文版本](../tunnel.md)为准。

返回[项目首页](../../README.zh-CN.md)。推荐先复制首页消息，让本机 Codex 按[配置与排障指南](codex-setup.md)完成接入。ChatGPT 默认推荐官方 OpenAI Secure Tunnel；其他控制源通常根据[支持矩阵](control-sources.md)使用 HTTPS MCP。以下为手动操作说明。普通使用者从原生应用首页拓扑新增或打开控制源，缺失的连接组件由应用自动准备，无须手工创建服务商 profile。

## HTTPS MCP

新增或编辑控制源时选择 HTTPS MCP，再选择接入方式。每个入口可独立选择 **无需认证**、**Bearer** 或 **OAuth**；应根据目标客户端与 ARC 的共同支持范围选择，详见[控制源支持矩阵](control-sources.md)。OAuth 使用 ARC 本机授权服务和所有者确认，详见 [OAuth 认证](../oauth.md)。本项目不提供托管中继。

| 接入方式 | 必填内容 | 应用处理 | 使用边界 |
| --- | --- | --- | --- |
| Cloudflare · 临时域名 | 无 | 下载 cloudflared、开启 Quick Tunnel、获取公网地址 | 免账号和域名；临时地址可能随重连变化，适合试用，不保证可用性 |
| Cloudflare · 固定域名 | Tunnel Token、固定域名 | 下载 cloudflared、运行正式 Tunnel，并监听该入口配置的本机端口 | 用户的 Cloudflare 账号需要已接入的域名，并配置指向该端口的公开路由 |
| ngrok | 账号的 Authtoken | 下载 ngrok、启动隧道、获取账号分配的公网地址 | 需要 ngrok 账号，受该账号的流量、请求和并发限制 |
| Pinggy | 临时模式无需凭据；固定模式需 Token 和已绑定域名 | 下载 Pinggy CLI，启动和停止本入口隧道 | 固定域名必须事先绑定到 Token |
| LocalXpose | Access Token 和已预留域名 | 下载 loclx，启动隧道并获取 HTTPS 地址 | 仅固定域名；域名必须事先准备好 |
| 自定义域名 | 公网 MCP URL | 启动本机 MCP 监听 | 用户准备域名、有效 TLS 证书和反向代理 |

### Cloudflare 临时域名 / ngrok

1. 选择 Cloudflare，或选择 ngrok 并通过「获取令牌」取得自己的 Authtoken。
2. 点击「保存并重连」。应用自动准备官方组件，使用独立的随机 loopback 端口和临时配置运行隧道，不改动已有 cloudflared/ngrok 配置。
3. 打开该入口详情，将 MCP URL 配置到目标 MCP 客户端，并与入口保持相同认证方式：无需认证不填写凭据，Bearer 使用该入口生成的 token，OAuth 按客户端授权流程完成。ChatGPT 可从首页接入引导打开 Plugins；也可以提供已授权的登录网页，让 Codex 读取 `cli onboarding` 后通过受支持界面代填。
4. 使用接入流程中该入口的验证消息，从真实控制源调用 `connector_verify`；ARC 收到匹配验证码后确认该入口。临时地址变化后，需要在对应客户端更新或重建 MCP 连接；旧公网身份对应的验证记录不会沿用。

Cloudflare 临时域名使用 [Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)，仅用于试用，不提供独立 SSE 流支持；当前原生 MCP 使用 JSON POST，不依赖 SSE。cloudflared 需要连通 Cloudflare 的出站 7844 端口，不能假设普通 HTTP 代理能代理其数据通道。长期使用固定地址可选择 Cloudflare 固定域名、ngrok 或自定义域名。ngrok 的账号、域名和额度由用户在 [ngrok](https://ngrok.com/download) 管理，应用不会创建付费资源。

连接组件从官方 HTTPS 地址下载并缓存在本机。Cloudflare 下载包校验官方 SHA256；ngrok 从官方下载站获取，缓存文件使用本地 SHA256 检测损坏。Authtoken 只用于 ngrok 客户端，不传给 MCP 控制源，也不写入命令参数或常规状态响应。关闭连接、启动失败或退出应用会停止隧道和 MCP 监听，并清理临时运行配置。

ngrok 提供「临时域名」和「固定域名」两种模式，均只需 Authtoken。临时域名模式自动获取 ngrok 分配的地址，重启后地址可能变化，需同步更新 MCP 客户端。固定域名模式由用户填写已在 ngrok 账号中配置好的域名（也可填写不含路径的 HTTPS 地址），应用使用该域名启动隧道并提供 `/mcp` 地址；不会查询账号域名、申请域名或创建付费资源。固定域名不可用时直接报错，不回退到临时域名。

### Pinggy / LocalXpose

两者复用现有的保存、启动、停止和重新获取流程。官方客户端仅在首次使用时下载，缓存在应用包外，不要求安装 Node.js。Pinggy 发布文件校验官方 SHA256；LocalXpose 使用官方 HTTPS 下载和本地缓存哈希校验。

Pinggy 临时模式无需 Token；固定模式需要已绑定持久域名的 Token。LocalXpose 需要 Access Token 和已有的预留域名或自定义域名。临时模式会把首次 MCP 请求从 `/mcp` 重定向到其他路径，因此暂不开放。应用不购买套餐、不预留域名，固定域名不匹配时直接失败，不选择其他地址。

服务商凭据与入口的 MCP 认证独立。Pinggy 通过私有配置文件接收 Token，daemon 状态归 ARC 管理；LocalXpose 通过子进程环境变量接收 Token。两者都不在命令参数或状态响应中暴露凭据。停止 Pinggy 入口只停止该入口的隧道，不停止用户的 Pinggy daemon 或其他隧道。
