# 完成第一个 Claude + Codex 闭环

[English](../getting-started.md) | **简体中文**

## 1. 在 macOS 安装

从 [Releases](https://github.com/whzxc/agent-remote-control/releases/latest) 下载 Apple Silicon DMG。把 **Agent Remote Control** 拖入 Applications，推出 DMG，再打开应用。安装 Codex Desktop 并登录。要接收自动回访，再安装并登录 Claude Code CLI。

macOS 拦截已核验的下载时，在**系统设置 → 隐私与安全性 → 仍要打开**中处理。若提示“已损坏”，仅移除此应用的隔离标记：

```sh
xattr -rd com.apple.quarantine "/Applications/Agent Remote Control.app"
```

## 2. 接入 Claude

1. 在 ARC 首页点击**添加控制源**，选择 **Claude**。
2. 选择 **HTTPS**、**OAuth** 和隧道提供商。首次可用 Cloudflare 临时域名，长期使用选择固定地址。
3. 保存并连接，复制显示的 MCP URL。
4. 在 Claude 的连接器设置里添加自定义连接器，填入 URL，发起授权。
5. 保持授权页打开，点击**打开 ARC**，在 ARC 核对请求并允许。返回 Claude，在对话中启用连接器。
6. 复制连接的验证提示词，让 Claude 执行；它会通过刚添加的连接调用 `connector_verify`。

## 3. 派任务并接收通知

在 claude.ai 打开 Claude Code 云端会话，发送下面的提示词。Claude 可以从自身环境读取会话 ID，例如 `CLAUDE_CODE_REMOTE_SDK_URL` 中的 `cse_…`：

> 通过 ARC 创建 Codex 任务，不调用工具、不读取文件，只回复 ARC_LOOP_OK。使用新 requestId，把你自己的 Claude Code 云端会话设为 notifyClaudeSession。读取回执，保留 threadId 和 turnId，然后结束本轮。完成通知唤醒本会话后读取结果，确认内容一致。

若 Claude 无法读取自身会话 ID，再手动粘贴云端会话 URL 或 ID。

Codex 轮次完成后，ARC 的状态通知唤醒同一 Claude 会话，让它读取结果；处理真实工作时，它可以审查 diff，再继续同一个任务。[Claude 指南](guides/claude.md)说明任务提示词、审批和下一轮操作。

## 下一步

- 让本机 Agent 配置：[自动配置](auto-setup.md)。
- 理解任务归属与工具权限：[概念](concepts.md)。
- 使用 ChatGPT Chat：[ChatGPT 指南](guides/chatgpt.md)。
- 使用 Windows、Homebrew 或 Linux：[安装说明](installation.md)。

## 限制

电脑需保持唤醒、联网，ARC 需保持运行。自动回访发送到 Claude Code 云端会话，普通 Claude 聊天链接不能接收。离开电脑前，在运行 ARC 的电脑上完成首次 OAuth 同意。连接或通知失败时查看[常见问题](faq.md)。

## 检查权限与就绪

远程使用前，在本机打开 ARC **设置 → 权限与就绪**，点击 **重新检测**。按需点击 **去授权**，从系统设置切回 ARC 会自动刷新。

辅助功能用于 screen tree / press / show / key / raise；屏幕录制用于 capture 和 windows 标题，授权后可能需要重开 ARC。文件访问统一引导完全磁盘访问：项目在文稿、桌面、下载、外置盘、网络卷时，没有授权可能弹窗或失败。Core 的只读探测为启发式，结果为 granted / missing / unknown；unknown 不代表已授权。command 另在 Codex app-server 内探测，FDA 未就绪时拒绝任意 shell 命令。

通知权限在 ARC Desktop 中检测，用于闭环通知兜底；Desktop 未运行时仅记日志。登录时启动检查注册与禁用状态。Codex、Claude 和入口验证状态在同页查看。Windows/Linux 不适用的系统授权不要求开启。

### 远程工具为什么返回 PERMISSION_REQUIRED？

工具不会主动请求系统权限。错误包含 permissionId，请在本机权限页处理后重试。不要把 CLI 所在终端的授权当作 Core、screen helper 或 Codex 执行宿主的授权。FDA 的启发式结果不保证所有卷可访问。

打包 Desktop 的启动链中，完全磁盘访问授权对象为 ARC App：Core 及其启动的 Codex app-server 子进程继承该应用身份。终端单独启动 Core 可能继承终端身份，不能用它的探测结果证明 App 已就绪。
