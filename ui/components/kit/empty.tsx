import type { LucideIcon } from "lucide-react";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { cn } from "./utils";

export interface EmptyProps extends Omit<ComponentProps<"div">, "title"> {
  icon?: LucideIcon;
  title?: ReactNode;
  action?: ReactNode;
  inset?: boolean;
}

export function Empty({
  icon: IconComponent,
  title,
  action,
  inset = true,
  className,
  children,
  ...props
}: EmptyProps): ReactElement {
  return (
    <div
      data-slot="empty"
      role="status"
      className={cn(
        "flex flex-col items-center justify-center gap-2.5 text-center text-text-secondary",
        inset ? "px-4 py-8" : "p-0 gap-3.5",
        className,
      )}
      {...props}
    >
      {IconComponent && (
        <span
          aria-hidden="true"
          data-slot="empty-icon"
          className="grid size-10 shrink-0 place-items-center rounded-tile border border-border bg-muted text-text-secondary"
        >
          <IconComponent size={18} strokeWidth={1.75} absoluteStrokeWidth />
        </span>
      )}
      {title && (
        <p data-slot="empty-title" className="text-body font-semibold text-foreground">
          {title}
        </p>
      )}
      {children && (
        <p data-slot="empty-description" className="text-small leading-5 text-text-secondary">
          {children}
        </p>
      )}
      {action && <div data-slot="empty-action" className="mt-1">{action}</div>}
    </div>
  );
}
