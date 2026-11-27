import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import type * as React from "react";
import { stateClass } from "./utils";

export const Popover: typeof PopoverPrimitive.Root = PopoverPrimitive.Root;
export const PopoverTrigger: typeof PopoverPrimitive.Trigger =
  PopoverPrimitive.Trigger;
export const PopoverClose: typeof PopoverPrimitive.Close =
  PopoverPrimitive.Close;
export const PopoverPortal: typeof PopoverPrimitive.Portal =
  PopoverPrimitive.Portal;

export function PopoverPopup({
  className,
  align = "start",
  alignOffset = 0,
  anchor,
  sideOffset = 6,
  side = "bottom",
  collisionPadding = 12,
  portalProps,
  children,
  ...props
}: PopoverPrimitive.Popup.Props & {
  anchor?: PopoverPrimitive.Positioner.Props["anchor"];
  align?: PopoverPrimitive.Positioner.Props["align"];
  alignOffset?: PopoverPrimitive.Positioner.Props["alignOffset"];
  side?: PopoverPrimitive.Positioner.Props["side"];
  sideOffset?: PopoverPrimitive.Positioner.Props["sideOffset"];
  collisionPadding?: PopoverPrimitive.Positioner.Props["collisionPadding"];
  portalProps?: PopoverPrimitive.Portal.Props;
}): React.ReactElement {
  return (
    <PopoverPrimitive.Portal {...portalProps}>
      <PopoverPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        anchor={anchor}
        side={side}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        data-slot="popover-positioner"
        className="z-60"
      >
        <PopoverPrimitive.Popup
          data-slot="popover-popup"
          className={stateClass(
            "relative max-h-[min(70dvh,var(--available-height))] max-w-[calc(100vw-24px)] origin-(--transform-origin) overflow-auto rounded-[var(--radius-popover,8px)] border border-border-strong bg-surface-raised p-3.5 text-small text-popover-foreground shadow-md outline-none transition-[opacity,scale] duration-(--motion-fast) ease-(--ease-enter) data-starting-style:opacity-0 data-starting-style:scale-95 data-ending-style:opacity-0 data-ending-style:scale-95 motion-reduce:transition-none dark:shadow-[inset_0_1px_0_rgb(255_255_255/6%),var(--shadow-md)]",
            className,
          )}
          {...props}
        >
          {children}
        </PopoverPrimitive.Popup>
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

export { PopoverPrimitive, PopoverPopup as PopoverContent };
