import { Check, ChevronDown, ChevronUp, CircleAlert, Copy } from "lucide-react";
import { useId, type ReactNode } from "react";
import { Button } from "../components/kit/button";
import { cn } from "../components/kit/utils";
import { useI18n } from "../i18n/react";

export function McpDisclosureView({
  expanded,
  controls,
  onToggle,
  children,
}: {
  expanded: boolean;
  controls?: string;
  onToggle?: () => void;
  children: ReactNode;
}) {
  const Chevron = expanded ? ChevronUp : ChevronDown;
  return (
    <button
      type="button"
      data-slot="mcp-disclosure"
      className="inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-badge border border-border bg-surface px-2 text-meta font-semibold text-foreground hover:bg-surface-subtle focus-visible:ring-2 focus-visible:ring-ring"
      aria-expanded={expanded}
      aria-controls={controls}
      onClick={onToggle}
    >
      {children}
      <Chevron
        size={12}
        strokeWidth={1.75}
        absoluteStrokeWidth
        aria-hidden="true"
        className="icon shrink-0 text-text-secondary"
      />
    </button>
  );
}

export function McpPromptView({
  text,
  label,
  context,
  copied = false,
  error,
  onCopy,
  actionBelow = false,
  layout = "inline",
  className,
}: {
  text: ReactNode;
  label: string;
  context?: string;
  copied?: boolean;
  error?: string;
  onCopy?: () => void;
  actionBelow?: boolean;
  layout?: "inline" | "stacked";
  className?: string;
}) {
  const { t } = useI18n();
  const id = useId();
  const stacked = layout === "stacked" || actionBelow;

  return (
    <div
      className={cn(
        "flex w-full min-w-0 rounded-kit-card border border-border bg-surface-subtle p-3.5 text-left",
        stacked ? "flex-col items-start gap-3" : "flex-wrap items-center gap-3",
        className,
      )}
    >
      <p
        id={id}
        className={cn(
          "m-0 min-w-0 text-small leading-5 text-foreground wrap-anywhere select-text",
          !stacked && "flex-1 basis-[220px]",
        )}
      >
        {text}
      </p>
      <Button
        variant="outline"
        size="sm"
        aria-describedby={id}
        onClick={onCopy}
      >
        {copied ? (
          <Check size={14} strokeWidth={1.75} absoluteStrokeWidth aria-hidden="true" />
        ) : (
          <Copy size={14} strokeWidth={1.75} absoluteStrokeWidth aria-hidden="true" />
        )}
        <span>{copied ? t("copied") : label}</span>
        {context && <span className="sr-only">{context}</span>}
      </Button>
      {error && (
        <p
          className="m-0 flex basis-full items-center gap-1.5 text-meta leading-4 text-destructive"
          role="alert"
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
      {copied && (
        <span className="sr-only" role="status">
          {t("copied")}
        </span>
      )}
    </div>
  );
}
