# ChatGPT Desktop plugins

The two local plugins are maintained independently:

- [ChatGPT Usage Plugin](https://github.com/whzxc/chatgpt-usage-plugin): global usage overview and per-task usage panels.
- [ChatGPT Kanban Plugin](https://github.com/whzxc/chatgpt-kanban-plugin): cards, checklists, linked Agent tasks and explicit task execution.

Each repository owns its native runtime, UI, builds, release archives and marketplace branch. Neither plugin requires Agent Remote Control（ARC） Desktop, and they do not depend on each other. Follow the installation and development instructions in the respective repository.

Agent Remote Control Desktop owns remote MCP ingress, Tunnel, subscriptions and its native desktop interface. Its updater only updates the desktop application; it does not synchronize local ZIP plugins or publish a plugin marketplace.

Plugin state is independent of Agent Remote Control state. Existing installations and private data are not automatically replaced or moved.
