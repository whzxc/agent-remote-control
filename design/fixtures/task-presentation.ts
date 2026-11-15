export const taskDispatch = {
  model: "GPT-6.1 Sol",
  effort: "高推理强度",
  position: { count: 4, index: 2 },
  tier: "快速",
  fast: true,
};

export const stateForms = [
  { name: "running", text: "运行中" },
  { name: "waiting", text: "等待输入" },
  { name: "done", text: "已完成" },
  { name: "failed", text: "失败" },
  { name: "stopped", text: "已停止" },
] as const;

export const messageForms = [{ name: "prompt" }, { name: "queued", status: "Queued" }];
export const messageExample = "Apply the changes and run the project checks.";
