export const themeOptions = [
  { value: "system", label: "跟随系统" },
  { value: "light", label: "亮色" },
  { value: "dark", label: "暗色" },
];
export const platformChoices = [
  ["openai", "OpenAI"],
  ["anthropic", "Anthropic"],
  ["google", "Google"],
  ["xai", "xAI"],
  ["microsoft", "Microsoft"],
  ["notion", "Notion"],
  ["slack", "Slack"],
  ["raycast", "Raycast"],
  ["cursor", "Cursor"],
  ["opencode", "OpenCode"],
  ["alibaba", "Alibaba"],
  ["other", "Other"],
];
export const tabsOptions = [
  { value: "current", label: "Current" },
  { value: "activity", label: "Activity" },
];
export const cardOptions = [{ value: "alpha", label: "Alpha" }];

export const choiceExamples = {
  theme: { value: "system", label: "Theme" },
  navigation: { value: "openai", label: "Platform" },
  tabs: { value: "current", label: "Board" },
  optionCard: { value: "alpha", label: "Option" },
};

export const setupChoiceForms = [
  {
    form: "row", label: "创建我的中继", description: "推荐 · 部署到你的 Cloudflare 免费账号",
    selected: true, brand: "claude-code",
  },
  {
    form: "product", label: "Claude Code", description: "仅本机客户端可用",
    selected: true, brand: "claude-code",
  },
] as const;
