# 让本机 Agent 自动配置 ARC

[English](../auto-setup.md) | **简体中文**

全新 Mac 上，只要已登录本机 Agent，就可以从这一句话开始：

> 在这台电脑上配置 Agent Remote Control，按照 https://raw.githubusercontent.com/whzxc/agent-remote-control/main/skills/arc-setup/SKILL.md 操作。

skill 会检测 ARC，缺失时运行 release 安装脚本，给当前 Agent 安装配置 skill，再进入本机配置协议。macOS 安装脚本会校验 App 压缩包、安装并打开 ARC，等待 Core 就绪，无需挂载 DMG 或自行拼装命令。

远端验证通过 `act({"op":"connector_verify","args":{"code":"<验证码>"}})`；任务验收先读 `guide`，再通过 `act` 派发、`query` 等待与读取。若缓存的 guide 参数不接受 op，使用 `query({"op":"guide","args":{"op":"codex_create"}})`。MCP 工具固定为 guide / query / act，连接里的档位作用于 op。

## 在 App 中继续

已经安装 ARC 时，点击**添加控制源**，选择 **Claude（推荐）**或 **ChatGPT**，再点**发送给 Codex**。点击**打开 Codex 任务**继续对话；稍后可从首页的**继续配置**回到进度页。

Codex 已安装但未登录时，先点**登录 Codex**。尚未安装时，可以打开下载入口，或把配置提示词复制给其他本机 Agent。App 复制的提示词已包含当前实例的 CLI 路径和状态目录。其他平台与手动安装见[安装说明](installation.md)，可执行文件位置见 [CLI 参考](../reference/cli.md)。

## Agent 会做什么，何时需要你

选定目标后，Agent 一次说明将创建或授权的资源和本机工具访问范围并请你确认；已有明确确认时复用。确认后，Agent 直接操作已登录的配置页面：创建或复用隧道、创建 runtime key、完成风险提示和连接器创建，并通过已认证的本机 CLI 批准对应 ARC OAuth 请求。仅在需要登录、人机验证、密码/2FA、付款或自身安全策略要求时停下。路线选择仍在 Agent 对话中进行。

Cloudflare 固定地址由 ARC 管理授权证书、隧道和 DNS。其他凭据通过官方复制按钮和 ARC 剪贴板接收传递，只有保存成功才清空剪贴板。没有复制按钮或可用 UI 工具时，Agent 给出一句手动指引。不要把凭据发到聊天。远端测试在 Claude Code 云端会话或 ChatGPT 对话中执行，本机直接创建的任务不能证明该连接可用。

Agent 会等待 ARC 的完成信号。保持 Agent 对话打开；App 会显示当前步骤和需要你操作的按钮。入口页仍可选择**手动配置**。

## 限制

ChatGPT 配置默认直接尝试 OpenAI Secure Tunnel。遇到明确的 Platform 权限拒绝或 runtime key 被拒绝时，可选择重试或改用 HTTPS + OAuth，使用 Cloudflare 固定地址或临时地址。HTTPS 无需 Platform Tunnel 权限，但不能绕过 ChatGPT 工作区对自定义 MCP 的限制。未安装 Claude Code 时，Agent 会用 Anthropic 官方安装程序安装，再由 ARC 打开终端供你登录。Claude 自动回访需要已登录的本机 Claude Code CLI 和 Claude Code 云端会话；跳过 Claude Code 后不验证通知。本机命令成功或截图都不能单独证明远端连接可用。配置期间请保持电脑唤醒、联网，ARC 持续运行。
