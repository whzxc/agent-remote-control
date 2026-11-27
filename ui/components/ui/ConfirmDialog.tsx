import { useCallback, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { t } from "../../i18n";
import { layers, resolveReturnFocus } from "../../state/layers";
import {
  AlertDialog,
  AlertDialogBackdrop,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPrimitive,
  AlertDialogTitle,
} from "../kit/alert-dialog";
import { useDialogFinalFocus } from "../kit/dialog-focus";
import { DismissalFooter } from "../kit/dismissal";
import { cn } from "../kit/utils";
import type { DialogProps } from "./Dialog";
import { Button } from "./index";

type ConfirmDialogProps = Omit<DialogProps, "footer"> & {
  confirmLabel: ReactNode;
  onConfirm: () => unknown;
  confirmVariant?: "danger" | "primary";
  actionsClassName?: string;
};

export default function ConfirmDialog({
  layerId,
  open = true,
  onClose,
  busy,
  onCancel,
  title,
  description,
  children,
  className,
  returnFocus,
  confirmLabel,
  onConfirm,
  confirmVariant = "danger",
  actionsClassName,
}: ConfirmDialogProps) {
  const generatedId = useId();
  const id = layerId ?? generatedId;
  const snapshot = layers.use();
  const fallbackFinalFocus = useDialogFinalFocus();
  const [node, setNode] = useState<HTMLDivElement | null>(null);

  const allowed = !open || layers.canOpen("dialog", id);
  const self = snapshot.find((layer) => layer.id === id);
  const status = self?.dismissal ?? "none";
  const selfIndex = snapshot.findIndex((layer) => layer.id === id);
  const recessed = Boolean(self && snapshot.at(-1)?.id !== id);
  const showScrim = selfIndex > 0;
  const stack = layers.stack(id);

  const triggerRef = useRef<HTMLElement | null>(null);
  const latest = useRef({ onClose, busy, onCancel });
  latest.current = { onClose, busy, onCancel };

  useLayoutEffect(() => {
    if (!open || !allowed) return;
    triggerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    layers.open({ id, kind: "dialog", ...latest.current });
    return () => layers.remove(id);
  }, [open, allowed, id]);

  useLayoutEffect(() => {
    layers.update(id, { dirty: false, busy, onClose, onCancel });
  }, [id, busy, onClose, onCancel]);

  const close = useCallback(() => {
    void layers.close(id);
  }, [id]);

  const resolveFinalFocus = useCallback(() => {
    const active = document.activeElement;
    if (
      active instanceof HTMLElement &&
      active !== document.body &&
      active.isConnected &&
      !node?.contains(active)
    ) {
      return false;
    }
    const fallback = fallbackFinalFocus();
    return (
      resolveReturnFocus(
        triggerRef.current,
        returnFocus,
        fallback instanceof HTMLElement ? fallback : null,
      ) ?? false
    );
  }, [node, returnFocus, fallbackFinalFocus]);

  if (!open || !allowed) return null;

  const actionControls = (
    <>
      <Button onClick={close}>{t("cancel")}</Button>
      <Button
        variant={confirmVariant}
        busy={busy}
        onClick={() => {
          void onConfirm();
        }}
      >
        {confirmLabel}
      </Button>
    </>
  );

  return (
    <AlertDialog
      open={open && allowed}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && layers.top()?.id === id) layers.dismiss(id);
      }}
    >
      <AlertDialogPrimitive.Portal>
        {showScrim && (
          <AlertDialogBackdrop
            className="layer-scrim"
            style={{ zIndex: stack.scrim }}
          />
        )}
        <AlertDialogPrimitive.Popup
          ref={setNode}
          role="dialog"
          data-slot="alert-dialog-popup"
          data-layer-kind="dialog"
          data-layer-size="m"
          inert={recessed || undefined}
          finalFocus={resolveFinalFocus}
          style={{ zIndex: stack.dialog }}
          onKeyDown={(event) => {
            if (event.key === "Escape" && !event.defaultPrevented && layers.top()?.id === id) {
              event.preventDefault();
              layers.dismiss(id);
            }
          }}
          className={cn(
            "dialog layer-dialog fixed left-1/2 top-1/2 flex max-h-[calc(100dvh-32px)] w-[min(440px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-dialog border border-border bg-surface-raised text-foreground shadow-lg outline-none transition-[opacity,scale] duration-(--motion-base) ease-(--ease-enter) data-starting-style:opacity-0 data-starting-style:scale-95 data-ending-style:opacity-0 data-ending-style:scale-95 data-ending-style:duration-(--motion-fast) data-ending-style:ease-(--ease-exit) motion-reduce:transition-none dark:border-border-strong dark:shadow-[inset_0_1px_0_rgb(255_255_255/6%),var(--shadow-lg)]",
            className,
          )}
        >
          <AlertDialogHeader className="dialog-header border-b border-border px-5 py-3.5">
            <AlertDialogTitle>{title}</AlertDialogTitle>
            {description && (
              <div className="dialog-description text-small leading-5 text-text-secondary">
                {description}
              </div>
            )}
          </AlertDialogHeader>
          <div
            className="dialog-body flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 py-4 text-small leading-5 text-text-secondary"
            inert={status !== "none" || undefined}
          >
            {children}
          </div>
          {status === "none" ? (
            <AlertDialogFooter className="dialog-footer px-5 py-3">
              {actionsClassName ? (
                <div className={cn("flex flex-wrap items-center justify-end gap-2", actionsClassName)}>
                  {actionControls}
                </div>
              ) : (
                actionControls
              )}
            </AlertDialogFooter>
          ) : (
            <DismissalFooter
              status={status}
              cancellable={Boolean(onCancel)}
              onDiscard={() => void layers.confirmDiscard(id)}
              onStopAndClose={() => layers.stopAndClose(id)}
              onKeepOpen={() => layers.keepOpen(id)}
            />
          )}
        </AlertDialogPrimitive.Popup>
      </AlertDialogPrimitive.Portal>
    </AlertDialog>
  );
}
