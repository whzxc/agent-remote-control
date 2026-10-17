# 让本机 Agent 自动配置 ARC

[English](../auto-setup.md) | **简体中文**

全新 Mac 上，只要已登录本机 Agent，就可以从这一句话开始：

> Set up Agent Remote Control on this computer. Follow https://raw.githubusercontent.com/whzxc/agent-remote-control/main/skills/arc-setup/SKILL.md

skill 会检测 ARC，缺失时运行 release 安装脚本，给当前 Agent 安装配置 skill，再进入本机配置协议。macOS 安装脚本会校验 App 压缩包、安装并打开 ARC，等待 Core 就绪，无需挂载 DMG 或自行拼装命令。

## 在 App 中继续

已经安装 ARC 时，点击**添加控制源**，选择 **Claude（推荐）**或 **ChatGPT**，再点**发送给 Codex**。点击**打开 Codex 任务**继续对话；稍后可从首页的**继续配置**回到进度页。

Codex 已安装但未登录时，先点**登录 Codex**。尚未安装时，可以打开下载入口，或把配置提示词复制给其他本机 Agent。App 复制的提示词已包含当前实例的 CLI 路径和状态目录。其他平台与手动安装见[安装说明](installation.md)，可执行文件位置见 [CLI 参考](../reference/cli.md)。

## Agent 会在哪些地方停下来等你

- **做选择：**使用 Claude 还是 ChatGPT、选择地址方式，以及是否跳过可选步骤。Agent 会解释选项并标出推荐项。
- **登录和授权：**由你登录账号、同意连接授权并授予本机权限。
- **Cloudflare 固定地址：**选择 Cloudflare，登录并选择托管域名；ARC 自动创建或复用隧道、绑定地址，无需复制 token。
- **其他凭据：**Agent 点击服务商的复制按钮，ARC 直接接收并清空剪贴板；没有复制按钮时请你手动复制，ARC 表单保留为兜底。不要把凭据发到聊天。
- **远端测试：**本机 Agent 准备提示词，你把它粘贴到 Claude Code 云端会话或 ChatGPT 对话。ARC 验证远端连接与首个任务后，才显示完成。

Agent 会等待 ARC 的完成信号。保持 Agent 对话打开；App 会显示当前步骤和需要你操作的按钮。入口页仍可选择**手动配置**。

## 限制

ChatGPT 配置需要 OpenAI Platform 组织权限和 ChatGPT 开发者模式。未安装 Claude Code 时，Agent 会用 Anthropic 官方安装程序安装，再由 ARC 打开终端供你登录。Claude 自动回访需要已登录的本机 Claude Code CLI 和 Claude Code 云端会话；跳过 Claude Code 后不验证通知。本机命令成功或截图都不能单独证明远端连接可用。配置期间请保持电脑唤醒、联网，ARC 持续运行。
