import { Frame, Icon } from "adg";
import { Tile, type TileTone } from "../components/tile";
import type { Brand } from "../components/agent-icon";
import { Tag } from "../components/tag";
import { DispatchSpec } from "./model-configuration";
import {
  taskDispatch, bubbleForms, stateForms, messageForms, messageExample, taskRowExample, bubbleMeta,
} from "../fixtures/task-presentation";
const trail = [
  "relative isolate before:absolute before:inset-0 before:-z-10 before:rounded-[inherit] " +
    "before:bg-phase-thinking before:opacity-55",
  "relative isolate before:absolute before:inset-0 before:-z-10 before:rounded-[inherit] " +
    "before:bg-phase-command before:opacity-55",
  "bg-current",
];
export type TaskBubbleForm =
  "compact" | "standard" | "detailed" | "row" | "row-attention";
export type TaskBubbleProps = {
  title: string;
  duration?: string;
  phase: string;
  headline: string;
  tone?: TileTone;
  icon?: string;
  detail?: string;
  form?: TaskBubbleForm;
  project?: string;
  date?: string;
  dispatch?: Parameters<typeof DispatchSpec>[0];
  source?: boolean;
  sourceBrand?: Brand;
  width?: number;
  headlineMono?: boolean;
  truncateHeadline?: boolean;
  activityGap?: number;
  fill?: boolean;
  phaseColumn?: "latin" | "cjk";
  neutralPhase?: boolean;
};
export function TaskBubble({
  title,
  duration,
  phase,
  headline,
  tone = "command",
  icon = "terminal",
  detail,
  form = "standard",
  project,
  date,
  dispatch,
  source = true,
  sourceBrand,
  width,
  headlineMono = false,
  truncateHeadline = true,
  activityGap = 6,
  fill = false,
  phaseColumn,
  neutralPhase = false,
}: TaskBubbleProps) {
  const row = form === "row" || form === "row-attention";
  const paint = {
    agent: "text-role-agent",
    neutral: "text-text-tertiary",
    command: "text-phase-command",
    file: "text-phase-file",
    thinking: "text-phase-thinking",
    warning: "text-warning",
    success: "text-success",
    accent: "text-accent",
    danger: "text-danger",
  };
  const spacing = row ? "w-[380px] gap-3 px-3 pt-[14px] pb-3" : "w-[264px] gap-[10px] px-[11px]";
  const padding = form === "compact" ? "py-[11px]"
    : form === "standard" ? "pt-3 pb-[7px]"
    : form === "detailed" ? "pt-[14px] pb-[9px]" : "";
  const background = form === "row-attention"
    ? "relative isolate before:absolute before:inset-0 before:-z-10 " +
      "before:rounded-[inherit] before:bg-warning before:opacity-10"
    : row ? "bg-surface-subtle" : "bg-surface shadow-md";
  const phaseWidth = phaseColumn === "latin" ? "w-[65px]" : phaseColumn === "cjk" ? "w-12" : "";
  const headlineFont = headlineMono || tone === "command" || tone === "file" ? "font-mono" : "";
  return (
    <div
      style={width ? { width } : undefined}
      class={`flex items-start rounded-card ${fill ? "w-full!" : ""} ${spacing} ${padding} ${background} ${paint[tone]}`}
    >
      <Tile icon={icon} form="phase" tone={tone} source={source} sourceBrand={sourceBrand} />
      <div class="flex min-w-0 flex-1 flex-col">
        <div class="flex items-center justify-between gap-2 leading-[14px]">
          <strong class="truncate text-small text-text font-[650]">
            {title}
          </strong>
          {duration && (
            <span class="font-mono text-caption text-text-tertiary">
              {duration}
            </span>
          )}
        </div>
        <div
          style={{ "--activity-gap": `${activityGap}px` }}
          class="mt-[5px] flex items-center gap-(--activity-gap) text-meta leading-[14px]"
        >
          <span class={`shrink-0 font-medium ${neutralPhase ? "text-text-secondary" : ""} ${phaseWidth}`}>
            {phase}
          </span>
          <span
            class={`${truncateHeadline ? "min-w-0 truncate" : "shrink-0 whitespace-nowrap"} text-text ${headlineFont}`}
          >
            {headline}
          </span>
        </div>
        {form === "detailed" && (
          <span class="mt-[5px] truncate text-meta leading-[14px] text-text-tertiary">
            {detail}
          </span>
        )}
        {form !== "compact" && (
          <div
            class={`flex items-center gap-[5px] ${row ? "mt-[3px]" : "mt-0"}`}
          >
            {row && project && <Tag>{project}</Tag>}
            {dispatch && <DispatchSpec {...dispatch} />}
            {!row && project && <Tag>{project}</Tag>}
            {row ? (
              <span class="ml-auto text-caption text-text-tertiary">
                {date}
              </span>
            ) : (
              <span class="ml-auto flex gap-[2px]">
                {trail.map((paint) => (
                  <span class={`size-[5px] rounded-[3px] ${paint}`} />
                ))}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
export function TaskRow({
  title,
  meta,
  tile,
  attention = false,
  compact = false,
  children,
  trailing,
}: {
  title: string;
  meta?: unknown;
  tile: unknown;
  attention?: boolean;
  compact?: boolean;
  children?: unknown;
  trailing?: unknown;
}) {
  const background = attention
    ? compact
      ? "bg-warning/10"
      : "relative isolate before:absolute before:inset-0 before:-z-10 " +
        "before:rounded-[inherit] before:bg-warning before:opacity-10"
    : "bg-surface-subtle";
  return (
    <div class={`flex gap-3 rounded-card p-3 ${compact ? "h-16 items-start" : "items-center"} ${background}`}>
      {tile}
      {children ?? (
        <div class="flex min-w-0 flex-1 flex-col gap-1">
          <strong class="text-small text-text">{title}</strong>
          <div class="text-meta text-text-secondary">{meta}</div>
        </div>
      )}
      {trailing === undefined
        ? <Icon name="chevron-right" size={16} class="text-text-secondary" />
        : trailing}
    </div>
  );
}

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
  ...bubbleForms.map(({ name, ...props }) => (
    <Frame name={`task-bubble-${name}`}>
      <TaskBubble
        {...props}
        form={name}
        dispatch={taskDispatch}
        project={name.startsWith("row") ? bubbleMeta.rowProject : bubbleMeta.project}
        date={bubbleMeta.date}
      />
    </Frame>
  )),
  ...stateForms.map(({ name, text }) => (
    <Frame name={`state-pill-${name}`}><StatePill state={name}>{text}</StatePill></Frame>
  )),
  ...messageForms.map(({ name, ...props }) => (
    <Frame name={`task-message-${name}`} width={520}>
      <TaskMessage text={messageExample} {...props} />
    </Frame>
  )),
  ...[false, true].map((attention) => (
    <Frame name={attention ? "task-row-attention" : "task-row"} width={380}>
      <div class="w-full bg-surface-raised">
        <TaskRow {...taskRowExample} attention={attention} tile={<Tile icon="circle" form="phase" tone="neutral" />} />
      </div>
    </Frame>
  )),
];
