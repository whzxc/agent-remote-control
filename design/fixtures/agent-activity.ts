export const active = [
  {
    heading: "需要你处理 · 1",
    title: "Confirm access to project files",
    phase: "等待输入",
    headline: "Read README.md",
    tone: "warning",
    icon: "shield-alert",
    form: "row-attention",
  },
  {
    heading: "运行中 · 1",
    title: "Verify project changes",
    phase: "执行命令",
    headline: "npm run check",
    duration: "21:54",
    tone: "command",
    icon: "terminal",
    form: "row",
  },
] as const;
export const agentHistory = [
  { heading: "今天 · 3", tasks: [1, 2, 3], date: "1月1日" },
  { heading: "昨天 · 1", tasks: [4], date: "2025年12月31日" },
];

export const agentRowExample = { titlePrefix: "Review project change", project: "acceptance" };

export const agentTaskMeta = { project: "acceptance", date: "1月1日" };
