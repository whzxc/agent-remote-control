import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";
import type { ReactElement, ReactNode } from "react";
import { cn } from "./utils";

export interface SegmentedOption<Value extends string | number = string> {
  value: Value;
  label: ReactNode;
  disabled?: boolean;
  "aria-label"?: string;
}

export interface SegmentedControlProps<Value extends string | number = string> {
  options: readonly SegmentedOption<Value>[];
  value: Value;
  onValueChange?: (value: Value) => void;
  disabled?: boolean;
  size?: "default" | "sm";
  equal?: boolean;
  className?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
}

export function SegmentedControl<Value extends string | number = string>({
  options,
  value,
  onValueChange,
  disabled,
  size = "default",
  equal = false,
  className,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
}: SegmentedControlProps<Value>): ReactElement {
  return (
    <RadioGroupPrimitive
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        const matched = options.find((option) => option.value === next);
        if (matched) onValueChange?.(matched.value);
      }}
      data-slot="segmented-control"
      data-size={size}
      className={cn(
        "min-w-0 max-w-full items-center gap-0.5 rounded-popover border border-border bg-surface-subtle p-0.5",
        equal ? "inline-grid grid-flow-col auto-cols-fr" : "inline-flex",
        className,
      )}
    >
      {options.map((option) => {
        const isDisabled = Boolean(disabled || option.disabled);
        return (
          <RadioPrimitive.Root
            key={String(option.value)}
            value={option.value}
            disabled={isDisabled}
            aria-label={option["aria-label"]}
            data-slot="segmented-control-item"
            className={cn(
              "relative inline-flex min-w-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-badge px-3 text-small font-medium text-text-secondary outline-none transition-[background-color,color,box-shadow] duration-(--motion-fast) ease-(--ease-enter) motion-reduce:transition-none hover:not-data-checked:not-data-disabled:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-checked:bg-surface-raised data-checked:font-semibold data-checked:text-foreground data-checked:shadow-sm data-disabled:cursor-not-allowed data-disabled:opacity-50",
              size === "sm" ? "h-[22px] px-2 text-meta" : "h-[26px]",
            )}
          >
            {option.label}
          </RadioPrimitive.Root>
        );
      })}
    </RadioGroupPrimitive>
  );
}
