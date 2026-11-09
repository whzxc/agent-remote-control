import type { Brand } from "../components/agent-icon";
import type { AgentAccount } from "../modules/agent-account";

type Platform = { name: string; brand: Brand; accounts: readonly AgentAccount[] };

export const platformAccounts = {
  claude: {
    name: "Claude Code",
    brand: "claude-code",
    accounts: [
      { alias: "Team", email: "team@example.com", state: "signed-in", default: true, windows: [
        { label: "5 小时额度", value: 84, mode: "剩余", reset: "3 小时后重置", elapsed: 0.6, tone: "success" },
        { label: "周额度", value: 73, mode: "剩余", reset: "1 天后重置", elapsed: 1 / 7, tone: "success" },
      ] },
      { alias: "Studio", email: "studio@example.com", state: "signed-out" },
      { alias: "Personal", email: "personal@example.com", state: "signed-in", windows: [] },
    ],
  },
  codex: {
    name: "Codex",
    brand: "codex",
    accounts: [{ alias: "Personal", email: "personal@example.com", removable: false, state: "signed-out", default: true }],
  },
} as const satisfies Record<string, Platform>;

export const platformAccountCopy = {
  add: "添加账号",
  close: "关闭",
  expand: "展开",
  empty: "暂无账号",
  signedOut: "未登录",
  quotaUnavailable: "额度暂不可用",
  default: "默认",
  refresh: "刷新额度",
  edit: "编辑别名",
  alias: "账号别名",
  save: "保存",
  reauth: "重新登录",
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
