import type { ReactNode } from "react";
import { Frame, Icon } from "adg";
import { Badge } from "@/components/kit";
import { forms } from "../fixtures/tags";

export function Tag({
  children,
  form = "spec",
  icon,
  tone,
}: {
  children?: ReactNode;
  form?:
    | "spec"
    | "meta"
    | "fact"
    | "danger"
    | "ownership"
    | "resource"
    | "status"
    | "claim"
    | "compact-status"
    | "workflow-status";
  tone?: "success" | "warning" | "danger" | "command";
  icon?: string;
}) {
  if (form === "compact-status") {
    return (
      <Badge
        tone={tone ?? "neutral"}
        size="sm"
        className="h-auto gap-[5px] rounded-pill px-[7px] text-caption leading-[18px]"
      >
        {icon && <Icon name={icon} size={14} />}
        {children}
      </Badge>
    );
  }
  if (form === "workflow-status") {
    return (
      <Badge
        tone={tone ?? "neutral"}
        size="default"
        className="h-auto gap-[5px] rounded-kit-field px-2 py-1 text-meta leading-4 font-medium"
      >
        {icon && <Icon name={icon} size={14} />}
        {children}
      </Badge>
    );
  }
  if (form === "claim") {
    return (
      <Badge
        tone="neutral"
        size="lg"
        className="h-auto whitespace-normal rounded-pill px-3 py-1.5 text-body font-normal leading-[1.4]"
      >
        {children}
      </Badge>
    );
  }
  if (form === "resource") {
    return (
      <Badge
        tone="neutral"
        size="sm"
        className="h-auto max-w-full overflow-hidden text-ellipsis rounded-control border-border bg-transparent px-1.5 text-[11px] font-normal leading-[18px]"
      >
        {children}
      </Badge>
    );
  }
  if (form === "status") {
    return (
      <Badge
        tone={tone ?? "neutral"}
        size="default"
        className="h-auto rounded-pill px-2 py-1 text-meta font-normal"
      >
        {icon && <Icon name={icon} size={tone === "success" ? 16 : 6} />}
        {children}
      </Badge>
    );
  }
  const small = form === "meta" || form === "spec" || form === "danger";
  return (
    <Badge
      tone={form === "danger" ? "danger" : "neutral"}
      size={small ? "sm" : "default"}
      className={
        form === "fact"
          ? "gap-2 border-border bg-surface px-2.5 font-normal"
          : form === "ownership"
            ? "gap-2 pl-2.5 pr-5 font-normal"
            : "gap-2 font-normal"
      }
    >
      {(icon || form === "ownership") && (
        <Icon name={icon || "app-window"} size={14} />
      )}
      {children}
    </Badge>
  );
}

export function Disclosure({
  expanded = false,
  children,
}: {
  expanded?: boolean;
  children?: ReactNode;
}) {
  return (
    <Badge
      tone="neutral"
      size="default"
      className="gap-[3px] border-border bg-surface px-2.5 font-semibold text-foreground"
    >
      {children}
      <Icon
        name={expanded ? "chevron-up" : "chevron-down"}
        size={12}
        className="text-text-secondary"
      />
    </Badge>
  );
}

export default () => [
  <Frame key="claim" name="claim"><Tag form="claim">Account switch</Tag></Frame>,
  <Frame key="resource" name="resource"><Tag form="resource">Agent</Tag></Frame>,
  <Frame key="status-ready" name="status-ready"><Tag form="status" tone="success" icon="check">Granted</Tag></Frame>,
  <Frame key="status-missing" name="status-missing"><Tag form="status" tone="warning" icon="circle">Missing</Tag></Frame>,
  <Frame key="status-unknown" name="status-unknown"><Tag form="status" icon="circle">Unknown</Tag></Frame>,
  ...forms.map(({ name, text }) => (
    <Frame key={name} name={name === "disclosure" ? name : `tag-${name}`}>
      {name === "disclosure" ? <Disclosure>{text}</Disclosure> : <Tag form={name}>{text}</Tag>}
    </Frame>
  )),
];
