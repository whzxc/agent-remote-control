import type { ReactElement } from "react";
import { Alert } from "../kit/alert";
import { Button } from "../kit/button";
import { Field } from "../kit/field";
import { SegmentedControl, type SegmentedOption } from "../kit/segmented-control";
import { cn } from "../kit/utils";

export interface ToolPolicyViewProps {
  label: string;
  value: string;
  options: readonly SegmentedOption<string>[];
  onChange?: (value: string) => void;
  disabled?: boolean;
  summary?: string;
  summaryHidden?: boolean;
  viewAllLabel: string;
  onViewAll?: () => void;
  error?: string;
  retryLabel?: string;
  onRetry?: () => void;
  className?: string;
}

export function ToolPolicyView({
  label,
  value,
  options,
  onChange,
  disabled = false,
  summary,
  summaryHidden = false,
  viewAllLabel,
  onViewAll,
  error,
  retryLabel,
  onRetry,
  className,
}: ToolPolicyViewProps): ReactElement {
  return (
    <Field label={label} className={className}>
      <SegmentedControl
        equal
        className="w-full"
        aria-label={label}
        value={value}
        onValueChange={onChange}
        options={options}
        disabled={disabled}
      />
      <div
        className={cn(
          "flex flex-wrap items-center gap-3 pt-0.5",
          summaryHidden && "invisible",
        )}
        aria-hidden={summaryHidden || undefined}
      >
        {summary && (
          <span className="text-meta leading-4 text-text-secondary tabular-nums">
            {summary}
          </span>
        )}
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          onClick={onViewAll}
        >
          {viewAllLabel}
        </Button>
      </div>
      {error && (
        <Alert
          tone="danger"
          action={
            onRetry && retryLabel ? (
              <Button size="sm" onClick={onRetry}>
                {retryLabel}
              </Button>
            ) : undefined
          }
        >
          {error}
        </Alert>
      )}
    </Field>
  );
}
