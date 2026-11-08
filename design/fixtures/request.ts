export const permissionExample = {
  title: "Read README.md", scope: "仅允许这一次", command: "cat README.md",
  deny: "拒绝", bypass: "绕过", approve: "批准",
};
export const requestCopy = {
  title: "待处理请求", status: "将在控制源下次检查时处理", question: "Choose an option",
  answer: "Answer", other: "其他", skip: "跳过", send: "发送回答",
};
export const requestExample = {
  request: "待处理请求 · 1",
  summary: "Read README.md",
  open: "打开",
  unavailable: "暂时无法读取审阅信息。",
  retry: "重试",
};

export const questionOptions = [
  { value: "alpha", label: "Alpha" },
  { value: "beta", label: "Beta" },
];

export const routingForms = [
  { name: "passive", status: "Will be handled at the source’s next check" },
  { name: "actionable", status: "Paused" },
  { name: "actionable-inline", status: "Paused" },
] as const;
export const routingActions = { resume: "Resume", handoff: "Hand to Claude now" };
