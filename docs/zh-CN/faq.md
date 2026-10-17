# 常见问题与排障

[English](../faq.md) | **简体中文**

## macOS 提示应用已损坏

核对发布校验和，把应用移入 Applications，再按[安装说明](installation.md#macos)处理 Gatekeeper。隔离命令只作用于下载的这个应用。

## 客户端连不上

打开 ARC 对应连接详情，查看错误。核对公开 URL 或 Tunnel ID，再从该客户端执行验证提示词。HTTPS 检查域名，并转发 OAuth 路由；Secure Tunnel 分别检查 Platform Tunnel 权限和 ChatGPT Developer Mode。`cli ingress doctor <id>` 可查看单条连接诊断。

## OAuth 打开了另一台电脑的 ARC

Deep link 打开的是浏览器所在设备的应用。请在承载连接的电脑上同意待处理请求，再返回原授权页。也可以使用已认证的 CLI。详见 [OAuth](../reference/oauth.md)。

## 新能力没有出现

MCP 工具始终是 `guide`、`query`、`act`。在连接编辑器保存 op 列表，重新调用 `guide` 查看当前目录；重新选择预设可采用新增 op，已保存的自定义列表保持精确。其他 Agent 的 op 仅在本机已安装、可用且启用时出现。从旧工具面升级后，需要在客户端刷新一次工具并重新授权；此后能力更新通过 guide 披露。

## Codex 任务在哪里执行？

查看回执或结果中的 `executionOwner`。新任务默认由 Desktop 执行。关闭**自动打开 Codex 任务**只改变之后创建的任务，让它们使用 ARC 后台执行器。继续任务时沿用原 ID。详见[概念](concepts.md)。

## 等待超时，要重新派任务吗？

使用原任务和轮次 ID 再次调用 `query codex_wait` / `query agent_wait`，将返回的 snapshotHash 作为 expectedHash。派发结果不明时，先读原回执。等待超时不停止任务。

## Claude 没收到回访

检查 notify 是否使用 claude-session 通道、target 是否为自己的 Claude Code 云端会话、本机 Claude Code CLI 是否已登录、ARC 是否持续运行。读取 `notification` 和记录。投递只尝试一次；通知失败后直接读取任务。详见 [Claude](guides/claude.md)。

## 可以关窗口或离开电脑吗？

关闭 ARC 窗口后菜单栏或托盘进程继续运行。电脑需保持唤醒和联网；休眠或断网会中断远程访问。最后一个 Core 客户端退出后，其后台 Agents 停止；Codex Desktop 任务遵循 Desktop 生命周期。

## 为什么额度信息缺失或过期？

在 ARC 打开对应 Agent，刷新额度，查看上游错误和原生登录。部分来源只返回套餐而没有额度。缓存读数会标记为过期。详见[订阅参考](../reference/subscriptions.md)。

## 限制

临时隧道 URL 可能变化，首次授权和任务交互可能需要你处理。普通 Chat 需保持等待或再次发消息查询进度；Claude 自动回访使用上述云端会话配置。

## 检查权限与就绪

远程使用前，在本机打开 ARC **设置 → 权限与就绪**，点击 **重新检测**。按需点击 **去授权**，从系统设置切回 ARC 会自动刷新。

辅助功能用于 screen tree / press / show / key / raise；屏幕录制用于 capture 和 windows 标题，授权后可能需要重开 ARC。文件访问统一引导完全磁盘访问：项目在文稿、桌面、下载、外置盘、网络卷时，没有授权可能弹窗或失败。Core 的只读探测为启发式，结果为 granted / missing / unknown；unknown 不代表已授权。command 仅在 cwd 位于受保护位置时，通过实际执行通道检测 FDA 并快速失败。

通知权限在 ARC Desktop 中检测，用于闭环通知兜底；Desktop 未运行时仅记日志。登录时启动检查注册与禁用状态。Codex、Claude 和入口验证状态在同页查看。Windows/Linux 不适用的系统授权不要求开启。

### 为什么更新后需要重新授权？

macOS 授权绑定应用的代码签名身份。正式 macOS 构建使用固定的个人自签名证书和稳定的 bundle identifier，保持升级前后的身份一致。从旧 ad-hoc 构建首次切换到这张证书时，可能需要重新授权一次。更换证书，即使名称相同，也可能使已有授权失效。更新后在 **设置 → 权限与就绪** 检查状态；未核对签名身份前，不要反复移除并重新授权。

### 远程工具为什么返回 PERMISSION_REQUIRED？

工具不会主动请求系统权限。错误包含 permissionId，请在本机权限页处理后重试。不要把 CLI 所在终端的授权当作 Core、screen helper 或 Codex 执行宿主的授权。FDA 的启发式结果不保证所有卷可访问。

打包 Desktop 的启动链中，完全磁盘访问授权对象为 ARC App：Core 及其启动的 Codex app-server 子进程继承该应用身份。终端单独启动 Core 可能继承终端身份，不能用它的探测结果证明 App 已就绪。

不检查命令参数中引用的路径；开启 FDA 可避免调用中弹窗。

### 屏幕录制开关已打开，为什么仍显示“未授权”？

重新打开 ARC，再点击 **重新检测**。ARC 检测的是 screen helper 实际可用的权限；系统设置中的开关已打开，不足以证明运行中的应用已获得权限。

应用身份变更后，macOS 可能用相同的应用名称显示旧身份的授权。当前 ARC 使用 `com.whzxc.agent-remote-control`，旧构建使用过 `com.whzxc.local-connector.desktop`。如果移除后重新授权仍无效，不要反复操作，应先核对授权实际写给了哪个身份。LaunchServices 中注册的旧应用副本，以及长期运行的系统授权提示进程，都可能保留旧身份。

排查时只注销已确认的旧副本注册，重新注册当前安装版，完整退出系统设置；日志确认系统授权提示进程是来源时，再重启该进程。保留备份和现有授权记录。确认旧注册和旧进程已清理后，再次授权并核对 ARC 状态。ARC 不会自动重置权限数据库或管理这些系统进程。
