# 开发

[项目首页](../../README.zh-CN.md) · [架构](architecture.md) · [UI](ui.md) · [发布](release.md)

## 环境与启动

安装 Node.js 24.12+、仓库指定的 Rust 工具链和平台构建依赖。macOS 原生图标与安装包需要完整 Xcode 26+，DMG 布局构建使用 uv。Windows 使用 MSVC 工具链和 WebView2。运行产物不依赖 Node/npm。

```sh
npm ci
npm run dev
```

开发入口启动 Tauri、Vite 和当前源码构建的 Core，支持前端与 Rust 热更新。macOS 使用独立的 Agent Remote Control Dev.app、图标与 bundle identifier。状态默认位于平台状态目录下的 agent-remote-control-dev；ARC_STATE_DIR 可显式覆盖。Vite 与开发桌面使用同一目录和同一 Core owner。

```sh
npm run dev:ui
```

单独运行 Dev Web 时，Vite 默认连接安装版状态目录中的已有 Core，与安装版共享数据，页面操作直接作用于安装版后台。请先启动安装版应用；没有 owner 时显示后端不可用，不自动启动另一套 Core。

Dev Web 只有在显式设置 ARC_STATE_DIR 时才连接独立数据目录。例如，在 macOS 上连接由 npm run dev 启动的开发后台：

```sh
ARC_STATE_DIR="$HOME/.local/state/agent-remote-control-dev" npm run dev:ui
```

自定义隔离预览时，为 Core 与 Dev Web 显式设置相同的 ARC_STATE_DIR。npm run dev 仍默认使用独立开发目录，并将该目录传给它启动的 Vite。不要把开发桌面或另一个 Core 指向正在使用的正式状态目录。

## 已有检查

```sh
npm run check
npm run check:format
npm test
npm run build
npm run desktop:check
```

check 检查 React/TypeScript；check:format 检查 Rust 格式。test 执行已有 Rust 单元测试和 MCP fixture 合同测试，fixture 使用独立临时状态。build 编译前端、Core 和适用的屏幕 helper；desktop:check 检查桌面 crate。不得新增测试文件或用例，迁移已有测试不扩大覆盖。

直接运行 Cargo 构建或测试后执行：

```sh
npm run cache:prune
```

工作区共享根 Cargo.lock 和 target。编译缓存预算为 30 GiB，清理非活跃 profile 组，保留运行中、受保护的产物以及唯一数据。`npm run cache:prune -- --dry-run` 预览操作；预算不是整个 target 目录的总大小上限。

## 桌面产物

```sh
npm run desktop:build
npm run check:package
```

构建会重新编译前端，再生成原生包，不安装或替换本机应用。macOS 产物位于 target/aarch64-apple-darwin/release/bundle，Windows 使用 x64 NSIS。check:package 检查版本、原生签名和图标资产，并拒绝 Node/npm 等旧运行时资源。完整发布与签名见[发布](release.md)。

应用包包含 Desktop、独立 Core、静态前端、图标和必要许可。Tunnel Client 按需从官方来源准备。外部 Agent 使用其原生安装；Claude ACP 适配器在显式启用后单独准备。构建脚本重映射 Rust 源码路径，避免把维护者路径写入产物。

版本统一从 ARC_BUILD_VERSION、最近可达 v-tag、0.0.0 依次解析。package.json、Cargo 和 Tauri 的 0.0.0 是内部占位值。正式产物在已有功能提交上注入版本，不生成升版提交。

## 原生图标与品牌

`assets/brand` 保存品牌源图。`npm run brand -- primary` 生成当前等粗圆头圆弧品牌，alternate 生成收尖备选。所有平台图标统一从这里派生。

macOS 使用 Icon Composer 文档、actool 生成的 Assets.car 和静态 ICNS 回退。CFBundleIconName 与 CFBundleIconFile 保持同一个无扩展名名称。DEVELOPER_DIR 可选择完整 Xcode；脚本也支持标准 Xcode 安装。开发图标从同一分层源图派生，不复制独立设计。

## 订阅额度开发

Core 负责订阅额度读取、刷新调度和当前读数缓存；React 共享 QuotaBubble、QuotaRing 和悬停详情。桌面通过 subscriptions:changed 收到更新；浏览器通过 Vite 转发的已认证 /api/subscriptions/events 接收快照。流断开后重新跟随当前 owner，轮询仅作回退。

额度来源、缓存与节奏规则见[订阅参考](../reference/subscriptions.md)。原生登录、桌面事件与浏览器事件流分别验证。不采集本地用量日志，不维护 Token 统计或价格数据。

## 插件边界

Usage、Kanban 的源码、开发服务器和打包属于各自独立仓库，ARC 不构建它们的资源或 ZIP。tooling/export-plugin.mjs 仅调用外部二进制 export；覆盖参数使用 mcpServers.arc、ARC_STATE_DIR 和 ARC_PLUGIN_DEV_HTML。外部产物必须实现同一接口，本仓库不保留旧名兼容。

## 文档维护

README 和上手/指南保留英文主文件与完整中文对照；参考层 docs/reference 只用英文，维护层 docs/dev 只用中文。cli guide 内嵌 docs/reference/cli.md，改路径后需重编译 Core。文档描述当前行为、限制和操作，不保存验收过程或个人环境。修改后检查所有内部链接、CLI 输出和语言对应关系。
