# ChatGPT Desktop 插件

两个本地插件独立维护：

- [ChatGPT Usage Plugin](https://github.com/whzxc/chatgpt-usage-plugin)：全局用量和任务用量两个面板。
- [ChatGPT Kanban Plugin](https://github.com/whzxc/chatgpt-kanban-plugin)：卡片、检查清单、任务关联和显式任务执行。

每个仓库拥有自己的原生运行时、面板、构建、发布产物和市场分支。两个插件不依赖 Agent Remote Control（ARC） Desktop，也不相互依赖。安装和开发方法以各自仓库文档为准。

Agent Remote Control Desktop 保留远程 MCP 入口、Tunnel、订阅管理和原生桌面界面。应用更新只负责桌面产品，不同步本地 ZIP 插件，也不发布插件市场。

插件使用独立数据目录，不会自动覆盖已有安装或迁移 Agent Remote Control 私有数据。
