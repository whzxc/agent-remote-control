import {
  CircleAlert,
  CircleCheck,
  Info,
  TriangleAlert,
} from "lucide-react";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { usePrivacyRedactor } from "./privacy";
import { cn } from "./utils";

const toneStyles = {
  danger: {
    Icon: CircleAlert,
    surface: "bg-danger/10 text-danger border-danger/20",
    iconClass: "text-danger",
  },
  warning: {
    Icon: TriangleAlert,
    surface: "bg-warning/10 text-warning border-warning/20",
    iconClass: "text-warning",
  },
  success: {
    Icon: CircleCheck,
    surface: "bg-success/10 text-success border-success/20",
    iconClass: "text-success",
  },
  info: {
    Icon: Info,
    surface: "bg-accent/10 text-accent-text border-accent/20",
    iconClass: "text-accent-text",
  },
} as const;

export type AlertTone = keyof typeof toneStyles;

export interface AlertProps extends Omit<ComponentProps<"div">, "title"> {
  tone?: AlertTone;
  title?: ReactNode;
  action?: ReactNode;
  actionBelow?: boolean;
  layout?: "inline" | "stacked";
  compact?: boolean;
  elevated?: boolean;
  showIcon?: boolean;
}

export function Alert({
  tone = "info",
  title,
  action,
  actionBelow = false,
  layout = "inline",
  compact = false,
  elevated = false,
  showIcon = false,
  className,
  children,
  ...props
}: AlertProps): ReactElement {
  const redact = usePrivacyRedactor();
  const style = toneStyles[tone];
  const body = typeof children === "string" ? redact(children) : children;

  return (
    <div
      data-slot="alert"
      data-tone={tone}
      data-compact={compact || undefined}
      data-elevated={elevated || undefined}
      role={tone === "danger" ? "alert" : "status"}
      className={cn(
        "flex w-full min-w-0 rounded-inset border px-4 py-3.5 text-small leading-5 wrap-anywhere",
        style.surface,
        layout === "stacked" || actionBelow
          ? "flex-col items-start gap-3"
          : "items-start justify-between gap-3",
        compact && "px-3 py-2.5 text-meta leading-4 font-normal",
        elevated && "shadow-md",
        className,
      )}
      {...props}
    >
      <div className="flex min-w-0 flex-1 items-start gap-2.5">
        {showIcon && (
          <style.Icon
            size={16}
            strokeWidth={1.75}
            absoluteStrokeWidth
            aria-hidden="true"
            className={cn("mt-0.5 shrink-0", style.iconClass)}
          />
        )}
        <div className="grid min-w-0 flex-1 gap-1">
          {title && <strong className="font-semibold leading-4">{title}</strong>}
          <div className={cn(title ? "text-meta text-foreground font-normal" : "font-medium")}>
            {body}
          </div>
        </div>
      </div>
      {action && (
        <div
          data-slot="alert-action"
          className={cn("shrink-0", !actionBelow && layout === "inline" && "-my-1")}
        >
          {action}
        </div>
      )}
    </div>
  );
}

export function Notice({
  tone = "danger",
  ...props
}: AlertProps): ReactElement {
  return <Alert tone={tone} {...props} />;
}
