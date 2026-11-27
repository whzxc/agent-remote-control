import { Collapsible as CollapsiblePrimitive } from "@base-ui/react/collapsible";
import type * as React from "react";
import { stateClass } from "./utils";

export const Collapsible: typeof CollapsiblePrimitive.Root =
  CollapsiblePrimitive.Root;
export const CollapsibleTrigger: typeof CollapsiblePrimitive.Trigger =
  CollapsiblePrimitive.Trigger;

export function CollapsiblePanel({
  className,
  ...props
}: CollapsiblePrimitive.Panel.Props): React.ReactElement {
  return (
    <CollapsiblePrimitive.Panel
      data-slot="collapsible-panel"
      className={stateClass(
        "h-[var(--collapsible-panel-height,auto)] overflow-hidden transition-[height,opacity] duration-(--motion-base) ease-(--ease-enter) data-starting-style:h-0 data-starting-style:opacity-0 data-ending-style:h-0 data-ending-style:opacity-0 motion-reduce:transition-none",
        className,
      )}
      {...props}
    />
  );
}

export { CollapsiblePrimitive, CollapsiblePanel as CollapsibleContent };
