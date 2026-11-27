import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import type * as React from "react";
import { useI18n } from "@/i18n/react";
import { useDialogFinalFocus } from "./dialog-focus";
import { cn, stateClass } from "./utils";

export const Dialog: typeof DialogPrimitive.Root = DialogPrimitive.Root;
export const DialogTrigger: typeof DialogPrimitive.Trigger =
  DialogPrimitive.Trigger;
export const DialogClose: typeof DialogPrimitive.Close = DialogPrimitive.Close;
export const DialogPortal: typeof DialogPrimitive.Portal =
  DialogPrimitive.Portal;

export type DialogSize = "sm" | "md" | "lg";

const dialogWidths: Record<DialogSize, string> = {
  sm: "w-[min(440px,calc(100vw-32px))]",
  md: "w-[min(540px,calc(100vw-32px))]",
  lg: "w-[min(640px,calc(100vw-32px))]",
};

export function DialogBackdrop({
  className,
  ...props
}: DialogPrimitive.Backdrop.Props): React.ReactElement {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-backdrop"
      className={stateClass(
        "fixed inset-0 z-50 bg-layer-scrim backdrop-blur-[2px] transition-opacity duration-(--motion-base) ease-(--ease-enter) data-starting-style:opacity-0 data-ending-style:opacity-0 data-ending-style:duration-(--motion-fast) data-ending-style:ease-(--ease-exit) motion-reduce:transition-none",
        className,
      )}
      {...props}
    />
  );
}

function DialogPopupInner({
  className,
  children,
  size,
  showCloseButton,
  closeLabel,
  finalFocus: finalFocusProp,
  ...props
}: DialogPrimitive.Popup.Props & {
  size: DialogSize;
  closeLabel?: string;
  showCloseButton: boolean;
}): React.ReactElement {
  const { t } = useI18n();
  const fallbackFinalFocus = useDialogFinalFocus();

  return (
    <DialogPrimitive.Popup
      data-slot="dialog-popup"
      data-size={size}
      finalFocus={finalFocusProp ?? fallbackFinalFocus}
      className={stateClass(
        cn(
          "fixed left-1/2 top-1/2 z-50 flex min-h-0 max-h-[calc(100dvh-32px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[var(--radius-dialog,12px)] border border-border bg-surface-raised text-foreground shadow-lg outline-none transition-[opacity,scale] duration-(--motion-base) ease-(--ease-enter) data-starting-style:opacity-0 data-starting-style:scale-95 data-ending-style:opacity-0 data-ending-style:scale-95 data-ending-style:duration-(--motion-fast) data-ending-style:ease-(--ease-exit) motion-reduce:transition-none dark:border-border-strong dark:shadow-[inset_0_1px_0_rgb(255_255_255/6%),var(--shadow-lg)]",
          dialogWidths[size],
        ),
        className,
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close
          aria-label={closeLabel ?? t("close")}
          data-slot="dialog-close"
          className="absolute right-3 top-2.5 inline-flex size-[var(--kit-control-height-sm,26px)] cursor-pointer items-center justify-center rounded-pill text-text-secondary outline-none transition-colors duration-(--motion-fast) ease-(--ease-enter) motion-reduce:transition-none hover:bg-surface-subtle hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X size={15} strokeWidth={1.75} absoluteStrokeWidth aria-hidden="true" />
        </DialogPrimitive.Close>
      )}
    </DialogPrimitive.Popup>
  );
}

export function DialogPopup({
  size = "md",
  showCloseButton = true,
  showBackdrop = true,
  portalProps,
  ...props
}: DialogPrimitive.Popup.Props & {
  size?: DialogSize;
  closeLabel?: string;
  showCloseButton?: boolean;
  showBackdrop?: boolean;
  portalProps?: DialogPrimitive.Portal.Props;
}): React.ReactElement {
  return (
    <DialogPrimitive.Portal {...portalProps}>
      {showBackdrop && <DialogBackdrop />}
      <DialogPopupInner
        size={size}
        showCloseButton={showCloseButton}
        {...props}
      />
    </DialogPrimitive.Portal>
  );
}

export function DialogHeader({
  className,
  ...props
}: React.ComponentProps<"header">): React.ReactElement {
  return (
    <header
      data-slot="dialog-header"
      className={cn(
        "flex min-h-[46px] shrink-0 flex-col justify-center gap-1 border-b border-border px-4 py-3 pr-11",
        className,
      )}
      {...props}
    />
  );
}

export function DialogTitle({
  className,
  ...props
}: DialogPrimitive.Title.Props): React.ReactElement {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={stateClass(
        "text-body font-semibold leading-5 text-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function DialogDescription({
  className,
  ...props
}: DialogPrimitive.Description.Props): React.ReactElement {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={stateClass("text-small leading-5 text-text-secondary", className)}
      {...props}
    />
  );
}

export function DialogBody({
  className,
  ...props
}: React.ComponentProps<"div">): React.ReactElement {
  return (
    <div
      data-slot="dialog-body"
      className={cn(
        "min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4",
        className,
      )}
      {...props}
    />
  );
}

export function DialogFooter({
  className,
  ...props
}: React.ComponentProps<"footer">): React.ReactElement {
  return (
    <footer
      data-slot="dialog-footer"
      className={cn(
        "flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border bg-surface-subtle/60 px-4 py-3",
        className,
      )}
      {...props}
    />
  );
}

/** SSR-safe static dialog shell for ADG `renderToStaticMarkup` and design specimens. */
export function DialogSurface({
  title,
  description,
  actions,
  footer,
  size = "md",
  closeLabel,
  showCloseButton = true,
  className,
  children,
  ...props
}: Omit<React.ComponentProps<"section">, "title"> & {
  title?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  footer?: React.ReactNode;
  size?: DialogSize;
  closeLabel?: string;
  showCloseButton?: boolean;
}): React.ReactElement {
  const { t } = useI18n();
  return (
    <section
      role="dialog"
      aria-label={typeof title === "string" ? title : undefined}
      data-slot="dialog-surface"
      data-size={size}
      className={cn(
        "flex min-h-0 max-h-[calc(100dvh-32px)] flex-col overflow-hidden rounded-[var(--radius-dialog,12px)] border border-border bg-surface-raised text-foreground shadow-lg dark:border-border-strong dark:shadow-[inset_0_1px_0_rgb(255_255_255/6%),var(--shadow-lg)]",
        dialogWidths[size],
        className,
      )}
      {...props}
    >
      {(title || actions || showCloseButton) && (
        <header
          data-slot="dialog-header"
          className="flex min-h-[46px] shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3"
        >
          <div className="min-w-0 flex-1">
            {title && (
              <h2 className="truncate text-body font-semibold leading-5 text-foreground">
                {title}
              </h2>
            )}
            {description && (
              <div
                data-slot="dialog-description"
                className="mt-0.5 text-small leading-5 text-text-secondary"
              >
                {description}
              </div>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {actions}
            {showCloseButton && (
              <button
                type="button"
                aria-label={closeLabel ?? t("close")}
                className="inline-flex size-[var(--kit-control-height-sm,26px)] items-center justify-center rounded-pill text-text-secondary"
              >
                <X size={15} strokeWidth={1.75} absoluteStrokeWidth aria-hidden="true" />
              </button>
            )}
          </div>
        </header>
      )}
      <DialogBody>{children}</DialogBody>
      {footer && <DialogFooter>{footer}</DialogFooter>}
    </section>
  );
}

export { DialogPrimitive, DialogPopup as DialogContent };
