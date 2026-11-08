export const taskDispatch = {
  model: "GPT-6.1 Sol",
  effort: "高推理强度",
  position: { count: 4, index: 2 },
  tier: "快速",
  fast: true,
};

export const bubbleForms = [
  {
    name: "compact",
    title: "检查项目变更",
    duration: "1:23",
    phase: "执行命令",
    headline: "npm run check",
    tone: "command",
    icon: "terminal",
  },
  {
    name: "standard",
    title: "更新配置文件",
    duration: "1:06:05",
    phase: "处理文件",
    headline: "config.json",
    tone: "file",
    icon: "paperclip",
  },
  {
    name: "detailed",
    title: "确认 API 契约",
    duration: "12:40",
    phase: "思考中",
    headline: "对比 guide 与 catalog 的…",
    detail: "上一步：读取 docs/reference/tool…",
    tone: "thinking",
    icon: "brain",
  },
  {
    name: "row",
    title: "检查项目变更",
    duration: "21:54",
    phase: "执行命令",
    headline: "npm run check",
    tone: "command",
    icon: "terminal",
  },
  {
    name: "row-attention",
    title: "确认项目文件访问",
    phase: "等待输入",
    headline: "读取 README.md",
    tone: "warning",
    icon: "shield-alert",
  },
] as const;

export const stateForms = [
  { name: "running", text: "运行中" },
  { name: "waiting", text: "等待输入" },
  { name: "done", text: "已完成" },
  { name: "failed", text: "失败" },
  { name: "stopped", text: "已停止" },
] as const;

export const messageForms = [{ name: "prompt" }, { name: "queued", status: "Queued" }];
export const messageExample = "Apply the changes and run the project checks.";

export const taskRowExample = { title: "Review project change 1", meta: "acceptance" };

export const bubbleMeta = { project: "ac…", rowProject: "acceptance", date: "1月1日" };
