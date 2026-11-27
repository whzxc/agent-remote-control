import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { Check, ChevronRight } from "lucide-react";
import type * as React from "react";
import { cn, stateClass } from "./utils";

export const Menu: typeof MenuPrimitive.Root = MenuPrimitive.Root;
export const MenuTrigger: typeof MenuPrimitive.Trigger = MenuPrimitive.Trigger;
export const MenuGroup: typeof MenuPrimitive.Group = MenuPrimitive.Group;
export const MenuRadioGroup: typeof MenuPrimitive.RadioGroup =
  MenuPrimitive.RadioGroup;
export const MenuSubmenu: typeof MenuPrimitive.SubmenuRoot =
  MenuPrimitive.SubmenuRoot;

const popupClass =
  "max-h-[min(360px,var(--available-height))] min-w-40 max-w-[calc(100vw-24px)] origin-(--transform-origin) overflow-y-auto overscroll-contain rounded-popover border border-border-strong bg-surface-raised p-1 text-popover-foreground shadow-md outline-none transition-[opacity,scale] duration-(--motion-fast) ease-(--ease-enter) data-starting-style:opacity-0 data-starting-style:scale-95 data-ending-style:opacity-0 data-ending-style:scale-95 motion-reduce:transition-none dark:shadow-[inset_0_1px_0_rgb(255_255_255/6%),var(--shadow-md)]";

const itemClass =
  "flex min-h-7 cursor-default items-center gap-2 rounded-badge px-2.5 py-1 text-small text-foreground outline-none data-highlighted:bg-surface-subtle data-disabled:pointer-events-none data-disabled:opacity-50";

type PositionProps = Pick<
  MenuPrimitive.Positioner.Props,
  "align" | "alignOffset" | "side" | "sideOffset" | "collisionPadding" | "anchor"
>;

export function MenuPopup({
  align = "start",
  alignOffset = 0,
  side = "bottom",
  sideOffset = 6,
  collisionPadding = 12,
  anchor,
  portalProps,
  className,
  ...props
}: MenuPrimitive.Popup.Props &
  PositionProps & {
    portalProps?: MenuPrimitive.Portal.Props;
  }): React.ReactElement {
  return (
    <MenuPrimitive.Portal {...portalProps}>
      <MenuPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        anchor={anchor}
        data-slot="menu-positioner"
        className="z-60"
      >
        <MenuPrimitive.Popup
          data-slot="menu-popup"
          className={stateClass(popupClass, className)}
          {...props}
        />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

export function MenuItem({
  danger = false,
  className,
  ...props
}: MenuPrimitive.Item.Props & {
  danger?: boolean;
}): React.ReactElement {
  return (
    <MenuPrimitive.Item
      data-slot="menu-item"
      data-danger={danger || undefined}
      className={stateClass(
        cn(
          itemClass,
          danger && "text-destructive data-highlighted:bg-destructive/10",
        ),
        className,
      )}
      {...props}
    />
  );
}

export function MenuCheckboxItem({
  className,
  children,
  ...props
}: MenuPrimitive.CheckboxItem.Props): React.ReactElement {
  return (
    <MenuPrimitive.CheckboxItem
      data-slot="menu-checkbox-item"
      className={stateClass(itemClass, className)}
      {...props}
    >
      <span className="grid size-4 shrink-0 place-items-center" aria-hidden="true">
        <MenuPrimitive.CheckboxItemIndicator>
          <Check size={14} strokeWidth={2} />
        </MenuPrimitive.CheckboxItemIndicator>
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </MenuPrimitive.CheckboxItem>
  );
}

export function MenuRadioItem({
  className,
  children,
  ...props
}: MenuPrimitive.RadioItem.Props): React.ReactElement {
  return (
    <MenuPrimitive.RadioItem
      data-slot="menu-radio-item"
      className={stateClass(itemClass, className)}
      {...props}
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <span className="grid size-4 shrink-0 place-items-center" aria-hidden="true">
        <MenuPrimitive.RadioItemIndicator>
          <Check size={14} strokeWidth={2} />
        </MenuPrimitive.RadioItemIndicator>
      </span>
    </MenuPrimitive.RadioItem>
  );
}

export function MenuSubmenuTrigger({
  className,
  children,
  ...props
}: MenuPrimitive.SubmenuTrigger.Props): React.ReactElement {
  return (
    <MenuPrimitive.SubmenuTrigger
      data-slot="menu-submenu-trigger"
      className={stateClass(itemClass, className)}
      {...props}
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <ChevronRight
        size={14}
        strokeWidth={1.75}
        absoluteStrokeWidth
        aria-hidden="true"
        className="shrink-0 text-text-secondary"
      />
    </MenuPrimitive.SubmenuTrigger>
  );
}

export function MenuGroupLabel({
  className,
  ...props
}: MenuPrimitive.GroupLabel.Props): React.ReactElement {
  return (
    <MenuPrimitive.GroupLabel
      data-slot="menu-group-label"
      className={stateClass(
        "px-2.5 py-1.5 text-caption font-medium text-text-tertiary",
        className,
      )}
      {...props}
    />
  );
}

export function MenuSeparator({
  className,
  ...props
}: MenuPrimitive.Separator.Props): React.ReactElement {
  return (
    <MenuPrimitive.Separator
      data-slot="menu-separator"
      className={stateClass("mx-2 my-1 h-px bg-border", className)}
      {...props}
    />
  );
}

export {
  MenuPrimitive,
  MenuPopup as MenuContent,
  MenuGroupLabel as MenuLabel,
};
