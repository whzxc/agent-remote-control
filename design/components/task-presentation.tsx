import { Frame } from "adg";
import { stateForms, messageForms, messageExample } from '../fixtures/task-presentation';

export type TaskState = "running" | "waiting" | "done" | "failed" | "stopped";
export function StatePill({
  state,
  children,
  class: extra = "",
}: {
  state: TaskState;
  children?: unknown;
  class?: string;
}) {
  const paint = {
    running:
      "relative isolate before:absolute before:inset-0 before:-z-10 before:rounded-[inherit] " +
      "before:bg-accent-text before:opacity-15 text-accent-text",
    waiting:
      "relative isolate before:absolute before:inset-0 before:-z-10 before:rounded-[inherit] " +
      "before:bg-warning before:opacity-15 text-warning",
    done: "relative isolate before:absolute before:inset-0 before:-z-10 before:rounded-[inherit] " +
      "before:bg-success before:opacity-15 text-success",
    failed:
      "relative isolate before:absolute before:inset-0 before:-z-10 before:rounded-[inherit] " +
      "before:bg-danger before:opacity-15 text-danger",
    stopped:
      "relative isolate before:absolute before:inset-0 before:-z-10 before:rounded-[inherit] " +
      "before:bg-text-tertiary before:opacity-12 text-text-tertiary",
  };
  return (
    <span
      class={`inline-flex items-center gap-[5px] h-6 pl-[9px] pr-[10px] rounded-field text-meta font-semibold ${paint[state]} ${extra}`}
    >
      <span class="size-[6px] rounded-[3px] bg-current" />
      {children}
    </span>
  );
}

export function TaskMessage({
  text,
  children,
  queued = false,
  status,
  class: extra = "",
}: {
  text?: string;
  children?: unknown;
  queued?: boolean;
  status?: string;
  class?: string;
}) {
  return (
    <div
      class={`flex w-full flex-col gap-[18px] rounded-card bg-surface-sunken px-4 py-[15px] text-text ${extra}`}
    >
      <p class="text-small leading-4">{text ?? children}</p>
      {(status || queued) && (
        <span class="self-end text-meta leading-[14px] text-text-secondary">
          {status || "Queued"}
        </span>
      )}
    </div>
  );
}

export default () => [
  ...stateForms.map(({ name, text }) => (
    <Frame name={`state-pill-${name}`}><StatePill state={name}>{text}</StatePill></Frame>
  )),
  ...messageForms.map(({ name, ...props }) => (
    <Frame name={`task-message-${name}`} width={520}>
      <TaskMessage text={messageExample} {...props} />
    </Frame>
  )),
];
