import { mergeProps } from "@base-ui/react/merge-props";
import { Select as SelectPrimitive } from "@base-ui/react/select";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import {
  Check,
  ChevronDown,
  ChevronsUpDown,
  ChevronUp,
} from "lucide-react";
import type * as React from "react";
import { cn, stateClass } from "./utils";

export const Select: typeof SelectPrimitive.Root = SelectPrimitive.Root;

export const selectTriggerVariants = cva(
  "relative inline-flex w-auto min-w-0 cursor-pointer select-none items-center justify-between gap-2 rounded-[var(--radius-kit-field,6px)] border border-border bg-surface px-3 text-left text-small text-foreground outline-none ring-ring/24 transition-[border-color,box-shadow] duration-(--motion-fast) ease-(--ease-enter) motion-reduce:transition-none hover:not-focus-visible:not-data-popup-open:not-aria-invalid:border-border-strong data-popup-open:border-ring focus-visible:border-ring focus-visible:ring-2 aria-invalid:border-destructive data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg:not([class*='size-'])]:size-3.5 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    defaultVariants: {
      size: "default",
    },
    variants: {
      size: {
        default: "h-[var(--kit-control-height,30px)]",
        sm: "h-[var(--kit-control-height-sm,26px)] gap-1.5 px-2.5 text-meta",
        lg: "h-[var(--kit-field-height,32px)] px-3 text-body",
      },
    },
  },
);

export interface SelectButtonProps extends useRender.ComponentProps<"button"> {
  size?: VariantProps<typeof selectTriggerVariants>["size"];
}

export function SelectButton({
  className,
  size,
  render,
  children,
  ...props
}: SelectButtonProps): React.ReactElement {
  const defaultProps = {
    children: (
      <>
        <span className="flex-1 truncate">{children}</span>
        <ChevronsUpDown
          size={14}
          strokeWidth={1.75}
          absoluteStrokeWidth
          aria-hidden="true"
          className="shrink-0 text-text-secondary"
        />
      </>
    ),
    className: cn(selectTriggerVariants({ size }), className),
    "data-slot": "select-button",
    type: render ? undefined : ("button" as const),
  };

  return useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(defaultProps, props),
    render,
  });
}

