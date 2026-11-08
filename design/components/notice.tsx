import { Frame, Icon } from "sdg";
import { Button } from "./button";
import { noticeExample } from "../fixtures/feedback";

const example = {
  request: "待处理请求 · 1",
  summary: "Read README.md",
  open: "打开",
  unavailable: "暂时无法读取审阅信息。",
  retry: "重试",
};
export function Notice({
  children,
  title,
  tone = "danger",
  action,
  actionBelow = false,
}: {
  children?: unknown;
  title?: unknown;
  tone?: "danger" | "warning" | "success";
  action?: unknown;
  actionBelow?: boolean;
}) {
  const paint = {
    danger:
      `relative isolate before:absolute before:inset-0 before:-z-10 before:rounded-[inherit]
      before:bg-danger before:opacity-10 text-danger`,
    warning:
      `relative isolate before:absolute before:inset-0 before:-z-10 before:rounded-[inherit]
      before:bg-warning before:opacity-10 text-warning`,
    success:
      `relative isolate before:absolute before:inset-0 before:-z-10 before:rounded-[inherit]
      before:bg-success before:opacity-10 text-success`,
  };
  return (
    <div
      class={`flex w-full gap-3 rounded-[14px] px-4 pt-4 pb-[13px] ${paint[tone]} ${actionBelow ? "flex-col" : "items-start"}`}
    >
      <div class="flex min-w-0 flex-1 flex-col gap-1 text-meta leading-4">
        {title && <strong class="text-small leading-4">{title}</strong>}
        {children}
      </div>
      {action && <div class="-mt-1">{action}</div>}
    </div>
  );
}
export function RequestEntry({
  title,
  summary,
  action,
}: {
  title: string;
  summary?: string;
  action: string;
}) {
  return (
    <div class="flex w-full items-center gap-[10px] rounded-card relative isolate before:absolute before:inset-0 before:-z-10 before:rounded-[inherit] before:bg-warning before:opacity-10 p-4">
      <Icon name="shield-alert" size={18} class="self-start text-warning" />
      <div class="flex flex-1 flex-col gap-[10px]">
        <strong class="text-meta leading-4 text-warning">{title}</strong>
        {summary && (
          <span class="text-small leading-[18px] text-text">{summary}</span>
        )}
      </div>
      <Button>{action}</Button>
    </div>
  );
}
export function ReviewUnavailable({
  children,
  action,
}: {
  children?: unknown;
  action?: unknown;
}) {
  return (
    <div class="flex w-full items-center justify-between gap-4 rounded-card bg-surface-subtle px-4 py-[18px] text-small text-text-secondary">
      <span>{children}</span>
      {action}
    </div>
  );
}
export default () => [
  <Frame name="notice-danger" width={560}>
    <Notice
      title={noticeExample.title}
      action={<Button icon="copy">{noticeExample.copy}</Button>}
    >
      <p class="text-text">{noticeExample.detail}</p>
      <div class="mt-[2px] font-mono text-caption leading-4 text-text-secondary">
        {noticeExample.diagnostic.map((line) => (
          <div>{line}</div>
        ))}
      </div>
    </Notice>
  </Frame>,
  <Frame name="request-entry" width={560}>
    <RequestEntry
      title={example.request}
      summary={example.summary}
      action={example.open}
    />
  </Frame>,
  <Frame name="review-unavailable" width={560}>
    <ReviewUnavailable
      action={<Button variant="ghost">{example.retry}</Button>}
    >
      {example.unavailable}
    </ReviewUnavailable>
  </Frame>,
];
