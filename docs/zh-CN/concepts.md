# ARC 的几个概念

[English](../concepts.md) | **简体中文**

```text
Claude / ChatGPT / 其他客户端
           │
    入口 A       入口 B          认证 + 允许使用的工具
           └──────┬──────┘
                Core             共享项目和任务
          ┌───────┴────────┐
    Codex Desktop       后台 Agents
```

## 控制源

你提出工作请求的应用，例如 Claude、ChatGPT 或其他 MCP 客户端。可以添加多个控制源，也可以为同一个应用建多条连接。控制源名称用于标记连接，不是用户账号。

## 入口（Ingress）

通往 ARC 的一条连接，有自己的传输方式、认证、工具列表和启停控制。Claude 通常使用 HTTPS + OAuth，ChatGPT 默认使用 OpenAI Secure Tunnel。停止一条入口不影响其他入口。

## Core

读取项目事实、分派任务的本机服务。同一个 ARC 实例的入口共享项目和任务。关闭 ARC 窗口后，连接继续运行，可以通过菜单栏或托盘打开窗口。

## Agent

在电脑上实际执行工作的程序。Codex 使用原生任务接口，Pi 和 ACP Agent 使用各自安装的程序、配置和登录。在首页 Agent 管理面板启用更多 Agent。

## 任务归属

开启**自动打开 Codex 任务**时，新 Codex 任务由 Codex Desktop 执行；关闭后，新任务由 ARC 的后台 App Server 执行。已有任务保持原归属。Linux 上 Codex 始终在后台执行。任务回执确认派发，最终结果通过读取或等待任务获得。

## 工具档位

在连接编辑器选择**默认**、**只读**、**全部**或**自定义**。默认覆盖项目事实和日常 Codex 工作，全部增加高级操作，自定义逐项选择。只读用于审查，连接验证是维护例外。详见[工具参考](../reference/tools.md)。

## 限制

工具档位控制连接暴露哪些工具，不改变 Agent 的操作系统权限。入口共享任务，不是独立用户工作区。最后一个 Core 客户端退出后，ARC 拥有的后台进程会停止；Desktop 拥有的 Codex 任务遵循 Desktop 生命周期。
