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
