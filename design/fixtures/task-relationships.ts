import type { RelationTask } from "../modules/task-relationships";

export const parentTitle = "更新设计工作流";
export const family: RelationTask[] = [
  {
    title: parentTitle,
    duration: "11:16",
    phase: "调用工具",
    headline: "exec",
    tone: "command",
    icon: "terminal",
  },
  {
    title: parentTitle,
    duration: "1:02",
    phase: "已完成",
    headline: "exec",
    tone: "success",
    icon: "check",
    kind: "side-chat",
  },
  {
    title: "检查设计资产",
    duration: "0:39",
    phase: "思考中",
    headline: "规划中",
    tone: "thinking",
    icon: "ellipsis",
    kind: "subagent",
  },
  {
    title: "验证组件布局",
    duration: "2:16",
    phase: "已完成",
    headline: "exec",
    tone: "success",
    icon: "check",
    kind: "subagent",
  },
  {
    title: "验证构建结果",
    duration: "5:31",
    phase: "已完成",
    headline: "exec",
    tone: "success",
    icon: "check",
  },
];
export const positions = [
  { x: 160, y: 50 },
  { x: 208, y: 130 },
  { x: 208, y: 202 },
  { x: 208, y: 274 },
  { x: 160, y: 420 },
];
export const headers = [
  { index: 1, y: 50, note: "Detail header · Side chat" },
  { index: 2, y: 286, note: "Detail header · Subagent" },
];

export const familyExample = { agent: "Codex", moreLabel: "展开其余 4 项" };
export const linkRows = [50, 420];
export const branchRows = [160, 232, 304];
export const relationKinds = ["side-chat", "subagent"] as const;
