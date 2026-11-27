import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import {
  createContext,
  useContext,
  useRef,
  useState,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { usePrivacyRedactor } from "./privacy";
import { stateClass } from "./utils";

const TooltipProviderContext = createContext(false);

export function TooltipProvider({
  delay = 150,
  ...props
}: TooltipPrimitive.Provider.Props): ReactElement {
  return (
    <TooltipProviderContext.Provider value={true}>
      <TooltipPrimitive.Provider delay={delay} {...props} />
    </TooltipProviderContext.Provider>
  );
}

export const Tooltip: typeof TooltipPrimitive.Root = TooltipPrimitive.Root;
export const TooltipTrigger: typeof TooltipPrimitive.Trigger =
  TooltipPrimitive.Trigger;

export function TooltipPopup({
  className,
  align = "center",
  sideOffset = 6,
  side = "top",
  collisionPadding = 12,
  children,
  ...props
}: TooltipPrimitive.Popup.Props & {
  align?: TooltipPrimitive.Positioner.Props["align"];
  side?: TooltipPrimitive.Positioner.Props["side"];
  sideOffset?: TooltipPrimitive.Positioner.Props["sideOffset"];
  collisionPadding?: TooltipPrimitive.Positioner.Props["collisionPadding"];
}): ReactElement {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        align={align}
        side={side}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        data-slot="tooltip-positioner"
        className="z-80"
      >
        <TooltipPrimitive.Popup
          data-slot="tooltip-popup"
          className={stateClass(
            "max-w-[min(300px,calc(100vw-24px))] origin-(--transform-origin) wrap-anywhere rounded-kit-field bg-action px-2 py-1 text-[11.5px] font-medium leading-4 text-on-action shadow-md transition-[opacity,scale] duration-(--motion-fast) ease-(--ease-enter) data-starting-style:opacity-0 data-starting-style:scale-95 data-ending-style:opacity-0 data-ending-style:scale-95 motion-reduce:transition-none",
            className,
          )}
          {...props}
        >
          {children}
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}

/** Convenience wrapper preserving ARC's mouse-movement guard for `hoverOnly` triggers. */
export function HintTooltip({
  text,
  children,
  side = "top",
  hoverOnly = false,
}: {
  text: ReactNode;
  children: ReactElement;
  side?: "top" | "bottom" | "left" | "right";
  hoverOnly?: boolean;
}): ReactElement {
  const provided = useContext(TooltipProviderContext);
  const redact = usePrivacyRedactor();
  const [open, setOpen] = useState(false);
  const pointerHover = useRef(false);

  const dismiss = () => {
    pointerHover.current = false;
    setOpen(false);
  };

  if (!text) return children;

  const content = (
    <TooltipPrimitive.Root
      open={open}
      onOpenChange={(next, details) => {
        if (hoverOnly && next && details.reason !== "trigger-hover") {
          setOpen(false);
          return;
        }
        setOpen(next && (!hoverOnly || pointerHover.current));
      }}
      disableHoverablePopup={hoverOnly}
    >
      <TooltipPrimitive.Trigger
        render={children}
        onPointerMoveCapture={
          hoverOnly
            ? (event: PointerEvent<HTMLElement>) => {
                // Restored focus or a surface disappearing under a stationary
                // pointer is not a new hover; require real mouse movement.
                if (
                  event.pointerType === "mouse" &&
                  event.buttons === 0 &&
                  (event.movementX !== 0 || event.movementY !== 0)
                ) {
                  pointerHover.current = true;
                }
              }
            : undefined
        }
        onPointerLeave={hoverOnly ? dismiss : undefined}
        onPointerDownCapture={hoverOnly ? dismiss : undefined}
        onClickCapture={hoverOnly ? dismiss : undefined}
        onBlur={hoverOnly ? dismiss : undefined}
      />
      <TooltipPopup side={side}>
        {typeof text === "string" ? redact(text) : text}
      </TooltipPopup>
    </TooltipPrimitive.Root>
  );

  return provided ? content : <TooltipProvider>{content}</TooltipProvider>;
}

export { TooltipPrimitive, TooltipPopup as TooltipContent };
