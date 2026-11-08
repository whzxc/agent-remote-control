
export const productRows = [
  ["ChatGPT", "openai"],
  ["Claude", "claude"],
  ["Gemini", "google"],
  ["Grok", "xai"],
  ["Copilot", "microsoft"],
  ["Notion", "notion"],
  ["Slack", "slack"],
  ["Cursor", "cursor"],
  ["GitHub Copilot", "microsoft"],
  ["Raycast", "raycast"],
  ["Codex", "codex"],
  ["Claude Code", "claude-code"],
  ["OpenCode", "opencode"],
  ["Qwen Code", "alibaba"],
  ["Grok Bot", "xai"],
];
export const localProductRows: {
  value: string; label: string; brand?: string; icon?: string;
  disabled?: boolean; description?: string;
}[] = [
  {
    "value": "code",
    "label": "Claude Code",
    "brand": "claude-code",
    "disabled": true,
    "description": "仅本机客户端可用"
  },
  {
    "value": "desktop",
    "label": "Claude 桌面版",
    "brand": "claude",
    "disabled": true,
    "description": "仅本机客户端可用"
  },
  {
    "value": "other",
    "label": "其他 MCP 客户端",
    "icon": "plug"
  }
];
export const sourceCopy = {
  "remote": "远程连接",
  "local": "这台电脑",
  "client": "Claude",
  "connectionQuestion": "Claude 通过哪个连接找到这台电脑？",
  "addConnection": "添加连接",
  "addDescription": "创建或加入中继，或使用自有地址，完成后回到这里",
  "noConnections": "还没有可用的连接",
  "recommended": "推荐",
  "localRestart": "安装后重启 Claude 即可",
  "settingsPath": "设置 › 连接器 › 添加自定义连接器",
  "openSettings": "打开 Claude 设置",
  "codeNotice": "浏览器会显示 4 位代码，这里会自动进入下一步。",
  "code": "4F7K",
  "confirmCode": "确认浏览器里显示的是同一个代码",
  "scope": "来源：Claude · 权限：此电脑已启用的全部操作",
  "account": "账号",
  "accountName": "这个账号叫什么",
  "connected": "Claude 已连接",
  "relay": "经由 My relay",
  "tryPrompt": "在 Claude 里试一句",
  "prompt": "h Hssse heahttrrorstteah",
  "unsupported": "不支持 oauth 认证",
  "connectionOptions": [
    {
      "value": "relay",
      "label": "My relay",
      "description": "中继链接 · 已承载 Claude · Personal · 在线"
    }
  ],
  "accountOptions": [
    {
      "value": "new",
      "label": "作为新账号"
    },
    {
      "value": "existing",
      "label": "重新授权 Claude · Personal"
    }
  ],
  "addressSteps": [
    "复制地址",
    "在 Claude 中添加",
    "点 Claude 里的“连接”"
  ],
  "methodIcons": [
    "cloud",
    "link",
    "plug"
  ]
};
