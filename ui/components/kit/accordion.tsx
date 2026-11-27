import { Accordion as AccordionPrimitive } from "@base-ui/react/accordion";
import { ChevronDown } from "lucide-react";
import type * as React from "react";
import { stateClass } from "./utils";

export const Accordion: typeof AccordionPrimitive.Root = AccordionPrimitive.Root;

export function AccordionItem({
  className,
  ...props
}: AccordionPrimitive.Item.Props): React.ReactElement {
  return (
    <AccordionPrimitive.Item
      data-slot="accordion-item"
      className={stateClass("border-b border-border last:border-b-0", className)}
      {...props}
    />
  );
}

export function AccordionHeader({
  className,
  ...props
}: AccordionPrimitive.Header.Props): React.ReactElement {
  return (
    <AccordionPrimitive.Header
      data-slot="accordion-header"
      className={stateClass("flex", className)}
      {...props}
    />
  );
}

export function AccordionTrigger({
  className,
  children,
  showChevron = true,
  ...props
}: AccordionPrimitive.Trigger.Props & {
  showChevron?: boolean;
}): React.ReactElement {
  return (
    <AccordionPrimitive.Trigger
      data-slot="accordion-trigger"
      className={stateClass(
        "group flex flex-1 cursor-pointer items-center justify-between gap-2 py-2.5 text-left text-small font-semibold text-foreground outline-none transition-colors duration-(--motion-fast) ease-(--ease-enter) motion-reduce:transition-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-disabled:cursor-not-allowed data-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      {children}
      {showChevron && (
        <ChevronDown
          size={14}
          strokeWidth={1.75}
          absoluteStrokeWidth
          aria-hidden="true"
          className="shrink-0 text-text-secondary transition-transform duration-(--motion-base) ease-(--ease-enter) motion-reduce:transition-none group-data-panel-open:rotate-180"
        />
      )}
    </AccordionPrimitive.Trigger>
  );
}

export function AccordionPanel({
  className,
  ...props
}: AccordionPrimitive.Panel.Props): React.ReactElement {
  return (
    <AccordionPrimitive.Panel
      data-slot="accordion-panel"
      className={stateClass(
        "h-[var(--accordion-panel-height,auto)] overflow-hidden transition-[height,opacity] duration-(--motion-base) ease-(--ease-enter) data-starting-style:h-0 data-starting-style:opacity-0 data-ending-style:h-0 data-ending-style:opacity-0 motion-reduce:transition-none",
        className,
      )}
      {...props}
    />
  );
}

export { AccordionPrimitive, AccordionPanel as AccordionContent };
