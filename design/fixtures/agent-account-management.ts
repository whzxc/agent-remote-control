export const accountManagement = {
  title: "管理账号",
  add: "添加账号",
  close: "关闭",
  more: "更多账号操作",
  refresh: "刷新额度",
  empty: "尚未添加 Agent 账号",
  native: "Codex Desktop 主账号",
  signedIn: "已登录",
  signedOut: "需要重新登录",
  quotaUnavailable: "额度暂不可用",
  default: "默认",
  reauth: "重新登录",
  openCodex: "打开 Codex",
  claude: {
    name: "Claude Code",
    brand: "claude-code",
    rows: [
      { name: "Team", state: "signed-in", default: true, quotas: [
        { label: "5 小时剩余", remaining: 84, tone: "success" },
        { label: "7 天剩余", remaining: 73, tone: "success" },
      ] },
      { name: "Studio", state: "signed-out" },
      { name: "Personal", state: "signed-in" },
    ],
  },
  codex: {
    name: "Codex",
    brand: "codex",
    rows: [{ name: "Personal", state: "native-signed-out", default: true }],
  },
} as const;

export const accountSignIn = {
  add: "添加 Claude Code 账号",
  reauth: "重新登录 · Studio",
  browser: "登录浏览器",
  browsers: [
    { value: "default", label: "系统默认浏览器" },
    { value: "chrome-profile", label: "Google Chrome · Profile A" },
  ],
  start: "开始登录",
  waiting: "等待浏览器授权",
  copyLink: "复制授权链接",
  code: "授权码（浏览器显示时填写）",
  codePlaceholder: "粘贴授权码",
  submit: "提交授权码",
  failure: "登录链接已过期",
  retry: "重新开始",
};
