import { Maximize2, Minimize2, X } from "lucide-react";
import {
  useEffect,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
import { useI18n } from "@/i18n/react";
import { IconButton } from "./button";
import { cn } from "./utils";

const higherOverlaySelector = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="listbox"]',
  '[role="menu"]',
  '[data-slot="popover-popup"]',
  '[data-slot="select-popup"]',
  '[data-slot="menu-popup"]',
].join(", ");

function hasOpenOverlay(): boolean {
  for (const node of document.querySelectorAll(higherOverlaySelector)) {
    if (node.closest("[hidden]") || node.hasAttribute("data-closed")) continue;
    return true;
  }
  return false;
}

export type WorkspaceSize = "m" | "xl";

export interface WorkspaceShellSurfaceProps
  extends Omit<ComponentProps<"section">, "title"> {
  title?: ReactNode;
  description?: ReactNode;
  leading?: ReactNode;
  headerNavigation?: ReactNode;
  headerDetail?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  size?: WorkspaceSize;
  expanded?: boolean;
  onToggleExpand?: () => void;
  onClose?: () => void;
  closeLabel?: string;
  expandLabel?: string;
  headerless?: boolean;
  children?: ReactNode;
}

/** SSR-safe static workspace panel chrome usable directly in ADG frames and runtime shells. */
export function WorkspaceShellSurface({
  title,
  description,
  leading,
  headerNavigation,
  headerDetail,
  actions,
  footer,
  size = "xl",
  expanded = false,
  onToggleExpand,
  onClose,
  closeLabel,
  expandLabel,
  headerless = false,
  className,
  children,
  ...props
}: WorkspaceShellSurfaceProps): ReactElement {
  const { t } = useI18n();
  const widthClass = expanded
    ? "w-[min(1200px,calc(100vw-32px))]"
    : size === "m"
      ? "w-[min(560px,calc(100vw-32px))]"
      : "w-[min(960px,calc(100vw-32px))]";

  return (
    <section
      role="region"
      aria-label={typeof title === "string" ? title : undefined}
      data-slot="workspace-shell"
      data-size={size}
      data-expanded={expanded || undefined}
      className={cn(
        "flex min-h-0 max-h-[calc(100dvh-96px)] flex-col overflow-hidden rounded-[var(--radius-shell,12px)] border border-border bg-surface-raised text-foreground shadow-lg max-[720px]:w-[calc(100vw-16px)] max-[720px]:max-h-[calc(100dvh-16px)] dark:border-border-strong dark:shadow-[inset_0_1px_0_rgb(255_255_255/6%),var(--shadow-lg)]",
        widthClass,
        className,
      )}
      {...props}
    >
      {!headerless && (
        <header
          data-slot="workspace-header"
          className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border px-5"
        >
          {leading}
          {title && (
            <h2 className="min-w-0 truncate text-[15px] font-semibold leading-5 tracking-[-0.01em] text-foreground">
              {title}
            </h2>
          )}
          {headerNavigation}
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {actions}
            {onToggleExpand && (
              <IconButton
                compact
                icon={expanded ? Minimize2 : Maximize2}
                label={expandLabel ?? t(expanded ? "restorePanelWidth" : "expandPanelWidth")}
                aria-pressed={expanded}
                onClick={onToggleExpand}
              />
            )}
            {onClose && (
              <IconButton
                compact
                icon={X}
                label={closeLabel ?? t("close")}
                onClick={onClose}
              />
            )}
          </div>
        </header>
      )}
      {headerDetail}
      {description && (
        <div
          data-slot="workspace-description"
          className="shrink-0 border-b border-border px-5 py-2.5 text-small leading-5 text-text-secondary"
        >
          {description}
        </div>
      )}
      {headerless ? (
        children
      ) : (
        <div
          data-slot="workspace-body"
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4"
        >
          {children}
        </div>
      )}
      {footer && (
        <footer
          data-slot="workspace-footer"
          className="min-h-12 shrink-0 border-t border-border bg-surface-subtle/60 px-5 py-2.5"
        >
          {footer}
        </footer>
      )}
    </section>
  );
}

export interface WorkspaceShellProps extends WorkspaceShellSurfaceProps {
  open: boolean;
  onDismiss?: () => void;
}

