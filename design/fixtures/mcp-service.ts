export const services = {
  docs: {
    title: "docs",
    transport: "Streamable HTTP",
    address: "https://tools.example/mcp",
    status: "已连接",
    count: 3,
    meta: "请求头：Authorization · 由 Claude 添加 · 刚刚检查",
    icon: "globe",
    error: {
      title: "需要凭据",
      detail: "服务拒绝了 ARC 的请求。Agent 可以补充所需的请求头。",
      code: "MCP_HTTP_401: Set the required Authorization or custom headers with mcp_configure update",
    },
  },
  notes: {
    title: "notes",
    transport: "本地命令",
    address: "notes-mcp",
    status: "可用",
    count: 2,
    meta: "环境变量：NOTES_TOKEN · 从 Codex 导入 · 18分钟前检查",
    icon: "terminal",
  },
  index: {
    title: "local-index",
    transport: "本地命令",
    address: "index-mcp",
    status: "",
    meta: "本机添加 · 刚刚检查",
    count: 0,
    icon: "terminal",
    error: {
      title: "命令未能启动",
      detail: "确认命令已安装，并且位于 ARC 的搜索路径中。",
      code: "MCP_COMMAND_NOT_FOUND: index-mcp was not found on ARC's Agent search path",
    },
  },
  archive: {
    title: "archive",
    transport: "本地命令",
    address: "/opt/example/bin/archive-mcp",
    status: "已关闭",
    count: 0,
    meta: "",
    icon: "terminal",
  },
};
export const tools = [
  {
    name: "search_docs",
    kind: "只读",
    description: "Search the sample documentation index",
  },
  {
    name: "read_page",
    kind: "只读",
    description: "Read one documentation page by path",
  },
  {
    name: "publish_page",
    kind: "破坏性",
    description: "Publish a reviewed draft to the sample documentation site",
  },
];
export const agents = ["Codex", "Claude Code", "Cursor", "Gemini CLI"].map(
  (label) => ({ value: label, label }),
);

export const copy = {
  "text1": " · ",
  "text2": " 个工具",
  "text3": "MCP 中枢",
  "text4": "Expand",
  "text5": "添加服务",
  "text6": "Refresh",
  "text7": "Expand",
  "text8": "4 个服务 · 1 个可用 · ",
  "text9": "2 个异常",
  "text10": "· 2 个工具",
  "text11": "一次连接 MCP 服务",
  "text12": "连接到 ARC 的所有控制源都能使用它们的工具。",
  "text13": "Codex",
  "text14": "Import from Agent",
  "text15": "搜索服务和工具",
  "text16": "复制修复提示词",
  "text17": "复制提示词",
  "text18": "把我现有的 Codex MCP 服务导入 ARC 的 MCP 中枢，然后",
  "text19": "列出它们的工具，并告诉我哪些服务连接失败。"
};
