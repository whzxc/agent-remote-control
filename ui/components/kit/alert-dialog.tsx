import { AlertDialog as AlertDialogPrimitive } from "@base-ui/react/alert-dialog";
import type * as React from "react";
import { buttonVariants } from "./button";
import { useDialogFinalFocus } from "./dialog-focus";
import { cn, stateClass } from "./utils";

export const AlertDialog: typeof AlertDialogPrimitive.Root =
  AlertDialogPrimitive.Root;
export const AlertDialogTrigger: typeof AlertDialogPrimitive.Trigger =
  AlertDialogPrimitive.Trigger;
export const AlertDialogPortal: typeof AlertDialogPrimitive.Portal =
  AlertDialogPrimitive.Portal;

export function AlertDialogBackdrop({
  className,
  ...props
}: AlertDialogPrimitive.Backdrop.Props): React.ReactElement {
  return (
    <AlertDialogPrimitive.Backdrop
      data-slot="alert-dialog-backdrop"
      className={stateClass(
        "fixed inset-0 z-60 bg-layer-scrim backdrop-blur-[2px] transition-opacity duration-(--motion-base) ease-(--ease-enter) data-starting-style:opacity-0 data-ending-style:opacity-0 data-ending-style:duration-(--motion-fast) data-ending-style:ease-(--ease-exit) motion-reduce:transition-none",
        className,
      )}
      {...props}
    />
  );
}

function AlertDialogPopupInner({
  className,
  finalFocus: finalFocusProp,
  ...props
}: AlertDialogPrimitive.Popup.Props): React.ReactElement {
  const fallbackFinalFocus = useDialogFinalFocus();

  return (
    <AlertDialogPrimitive.Popup
      data-slot="alert-dialog-popup"
      finalFocus={finalFocusProp ?? fallbackFinalFocus}
      className={stateClass(
        "fixed left-1/2 top-1/2 z-60 flex max-h-[calc(100dvh-32px)] w-[min(440px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[var(--radius-dialog,12px)] border border-border bg-surface-raised text-foreground shadow-lg outline-none transition-[opacity,scale] duration-(--motion-base) ease-(--ease-enter) data-starting-style:opacity-0 data-starting-style:scale-95 data-ending-style:opacity-0 data-ending-style:scale-95 data-ending-style:duration-(--motion-fast) data-ending-style:ease-(--ease-exit) motion-reduce:transition-none dark:border-border-strong dark:shadow-[inset_0_1px_0_rgb(255_255_255/6%),var(--shadow-lg)]",
        className,
      )}
      {...props}
    />
  );
}

export function AlertDialogPopup({
  onBackdropClick,
  portalProps,
  ...props
}: AlertDialogPrimitive.Popup.Props & {
  onBackdropClick?: () => void;
  portalProps?: AlertDialogPrimitive.Portal.Props;
}): React.ReactElement {
  return (
    <AlertDialogPrimitive.Portal {...portalProps}>
      <AlertDialogBackdrop onClick={onBackdropClick} />
      <AlertDialogPopupInner {...props} />
    </AlertDialogPrimitive.Portal>
  );
}

export function AlertDialogHeader({
  className,
  ...props
}: React.ComponentProps<"header">): React.ReactElement {
  return (
    <header
      data-slot="alert-dialog-header"
      className={cn("flex flex-col gap-1.5 px-4 pt-4 pb-3", className)}
      {...props}
    />
  );
}

export function AlertDialogFooter({
  className,
  ...props
}: React.ComponentProps<"footer">): React.ReactElement {
  return (
    <footer
      data-slot="alert-dialog-footer"
      className={cn(
        "flex flex-wrap items-center justify-end gap-2 border-t border-border bg-surface-subtle/60 px-4 py-3",
        className,
      )}
      {...props}
    />
  );
}

export function AlertDialogTitle({
  className,
  ...props
}: AlertDialogPrimitive.Title.Props): React.ReactElement {
  return (
    <AlertDialogPrimitive.Title
      data-slot="alert-dialog-title"
      className={stateClass(
        "text-body font-semibold leading-5 text-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function AlertDialogDescription({
  className,
  ...props
}: AlertDialogPrimitive.Description.Props): React.ReactElement {
  return (
    <AlertDialogPrimitive.Description
      data-slot="alert-dialog-description"
      className={stateClass(
        "text-small leading-5 text-text-secondary",
        className,
      )}
      {...props}
    />
  );
}

export function AlertDialogCancel({
  className,
  ...props
}: AlertDialogPrimitive.Close.Props): React.ReactElement {
  return (
    <AlertDialogPrimitive.Close
      data-slot="alert-dialog-cancel"
      className={stateClass(buttonVariants({ variant: "secondary" }), className)}
      {...props}
    />
  );
}

export function AlertDialogAction({
  variant = "danger",
  className,
  ...props
}: React.ComponentProps<"button"> & {
  variant?: "primary" | "danger" | "danger-outline";
}): React.ReactElement {
  return (
    <button
      type="button"
      data-slot="alert-dialog-action"
      className={cn(buttonVariants({ variant }), className)}
      {...props}
    />
  );
}

export { AlertDialogPrimitive, AlertDialogPopup as AlertDialogContent };
