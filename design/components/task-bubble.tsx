import { Frame, Icon } from "sdg";
import { Tile, type TileTone } from "./tile";
import type { Brand } from "./agent-icon";
import { Tag } from "./tag";
import { DispatchSpec } from "./dispatch-spec";
const spec = {
  model: "GPT-6.1 Sol",
  effort: "高推理强度",
  position: { count: 4, index: 2 },
  tier: "快速",
  fast: true,
};
const trail = [
  "relative isolate before:absolute before:inset-0 before:-z-10 before:rounded-[inherit] before:bg-phase-thinking before:opacity-55",
  "relative isolate before:absolute before:inset-0 before:-z-10 before:rounded-[inherit] before:bg-phase-command before:opacity-55",
  "bg-current",
];
const forms: {
  name: TaskBubbleForm;
  title: string;
  duration?: string;
  phase: string;
  headline: string;
  tone: TileTone;
  icon: string;
  detail?: string;
}[] = [
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
  return (
    <div
      style={width ? { width } : undefined}
      class={`flex items-start rounded-card ${row ? "w-[380px] gap-3 px-3 pt-[14px] pb-3" : "w-[264px] gap-[10px] px-[11px]"} ${form === "compact" ? "py-[11px]" : form === "standard" ? "pt-3 pb-[7px]" : form === "detailed" ? "pt-[14px] pb-[9px]" : ""} ${form === "row-attention" ? "relative isolate before:absolute before:inset-0 before:-z-10 before:rounded-[inherit] before:bg-warning before:opacity-10" : row ? "bg-surface-subtle" : "bg-surface shadow-md"} ${paint[tone]}`}
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
        <div class="mt-[5px] flex items-center gap-[6px] text-meta leading-[14px]">
          <span class={`shrink-0 font-medium ${neutralPhase ? "text-text-secondary" : ""} ${phaseColumn === "latin" ? "w-[65px]" : phaseColumn === "cjk" ? "w-12" : ""}`}>{phase}</span>
          <span
            class={`min-w-0 truncate text-text ${headlineMono || tone === "command" || tone === "file" ? "font-mono" : ""}`}
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
  tone,
  attention = false,
}: {
  title: string;
  meta: unknown;
  tile: unknown;
  tone?: string;
  attention?: boolean;
}) {
  return (
    <div
      class={`flex items-center gap-3 rounded-card p-3 ${attention ? "relative isolate before:absolute before:inset-0 before:-z-10 before:rounded-[inherit] before:bg-warning before:opacity-10" : "bg-surface-subtle"}`}
    >
      {tile}
      <div class="flex min-w-0 flex-1 flex-col gap-1">
        <strong class="text-small text-text">{title}</strong>
        <div class="text-meta text-text-secondary">{meta}</div>
      </div>
      <Icon name="chevron-right" size={16} class="text-text-secondary" />
    </div>
  );
}
export default () =>
  forms.map(({ name, ...props }) => (
    <Frame name={name}>
      <TaskBubble
        {...props}
        form={name}
        dispatch={spec}
        project={name.startsWith("row") ? "acceptance" : "ac…"}
        date="1月1日"
      />
    </Frame>
  ));
