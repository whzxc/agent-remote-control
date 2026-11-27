import type { ReactNode } from "react";
import { Frame } from "adg";
import { Button } from "./button";
import { noticeExample } from "../fixtures/feedback";

export function Notice({
  children,
  title,
  tone = "danger",
  action,
  actionBelow = false,
  layout = "inline",
  compact = false,
  elevated = false,
  className: extra = "",
}: {
  children?: ReactNode;
  title?: ReactNode;
  tone?: "danger" | "warning" | "success";
  action?: ReactNode;
  actionBelow?: boolean;
  layout?: "inline" | "stacked";
  compact?: boolean;
  elevated?: boolean;
  className?: string;
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
  if (layout === "stacked") {
    const background = { danger: "bg-danger/10", warning: "bg-warning/10", success: "bg-success/10" };
    const ink = { danger: "text-danger", warning: "text-warning", success: "text-success" };
    return <div className={`flex flex-col gap-1 rounded-[14px] ${background[tone]} p-4 ${extra}`}>
      {title && <strong className={`text-small leading-4 ${ink[tone]}`}>{title}</strong>}
      {children}
      {action && <div className="mt-2">{action}</div>}
    </div>;
  }
  if (actionBelow) return (
    <div className={`grid w-full gap-[14px] rounded-inset p-4 ${paint[tone]}`}>
      <div className="grid gap-0.5 text-meta leading-[18px]">
        {title && <strong className="text-small font-semibold">{title}</strong>}
        <div className="text-text">{children}</div>
      </div>
      <div className="flex items-center gap-2">{action}</div>
    </div>
  );
  return (
    <div
      className={`flex w-full items-start gap-3 rounded-[14px] px-4 pt-4 pb-[13px] ${paint[tone]} ${compact ? "text-meta leading-4 font-normal" : ""} ${elevated ? "shadow-md" : ""}`}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1 text-meta leading-4">
        {title && <strong className="text-small leading-4">{title}</strong>}
        {children}
      </div>
      {action && <div className="-mt-1">{action}</div>}
    </div>
  );
}
export default () => [
  <Frame name="danger" width={560}>
    <Notice
      title={noticeExample.title}
      action={<Button icon="copy">{noticeExample.copy}</Button>}
    >
      <p className="text-text">{noticeExample.detail}</p>
      <div className="mt-[2px] font-mono text-caption leading-4 text-text-secondary">
        {noticeExample.diagnostic.map((line) => (
          <div>{line}</div>
        ))}
      </div>
    </Notice>
  </Frame>,
];