export function SelectTrigger({
  className,
  size = "default",
  children,
  ...props
}: SelectPrimitive.Trigger.Props &
  VariantProps<typeof selectTriggerVariants>): React.ReactElement {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      className={stateClass(selectTriggerVariants({ size }), className)}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon
        data-slot="select-icon"
        className="flex shrink-0 text-text-secondary"
      >
        <ChevronsUpDown
          size={14}
          strokeWidth={1.75}
          absoluteStrokeWidth
          aria-hidden="true"
        />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

export function SelectValue({
  className,
  placeholder,
  children,
  ...props
}: SelectPrimitive.Value.Props & {
  placeholder?: React.ReactNode;
}): React.ReactElement {
  return (
    <SelectPrimitive.Value
      data-slot="select-value"
      className={stateClass(
        "flex-1 truncate data-placeholder:text-text-tertiary",
        className,
      )}
      {...props}
    >
      {children ?? ((value) => (value == null || value === "" ? placeholder : String(value)))}
    </SelectPrimitive.Value>
  );
}

export function SelectPopup({
  className,
  children,
  side = "bottom",
  sideOffset = 6,
  align = "start",
  alignOffset = 0,
  alignItemWithTrigger = false,
  collisionPadding = 12,
  anchor,
  portalProps,
  ...props
}: SelectPrimitive.Popup.Props & {
  portalProps?: SelectPrimitive.Portal.Props;
  side?: SelectPrimitive.Positioner.Props["side"];
  sideOffset?: SelectPrimitive.Positioner.Props["sideOffset"];
  align?: SelectPrimitive.Positioner.Props["align"];
  alignOffset?: SelectPrimitive.Positioner.Props["alignOffset"];
  alignItemWithTrigger?: SelectPrimitive.Positioner.Props["alignItemWithTrigger"];
  collisionPadding?: SelectPrimitive.Positioner.Props["collisionPadding"];
  anchor?: SelectPrimitive.Positioner.Props["anchor"];
}): React.ReactElement {
  return (
    <SelectPrimitive.Portal {...portalProps}>
      <SelectPrimitive.Positioner
        align={align}
        alignItemWithTrigger={alignItemWithTrigger}
        alignOffset={alignOffset}
        collisionPadding={collisionPadding}
        anchor={anchor}
        side={side}
        sideOffset={sideOffset}
        data-slot="select-positioner"
        className="z-60 select-none"
      >
        <SelectPrimitive.Popup
          data-slot="select-popup"
          className={stateClass(
            "relative min-w-(--anchor-width) max-w-[calc(100vw-24px)] origin-(--transform-origin) rounded-[var(--radius-popover,8px)] border border-border-strong bg-surface-raised text-popover-foreground shadow-md outline-none transition-[opacity,scale] duration-(--motion-fast) ease-(--ease-enter) data-starting-style:opacity-0 data-starting-style:scale-95 data-ending-style:opacity-0 data-ending-style:scale-95 motion-reduce:transition-none dark:shadow-[inset_0_1px_0_rgb(255_255_255/6%),var(--shadow-md)]",
            className,
          )}
          {...props}
        >
          <SelectPrimitive.ScrollUpArrow
            data-slot="select-scroll-up-arrow"
            className="flex h-6 w-full cursor-default items-center justify-center text-text-secondary"
          >
            <ChevronUp size={14} strokeWidth={1.75} absoluteStrokeWidth aria-hidden="true" />
          </SelectPrimitive.ScrollUpArrow>
          <SelectPrimitive.List
            data-slot="select-list"
            className="max-h-[min(320px,calc(var(--available-height)-8px))] overflow-y-auto overscroll-contain p-1"
          >
            {children}
          </SelectPrimitive.List>
          <SelectPrimitive.ScrollDownArrow
            data-slot="select-scroll-down-arrow"
            className="flex h-6 w-full cursor-default items-center justify-center text-text-secondary"
          >
            <ChevronDown size={14} strokeWidth={1.75} absoluteStrokeWidth aria-hidden="true" />
          </SelectPrimitive.ScrollDownArrow>
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  );
}

export function SelectItem({
  className,
  children,
  ...props
}: SelectPrimitive.Item.Props): React.ReactElement {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={stateClass(
        "grid min-h-7 cursor-default grid-cols-[minmax(0,1fr)_1rem] items-center gap-2 rounded-[var(--radius-badge,5px)] px-2.5 py-1 text-small text-foreground outline-none data-highlighted:bg-surface-subtle data-selected:font-semibold data-disabled:pointer-events-none data-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <SelectPrimitive.ItemText className="min-w-0 truncate">
        {children}
      </SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator className="flex items-center justify-center text-foreground">
        <Check size={14} strokeWidth={2} aria-hidden="true" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}

export function SelectSeparator({
  className,
  ...props
}: SelectPrimitive.Separator.Props): React.ReactElement {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={stateClass("mx-2 my-1 h-px bg-border", className)}
      {...props}
    />
  );
}

export function SelectGroup(
  props: SelectPrimitive.Group.Props,
): React.ReactElement {
  return <SelectPrimitive.Group data-slot="select-group" {...props} />;
}

export function SelectGroupLabel({
  className,
  ...props
}: SelectPrimitive.GroupLabel.Props): React.ReactElement {
  return (
    <SelectPrimitive.GroupLabel
      data-slot="select-group-label"
      className={stateClass(
        "px-2.5 py-1.5 text-caption font-medium text-text-tertiary",
        className,
      )}
      {...props}
    />
  );
}

export { SelectPrimitive, SelectPopup as SelectContent };
