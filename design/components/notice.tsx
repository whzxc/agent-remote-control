import type { ReactNode } from "react";
import { Frame } from "adg";
import { Notice as KitNotice, cn } from "@/components/kit";
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
  return (
    <KitNotice
      tone={tone}
      title={title}
      action={action}
      actionBelow={actionBelow}
      layout={layout}
      compact={compact}
      elevated={elevated}
      className={cn(layout === "stacked" && "w-auto", extra)}
    >
      {children}
    </KitNotice>
  );
}

export default () => [
  <Frame key="danger" name="danger" width={560}>
    <Notice
      title={noticeExample.title}
      action={<Button icon="copy">{noticeExample.copy}</Button>}
    >
      <p className="text-text">{noticeExample.detail}</p>
      <div className="mt-[2px] font-mono text-caption leading-4 text-text-secondary">
        {noticeExample.diagnostic.map((line, i) => (
          <div key={i}>{line}</div>
        ))}
      </div>
    </Notice>
  </Frame>,
];
