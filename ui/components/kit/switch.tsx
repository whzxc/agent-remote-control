import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import type * as React from "react";
import { stateClass } from "./utils";

export function Switch({
  className,
  ...props
}: SwitchPrimitive.Root.Props): React.ReactElement {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={stateClass(
        "inline-flex h-(--switch-height) w-(--switch-width) shrink-0 cursor-pointer items-center rounded-switch border border-transparent p-(--control-inset) outline-none transition-[background-color,box-shadow] duration-(--motion-fast) ease-(--ease-enter) motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background data-checked:bg-accent data-unchecked:bg-secondary data-disabled:cursor-not-allowed data-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block size-(--switch-thumb-size) rounded-full bg-knob shadow-sm transition-transform duration-(--motion-fast) ease-(--ease-enter) motion-reduce:transition-none data-checked:translate-x-[calc(var(--switch-width)-var(--switch-thumb-size)-2*var(--control-inset))]"
      />
    </SwitchPrimitive.Root>
  );
}

export { SwitchPrimitive };