/** Interactive pure-CSS centered workspace shell with Escape dismissal. */
export function WorkspaceShell({
  open,
  onDismiss,
  onClose,
  ...props
}: WorkspaceShellProps): ReactElement | null {
  useEffect(() => {
    if (!open || typeof document === "undefined") return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (hasOpenOverlay()) return;
      event.preventDefault();
      (onDismiss ?? onClose)?.();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onDismiss, onClose]);

  if (!open) return null;

  return (
    <div
      data-slot="workspace-host"
      className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center py-12 max-[720px]:p-2"
    >
      <WorkspaceShellSurface
        {...props}
        onClose={onClose}
        className={cn("pointer-events-auto", props.className)}
      />
    </div>
  );
}

export interface InspectorSheetSurfaceProps
  extends Omit<ComponentProps<"aside">, "title"> {
  title?: ReactNode;
  meta?: ReactNode;
  leading?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  onClose?: () => void;
  closeLabel?: string;
  children?: ReactNode;
}

/** SSR-safe static inspector sheet chrome for docked Topology node details. */
export function InspectorSheetSurface({
  title,
  meta,
  leading,
  actions,
  footer,
  wide = false,
  onClose,
  closeLabel,
  className,
  children,
  ...props
}: InspectorSheetSurfaceProps): ReactElement {
  const { t } = useI18n();
  return (
    <aside
      role="region"
      aria-label={typeof title === "string" ? title : undefined}
      data-slot="inspector-sheet"
      data-wide={wide || undefined}
      className={cn(
        "flex min-h-0 max-h-[calc(100dvh-60px)] flex-col overflow-hidden rounded-[var(--radius-shell,12px)] border border-border bg-surface-raised text-foreground shadow-lg max-[720px]:w-[calc(100vw-16px)] max-[720px]:max-h-[calc(100dvh-32px)] dark:border-border-strong dark:shadow-[inset_0_1px_0_rgb(255_255_255/6%),var(--shadow-lg)]",
        wide
          ? "w-[min(520px,calc(100vw-32px))]"
          : "w-[min(480px,calc(100vw-32px))]",
        className,
      )}
      {...props}
    >
      {(title || leading || actions || onClose) && (
        <header
          data-slot="inspector-header"
          className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3"
        >
          {leading}
          <div className="min-w-0 flex-1">
            {title && (
              <h2 className="truncate text-[15px] font-semibold leading-5 text-foreground">
                {title}
              </h2>
            )}
            {meta && (
              <p className="mt-0.5 truncate text-meta leading-4 text-text-secondary">
                {meta}
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {actions}
            {onClose && (
              <IconButton
                compact
                icon={X}
                label={closeLabel ?? t("close")}
                onClick={onClose}
              />
            )}
          </div>
        </header>
      )}
      <div
        data-slot="inspector-body"
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3.5"
      >
        {children}
      </div>
      {footer && (
        <footer
          data-slot="inspector-footer"
          className="max-h-[55%] shrink-0 overflow-y-auto border-t border-border bg-surface-raised px-4 py-3"
        >
          {footer}
        </footer>
      )}
    </aside>
  );
}

export interface InspectorSheetProps extends InspectorSheetSurfaceProps {
  open: boolean;
  onDismiss?: () => void;
  desktop?: boolean;
  placement?: "right" | "center";
}

/** Interactive pure-CSS docked inspector sheet over Homepage (no dim scrim). */
export function InspectorSheet({
  open,
  onDismiss,
  onClose,
  desktop = false,
  placement = "right",
  ...props
}: InspectorSheetProps): ReactElement | null {
  useEffect(() => {
    if (!open || typeof document === "undefined") return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (hasOpenOverlay()) return;
      event.preventDefault();
      (onDismiss ?? onClose)?.();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onDismiss, onClose]);

  if (!open) return null;

  return (
    <div
      data-slot="inspector-host"
      data-placement={placement}
      className={cn(
        "pointer-events-none fixed inset-0 z-40 flex px-4 pb-4 max-[720px]:items-center max-[720px]:justify-center max-[720px]:p-2",
        desktop ? "pt-[44px]" : "pt-4",
        placement === "right"
          ? "items-stretch justify-end"
          : "items-center justify-center",
      )}
    >
      <InspectorSheetSurface
        {...props}
        onClose={onClose}
        className={cn("pointer-events-auto", props.className)}
      />
    </div>
  );
}
