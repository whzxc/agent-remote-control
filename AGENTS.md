# 开发约定

- 采用 MIT 许可证。公开源码与桌面产物在 GitHub 维护。推送与发布必须获得用户授权；本项目不发布公共 npm 包。
- 使用 macOS 与 Windows 桌面及 Linux x86_64 / aarch64 无界面核心；业务代码不依赖其他项目或个人环境。采用 Tauri + Rust 原生桌面，Node/npm 仅用于开发构建；本机 Tunnel Client 的安装、配置与生命周期由产品管理，Tunnel 身份申请和服务端仍使用官方方案。
- 不使用 Git worktree，不保留旧实现的 alias、shim 或迁移兼容层。
- 外部数据读取以当前原生登录和上游响应为准，不额外核验账号、凭据有效期或内容敏感性，不以本地推断拒绝读取或改写结果。保留 MCP OAuth、入口授权、任务关联及资源边界等自身功能必需的校验。
- 不新增测试文件或用例；迁移已有测试不扩大覆盖。运行已有检查和真实验收。
- 直接调用 cargo 构建或测试后，运行 `npm run cache:prune` 检查编译缓存预算。
- 提交信息使用 Conventional Commits：`type(scope): 中文说明`，单行不写 body。
- 私人路径、账号、密钥、Tunnel 身份及真实任务内容不进入版本库。
- 文档只描述当前功能、架构、限制和操作方法，不保留过程记录、验收结果、决策日志或个人环境信息。

## UI 组件约定

- 所有单选控件统一使用 `SingleChoice`：选项数 ≤ 5 且宽度足够时使用胶囊选项卡；> 5 或宽度不足时使用下拉选择。禁止在业务页面直接新增 独立 Select、原生 `select` 或重复实现单选样式；主题统一配置，保留键盘导航、禁用状态与表单校验。

- 渲染层使用 React；通用控件复用 `ui/components/ui/index.tsx`，复杂交互使用 Radix；不在业务页面重新手写同类控件。
- 语义 token 统一在 `ui/tokens.css` 配置，深浅色状态使用 `ui/theme.ts`，默认跟随系统；功能图标统一使用共享 `Icon` 包装的 Lucide 16/20px、1.75px 描边。品牌图形保留各自资源。
- 编辑弹窗复用 `Dialog`，表单使用原生 `form` 和共享 `Field` / `Input`，默认单列、标签在上，仅短且相关的字段可并排。校验错误归属字段并关联输入，提交失败聚焦首个错误；浮层关闭后恢复触发点焦点。
- 首页默认使用 ARC 标识与耳罩连线；吉祥物为可选外观，启用时保留互动。保留拓扑、节点展开面板的空间形变和简化的触感开关；功能页采用安静、紧凑、一致的布局。工作区面板标题栏在顶部，打开关闭仅使用不超过 180ms 的淡入淡出与轻微位移；面板内部及嵌套视图只切换内容，不形变整个面板。同组 tooltip 保持连续显示并平滑移动、调整尺寸，悬停高亮使用共享弹簧跟随层，额度气泡在触发点之间连续跟随。保留 reduced-motion、键盘导航、逐层 Escape 和焦点恢复。Radix 负责通用交互基础；布局组件只管排列，不复制标准输入框和按钮样式。详细规范见 `docs/dev/ui.md`。

## 文档分层

- 门面层：README.md 与 README.zh-CN.md，围绕 Claude + Codex Loop 和 ChatGPT Chat + Codex，保持简短。
- 上手与指南层：docs/getting-started.md、concepts.md、guides/、auto-setup.md、faq.md、installation.md、story.md 使用英文主文件，并在 docs/zh-CN/ 保留路径对应的完整中文版；内容同步。
- 参考层：docs/reference/ 只用英文，集中维护工具、Agents、CLI、OAuth、订阅与 Linux 的精确契约。
- 维护层：docs/dev/ 只用中文，描述开发、发布、架构和 UI；内部生命周期归入架构。
- 用户指南按任务组织，短句、先操作；真实限制集中在篇末 Limits / 限制，不反复防御性说明。
- 事实以当前源码、cli help 与 cli guide 为准。更新路径时同步内部链接、应用/CLI URL 和 README 的 Agent 提示词；cli guide 内嵌 docs/reference/cli.md。
