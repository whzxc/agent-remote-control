# 让本机 Agent 自动配置 ARC

[English](../auto-setup.md) | **简体中文**

在需要远程控制的电脑上[安装 ARC](installation.md)，然后打开 App。

## 发送给 Codex

点击**添加控制源**，选择 **Claude（推荐）**或 **ChatGPT**，再点**发送给 Codex**。ARC 会安装配置 skill、创建本机配置任务并显示进度。点击**打开 Codex 任务**继续对话；稍后可从首页的**继续配置**回到进度页。

Codex 已安装但未登录时，先点**登录 Codex**。尚未安装时，可以打开下载入口，或把配置提示词复制给其他本机 Agent。

## 交给其他本机 Agent

在 ARC 中选择**复制给其他 Agent**，或把下面这句话粘贴到本机 Codex 或 Claude Code 对话：

> 帮我配置这台电脑上已安装的 Agent Remote Control：找到它的 CLI，运行 `cli skill install --target codex`（Claude Code 改用 `--target claude-code`；其他 Agent 可跳过安装），读取 `cli setup playbook protocol` 并按 `cli setup` 推进；让我做选择和授权，密钥只填在 ARC 里，最后用 `cli setup wait` 确认完成。

其他本机 Agent 可以直接读取协议，无需安装 skill。可执行文件位置见 [CLI 参考](../reference/cli.md)。App 复制的提示词已包含当前实例的 CLI 路径和状态目录。

## Agent 会在哪些地方停下来等你

- **做选择：**使用 Claude 还是 ChatGPT、选择地址方式，以及是否跳过可选步骤。Agent 会解释选项并标出推荐项。
- **登录和授权：**由你登录账号、同意连接授权并授予本机权限。
- **填写凭据：**把运行时密钥或服务商凭据粘贴到 ARC 的表单里，不发进聊天。
- **远端测试：**本机 Agent 准备提示词，你把它粘贴到 Claude Code 云端会话或 ChatGPT 对话。ARC 验证远端连接与首个任务后，才显示完成。

Agent 会等待 ARC 的完成信号。保持 Agent 对话打开；App 会显示当前步骤和需要你操作的按钮。入口页仍可选择**手动配置**。

## 限制

ChatGPT 配置需要 OpenAI Platform 组织权限和 ChatGPT 开发者模式。Claude 自动回访需要已登录的本机 Claude Code CLI 和 Claude Code 云端会话；跳过 Claude Code 后不验证通知。本机命令成功或截图都不能单独证明远端连接可用。配置期间请保持电脑唤醒、联网，ARC 持续运行。
