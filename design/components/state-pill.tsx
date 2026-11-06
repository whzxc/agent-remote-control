import { Frame } from "sdg";
const forms = [
  { name: "running", text: "运行中" },
  { name: "waiting", text: "等待输入" },
  { name: "done", text: "已完成" },
  { name: "failed", text: "失败" },
  { name: "stopped", text: "已停止" },
] as const;
export type TaskState = "running" | "waiting" | "done" | "failed" | "stopped";
export function StatePill({
  state,
  children,
}: {
  state: TaskState;
  children?: unknown;
}) {
  const paint = {
    running:
      "relative isolate before:absolute before:inset-0 before:-z-10 before:rounded-[inherit] before:bg-accent-text before:opacity-15 text-accent-text",
    waiting:
      "relative isolate before:absolute before:inset-0 before:-z-10 before:rounded-[inherit] before:bg-warning before:opacity-15 text-warning",
    done: "relative isolate before:absolute before:inset-0 before:-z-10 before:rounded-[inherit] before:bg-success before:opacity-15 text-success",
    failed:
      "relative isolate before:absolute before:inset-0 before:-z-10 before:rounded-[inherit] before:bg-danger before:opacity-15 text-danger",
    stopped:
      "relative isolate before:absolute before:inset-0 before:-z-10 before:rounded-[inherit] before:bg-text-tertiary before:opacity-12 text-text-tertiary",
  };
  return (
    <span
      class={`inline-flex items-center gap-[5px] h-6 pl-[9px] pr-[10px] rounded-field text-meta font-semibold ${paint[state]}`}
    >
      <span class="size-[6px] rounded-[3px] bg-current" />
      {children}
    </span>
  );
}
export default () =>
  forms.map(({ name, text }) => (
    <Frame name={name}>
      <StatePill state={name}>{text}</StatePill>
    </Frame>
  ));
