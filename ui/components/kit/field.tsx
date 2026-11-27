import { CircleAlert } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { cn } from "./utils";

export function Field({
  id,
  label,
  error,
  help,
  helpPlacement = "end",
  description,
  compact = false,
  className,
  children,
}: {
  id?: string;
  label: ReactNode;
  error?: string;
  help?: ReactNode;
  helpPlacement?: "end" | "label";
  description?: ReactNode;
  compact?: boolean;
  className?: string;
  children: ReactNode;
}): ReactElement {
  return (
    <div
      data-slot="field"
      data-compact={compact || undefined}
      className={cn("grid min-w-0 grid-cols-1 gap-2 text-foreground", className)}
    >
      <div
        data-slot="field-heading"
        data-help-placement={helpPlacement}
        className={cn(
          "flex items-center gap-3 font-semibold leading-4",
          compact ? "text-meta" : "text-small",
          helpPlacement === "label" ? "justify-start" : "justify-between",
        )}
      >
        <label htmlFor={id} data-slot="field-label">
          {label}
        </label>
        {help}
      </div>
      {description && (
        <p
          data-slot="field-description"
          className="text-meta leading-4 text-text-secondary"
        >
          {description}
        </p>
      )}
      {children}
      {error && (
        <p
          id={id ? `${id}-error` : undefined}
          data-slot="field-error"
          role="alert"
          className="flex items-center gap-1.5 text-meta leading-4 text-destructive"
        >
          <CircleAlert
            size={14}
            strokeWidth={1.75}
            absoluteStrokeWidth
            aria-hidden="true"
            className="shrink-0"
          />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}
