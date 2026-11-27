import { Progress as ProgressPrimitive } from "@base-ui/react/progress";
import type * as React from "react";
import { cn, stateClass } from "./utils";

export function Progress({
  className,
  indicatorClassName,
  value,
  ...props
}: ProgressPrimitive.Root.Props & {
  indicatorClassName?: string;
}): React.ReactElement {
  return (
    <ProgressPrimitive.Root
      value={value}
      data-slot="progress"
      className={stateClass("w-full", className)}
      {...props}
    >
      <ProgressPrimitive.Track
        data-slot="progress-track"
        className="relative h-2 w-full overflow-hidden rounded-progress bg-surface-sunken"
      >
        <ProgressPrimitive.Indicator
          data-slot="progress-indicator"
          className={cn(
            "h-full rounded-progress bg-accent transition-[width] duration-(--motion-base) ease-(--ease-enter) motion-reduce:transition-none",
            indicatorClassName,
          )}
        />
      </ProgressPrimitive.Track>
    </ProgressPrimitive.Root>
  );
}

export { ProgressPrimitive };
