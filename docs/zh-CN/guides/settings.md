# 让你的 Agent 配置高级设置

[English](../../guides/settings.md) | **简体中文**

在 **设置** 中管理任务行为、登录启动、通知、语言、明暗外观、macOS 应用显示位置、系统权限和更新。专用设置交给你自己的 Agent 通过 CLI/AX 修改。以下命令与 [CLI 参考](../../reference/cli.md#advanced-settings-through-cliax) 一致。

> 读取我的 ARC 实例的当前设置，通过 CLI/AX 只修改我指定的值，然后回读并报告结果。

## 请求转交延迟

设置待处理请求转交给控制源前的等待时间。范围为 0–300 秒，默认 15 秒。这不会批准请求。

```sh
arc cli call tasks.settings.get
printf '%s' '{"body":{"requestRoutingDelaySeconds":30}}' | arc cli call tasks.settings.set --stdin
arc cli call tasks.settings.get
```

## 代理

为 ARC 设置 HTTP 或 HTTPS 代理。先读取当前配置：

```sh
arc cli call network.get
printf '%s' '{"proxyMode":"custom","proxyUrl":"http://127.0.0.1:7890"}' | arc cli network --stdin
arc cli call network.get
```

使用系统代理时运行以下命令。直连时把 `system` 改为 `direct`，`proxyUrl` 同样留空。

```sh
printf '%s' '{"proxyMode":"system","proxyUrl":""}' | arc cli network --stdin
```

新的出站请求使用已保存的代理。现有连接的隧道进程需要采用新代理时，重新连接该连接。

## 额度采集和刷新

先读取设置，再提交 `enabled` 和 `refreshMinutes`。示例启用额度采集，每五分钟刷新一次。只改一项时，保留另一项的当前值。刷新间隔支持 1、3、5、10 分钟，默认 3 分钟。Agent 详情中仍可手动刷新额度。

```sh
arc cli subscriptions get
printf '%s' '{"enabled":true,"refreshMinutes":5}' | arc cli subscriptions set --stdin
arc cli subscriptions get
```

## 显示偏好

先读取偏好，只发送需要修改的键。这个示例修改强调色和任务气泡密度：

```sh
arc cli call preferences.get
arc cli call preferences.set --stdin <<'JSON'
{"body":{"values":{"theme-color":"blue","task-bubble-density":"compact"}}}
JSON
arc cli call preferences.get
```

| 设置 | 键 | 可选值（默认值在前） |
| --- | --- | --- |
| 强调色 | `theme-color` | `arc`、`blue`、`purple`、`orange`、`green` |
| 气泡密度 | `task-bubble-density` | `standard`、`compact`、`detailed` |
| 气泡宽度 | `task-bubble-width` | `medium`、`narrow`、`wide` |
| 自动压缩气泡 | `task-bubble-auto-compact` | `on`、`off` |
| 拓扑方向 | `topology-layout` | `auto`、`landscape`、`portrait` |
| 额度百分比 | `quota-display` | `remaining`、`used` |
| 额度重置时间显示 | `quota-reset-display` | `countdown`、`time` |

例如：

```sh
arc cli call preferences.set --stdin <<'JSON'
{"body":{"values":{"topology-layout":"auto","task-bubble-width":"wide","task-bubble-auto-compact":"on","quota-display":"used","quota-reset-display":"time"}}}
JSON
```

## 维护者模式

维护者模式默认关闭，用于开启开发 AX 能力。使用完毕后设回 `false`：

```sh
arc cli config get
printf '%s' '{"maintainerMode":true}' | arc cli config set --stdin
arc cli config get
```

## 更新技术策略

这些策略接受 `on` 或 `off`，默认均为 `on`。只发送需要修改的键：

- `update-accept-local`：允许替换为本地构建。关闭后也会阻止从本地备份替换。
- `update-resume`：替换后续跑被中断的任务。
- `update-control-scheduling`：允许控制源安排更新。

```sh
arc cli call preferences.get
arc cli call preferences.set --stdin <<'JSON'
{"body":{"values":{"update-accept-local":"off","update-resume":"on","update-control-scheduling":"on"}}}
JSON
arc cli call preferences.get
```

发行更新使用稳定渠道。自动安装或安装前询问仍在设置中选择。

## 限制

命令作用于选中的 ARC 实例。指定其他实例时使用 `arc cli --state-dir <absolute-directory>`。CLI 偏好在下一次连接状态刷新后显示。额度刷新间隔不会改变账户轮询或原生额度缓存。系统授权仍由操作系统处理。
