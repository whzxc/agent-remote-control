import { messageExample } from "./task-presentation";

export const timelineTask = {
  title: "Review project configuration and verify the requested changes",
  prompt: [
    "Review the project and check the configuration.",
    "Keep the existing behavior while making the requested changes.",
  ],
  followup: messageExample,
  progress: [
    "The project configuration is ready. I am applying the change next.",
    "The existing check command covers the changed TypeScript files.",
  ],
  results: [
    ["Check", "Result"],
    ["Configuration", "Updated"],
    ["TypeScript", "Passed"],
  ],
  bullets: ["Preserved existing behavior.", "Verified the changed files."],
};
export const timelineForms = [
  { name: "running-multi-turn", fixture: "timeline-multi-turn" },
  { name: "needs-you", fixture: "timeline-pending" },
  { name: "failed-turn", fixture: "task-detail-failed" },
];

export const timelineCopy = {
  changes: "1 个文件有改动 · ", filename: "config.json",
  process: "过程 · 1 条进展 · 0 次答复", failedOperations: " · 4 项操作",
  commandCount: "1 条命令", fileTools: "修改 1 个文件 · 1 项工具调用",
  plan: "计划 · ", planTitle: "Verify project changes", command: "npm run check",
  commandRunning: "1 条命令运行中", turn: "第 1 轮 · 4 项操作 · 37 秒",
  finalReply: "最终回复", completed: "The requested changes are complete.",
  agent: "Codex · acceptance", failedTitle: "Failed task", source: "来自 Claude",
  state: { failed: "失败", waiting: "等待输入", running: "运行中" },
  duration: { failed: "37 秒", current: "22 分 31 秒" },
  failure: "本轮失败", failureMessage: "The sample verification command failed.",
  retained: "已记录的改动保留在磁盘上，ARC 未执行回退。", retry: "重试本轮", copyLog: "复制日志",
};

// Proposed relay timeline. Fictional content; ARC derives every row from native transcripts and dispatch receipts.
export type RelayKind = "dispatch" | "followup" | "queued" | "local";
export type RelayStepKind =
  "thought" | "thinking" | "say" | "tools" | "edit" | "failed" | "live" | "request" | "answered";
export type RelayStep = {
  kind: RelayStepKind; label?: string; target?: string; meta?: string;
  detail?: readonly string[]; added?: number; removed?: number; streaming?: boolean; expanded?: boolean;
  by?: "Claude";
};
export const relayParties = {
  source: { name: "Claude", brand: "claude" },
  agent: { name: "Codex", brand: "codex", workspace: "acceptance" },
} as const;
export const relayCopy = {
  kind: { dispatch: "派发", followup: "追加", queued: "排队中 · 本轮结束后送达", local: "提示词" },
  working: "工作中", thought: "思考", thinking: "思考中", reply: "最终回复", failed: "本轮失败", request: "请求批准",
  routing: "18 秒后转给 Claude", pause: "暂停", handoff: "立即转给 Claude",
  worked: "用时 1 分 52 秒 · 6 项操作", failedFold: "用时 1 分 04 秒 · 5 项操作 · 1 项失败",
  turn: "第 1 轮", turnTime: "37 秒", changes: "1 个文件有改动", plan: "计划", copy: "复制",
  retry: "重试本轮", copyLog: "复制日志",
  state: { running: "运行中", waiting: "等待批准", done: "已完成", failed: "失败" },
  duration: { running: "22 分 31 秒", waiting: "23 分 02 秒", done: "24 分 18 秒", failed: "1 分 04 秒" },
};
export const relayTurns = {
  first: {
    prompt: "Review the project and check the configuration. Keep the existing behavior.",
    result: "The configuration review is complete; no behavior changes were needed.",
  },
  second: {
    prompt: "Apply the changes and run the project checks. Report anything you could not verify.",
    time: "14:06",
  },
  queued: { prompt: "Also confirm the README still matches the new option.", time: "14:09" },
};
export const relaySteps: Record<string, RelayStep> = {
  thought: { kind: "thought", label: "Planning the configuration change", meta: "8 秒",
    detail: ["The check command already covers the TypeScript sources.",
      "Update config.json first, then run lint and the project check."] },
  say: { kind: "say", label: "I'll update the configuration first, then run lint and the existing check." },
  tools: { kind: "tools", label: "读取 3 个文件 · 搜索 1 次", meta: "2 秒" },
  edit: { kind: "edit", label: "编辑", target: "config.json", added: 12, removed: 3 },
  failed: { kind: "failed", target: "npm run lint", meta: "退出码 1",
    detail: ["config.json:14  Unexpected token '}'"] },
  recover: { kind: "say", label: "Lint caught a trailing comma. Fixed it and re-running the full check." },
  live: { kind: "live", target: "npm run check", meta: "0:42", detail: ["> tsc --noEmit -p ui", "Checking 214 files…"] },
  thinking: { kind: "thinking", label: "Comparing the lint output with the plan", meta: "0:06" },
  streaming: { kind: "say", streaming: true,
    label: "All checks passed. The configuration now accepts the new option, and the README example" },
  request: { kind: "request", label: "请求批准", target: "cat README.md" },
  answered: { kind: "answered", label: "已批准", by: "Claude", target: "cat README.md" },
  answeredUnknown: { kind: "answered", label: "已批准", target: "cat README.md" },
  stopped: { kind: "failed", target: "npm run check", meta: "退出码 2",
    detail: ["ui/config.ts:31  Type 'string' is not assignable to type 'Mode'"] },
};
export const relayPlan = {
  completed: 2, total: 3, current: "Run the project checks",
  items: [
    { text: "Read the configuration", status: "completed" },
    { text: "Apply the configuration change", status: "completed" },
    { text: "Run the project checks", status: "running" },
  ],
} as const;
export const relayReply = {
  lead: "The requested changes are complete.",
  results: [["Check", "Result"], ["Lint", "Passed"], ["Project check", "Passed"]],
  bullets: ["Preserved existing behavior.", "README example still matches the new option."],
  file: "config.json",
};
export const relayFailure = {
  message: "The project check failed after the configuration change.",
  retained: "已记录的改动保留在磁盘上，ARC 未执行回退。",
};
export const relayForms = [
  { name: "relay-running", state: "running" },
  { name: "relay-needs-you", state: "waiting" },
  { name: "relay-done", state: "done" },
  { name: "relay-failed", state: "failed" },
] as const;
