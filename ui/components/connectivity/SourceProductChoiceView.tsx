import type { ReactElement } from "react";
import { SegmentedControl, type SegmentedOption } from "../kit/segmented-control";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../kit/select";
import { cn } from "../kit/utils";

export interface SourceProductChoiceViewProps {
  label: string;
  moreLabel: string;
  primaryValue: string;
  primaryOptions: readonly SegmentedOption<string>[];
  onPrimaryChange?: (value: string) => void;
  showOverflow: boolean;
  overflowValue: string;
  overflowOptions: readonly { value: string; label: string }[];
  onOverflowChange?: (value: string) => void;
  disabled?: boolean;
  className?: string;
}

export function SourceProductChoiceView({
  label,
  moreLabel,
  primaryValue,
  primaryOptions,
  onPrimaryChange,
  showOverflow,
  overflowValue,
  overflowOptions,
  onOverflowChange,
  disabled = false,
  className,
}: SourceProductChoiceViewProps): ReactElement {
  const selectedOverflowLabel =
    overflowOptions.find((item) => item.value === overflowValue)?.label ?? "";

  return (
    <div className={cn("grid min-w-0 gap-2", className)}>
      <SegmentedControl
        aria-label={label}
        value={primaryValue}
        disabled={disabled}
        onValueChange={onPrimaryChange}
        options={primaryOptions}
      />
      {showOverflow && (
        <Select
          value={overflowValue}
          disabled={disabled}
          onValueChange={(next) => {
            if (typeof next === "string") onOverflowChange?.(next);
          }}
        >
          <SelectTrigger aria-label={moreLabel} className="w-full">
            <SelectValue placeholder={moreLabel}>
              {selectedOverflowLabel || moreLabel}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {overflowOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      )}
    </div>
  );
}
