import { Slider as SliderPrimitive } from "@base-ui/react/slider";
import type * as React from "react";
import { cn, stateClass } from "./utils";

export interface SliderProps
  extends Omit<
    SliderPrimitive.Root.Props<number>,
    "value" | "defaultValue" | "onValueChange" | "onValueCommitted"
  > {
  value?: number;
  defaultValue?: number;
  onValueChange?: (value: number) => void;
  onValueCommitted?: (value: number) => void;
  label?: string;
  valueText?: string;
  thumbClassName?: string;
}

export function Slider({
  className,
  value,
  defaultValue,
  min = 0,
  max = 100,
  step = 1,
  disabled,
  onValueChange,
  onValueCommitted,
  label,
  valueText,
  thumbClassName,
  ...props
}: SliderProps): React.ReactElement {
  return (
    <SliderPrimitive.Root
      value={value}
      defaultValue={defaultValue}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      onValueChange={
        onValueChange ? (next) => onValueChange(next) : undefined
      }
      onValueCommitted={
        onValueCommitted ? (next) => onValueCommitted(next) : undefined
      }
      data-slot="slider"
      className={stateClass(
        "relative flex w-full min-w-0 touch-none select-none items-center py-2 data-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <SliderPrimitive.Control
        data-slot="slider-control"
        className="flex w-full cursor-pointer items-center py-1.5 data-disabled:cursor-not-allowed"
      >
        <SliderPrimitive.Track
          data-slot="slider-track"
          className="relative h-1.5 w-full grow rounded-pill bg-secondary"
        >
          <SliderPrimitive.Indicator
            data-slot="slider-indicator"
            className="h-full rounded-pill bg-accent"
          />
          <SliderPrimitive.Thumb
            aria-label={label}
            aria-valuetext={valueText}
            data-slot="slider-thumb"
            className={cn(
              "block size-4 rounded-full border border-border-strong bg-knob shadow-sm outline-none transition-[transform,box-shadow] duration-(--motion-fast) ease-(--ease-enter) motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-ring data-dragging:scale-110",
              thumbClassName,
            )}
          />
        </SliderPrimitive.Track>
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  );
}

export { SliderPrimitive };
