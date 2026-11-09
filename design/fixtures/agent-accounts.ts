import type { Brand } from "../components/agent-icon";
import type { AgentAccount } from "../modules/agent-account";

type Platform = { name: string; brand: Brand; accounts: readonly AgentAccount[] };

export const platformAccounts = {
  claude: {
    name: "Claude Code",
    brand: "claude-code",
    accounts: [
      { name: "Team", state: "signed-in", default: true, windows: [
        { label: "5 小时额度", value: 84, mode: "剩余", reset: "3 小时后重置", elapsed: 0.6, tone: "success" },
        { label: "周额度", value: 73, mode: "剩余", reset: "1 天后重置", elapsed: 1 / 7, tone: "success" },
      ] },
      { name: "Studio", state: "signed-out" },
      { name: "Personal", state: "signed-in", windows: [] },
    ],
  },
  codex: {
    name: "Codex",
    brand: "codex",
    accounts: [{ name: "Personal", owner: "desktop", state: "signed-out", default: true }],
  },
} as const satisfies Record<string, Platform>;

export const platformAccountCopy = {
  add: "添加账号",
  close: "关闭",
  expand: "展开",
  empty: "暂无账号",
  native: "Codex Desktop 主账号",
  signedOut: "需要重新登录",
  quotaUnavailable: "额度暂不可用",
  default: "默认",
  refresh: "刷新额度",
  reauth: "重新登录",
  openCodex: "打开 Codex",
  remove: "移除账号",
  removeTitle: "移除 Studio？",
  removal: "将从 ARC 移除此 Agent 账号。运行中的任务会先完成，对话历史会保留。",
};

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
