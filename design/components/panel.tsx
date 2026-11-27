import type { ReactNode } from "react";
import { Frame } from "adg";
import {
  DialogSurface,
  DismissalFooter,
  InspectorSheetSurface,
  Spinner,
  WorkspaceShellSurface,
  cn,
} from "@/components/kit";
import { IconButton } from "./icon-button";
import { Field, Input } from "./field";
import { dismissalCopy, dismissalForms } from "../fixtures/layers";
import { panelExample } from "../fixtures/panels";

export function Panel({
  title,
  motionId,
  closeLabel = "Close",
  kind = "panel",
  children,
  actions,
  footer,
  leading,
  headerDetail,
  headerNavigation,
  description,
  size,
  retainedHeight,
  viewportHeight = 800,
  viewportWidth = 1280,
  headerless = false,
  transparent = false,
  headerHeight,
  height,
}: {
  title?: ReactNode;
  motionId?: string;
  closeLabel?: string;
  kind?: "panel" | "dialog";
  children?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  leading?: ReactNode;
  headerDetail?: ReactNode;
  headerNavigation?: ReactNode;
  description?: ReactNode;
  size?: "m" | "xl";
  retainedHeight?: number;
  viewportHeight?: number;
  viewportWidth?: number;
  headerless?: boolean;
  roomyHeader?: boolean;
  transparent?: boolean;
  headerHeight?: number;
  height?: number;
}) {
  const narrow =
    Boolean(viewportHeight) &&
    (viewportWidth < 760 || viewportHeight > viewportWidth);
  const closeButton = (
    <IconButton
      key="close"
      anchor={motionId && `${motionId}-close`}
      icon="x"
      label={closeLabel}
      compact
    />
  );

  if (kind === "dialog") {
    const dialogWidth = narrow
      ? `calc(${viewportWidth}px - 2 * var(--layer-side-margin))`
      : size === "xl"
        ? "var(--layer-xl)"
        : undefined;
    const maxHeight = viewportHeight
      ? `calc(${viewportHeight}px - 2 * var(--layer-top-browser))`
      : undefined;

    if (headerless) {
      return (
        <DialogSurface
          size="md"
          showCloseButton={false}
          role={motionId ? "dialog" : undefined}
          data-adg-id={motionId}
          tabIndex={motionId ? -1 : undefined}
          style={{
            width: dialogWidth,
            height,
            minHeight: retainedHeight || undefined,
            maxHeight,
          }}
          className={cn(
            motionId && "pointer-events-auto",
            "mx-auto max-w-[calc(100%-2*var(--layer-side-margin))]!",
          )}
          footer={footer}
        >
          {children}
        </DialogSurface>
      );
    }

    return (
      <DialogSurface
        size="md"
        title={title}
        description={description}
        actions={
          <>
            {actions}
            {closeButton}
          </>
        }
        footer={footer}
        showCloseButton={false}
        role={motionId ? "dialog" : undefined}
        aria-label={motionId && typeof title === "string" ? title : undefined}
        data-adg-id={motionId}
        tabIndex={motionId ? -1 : undefined}
        style={{
          width: dialogWidth,
          height,
          minHeight: retainedHeight || undefined,
          maxHeight,
        }}
        className={cn(
          motionId && "pointer-events-auto",
          "mx-auto max-w-[calc(100%-2*var(--layer-side-margin))]!",
        )}
      >
        {headerDetail}
        {children}
      </DialogSurface>
    );
  }

  const panelWidth = narrow
    ? `calc(${viewportWidth}px - 2 * var(--layer-side-margin))`
    : undefined;
  const panelMaxHeight = viewportHeight
    ? `calc(${viewportHeight}px - 2 * var(--layer-panel-inset))`
    : undefined;

  return (
    <WorkspaceShellSurface
      size={size ?? "xl"}
      headerless
      role={motionId ? "region" : undefined}
      aria-label={motionId && typeof title === "string" ? title : undefined}
      data-adg-id={motionId}
      tabIndex={motionId ? -1 : undefined}
      style={{
        width: panelWidth,
        height,
        minHeight: retainedHeight || undefined,
        maxHeight: panelMaxHeight,
      }}
      className={cn(
        motionId && "pointer-events-auto",
        transparent && "border-border/60 bg-transparent backdrop-blur-[24px]",
        "mx-auto max-w-[calc(100%-2*var(--layer-side-margin))]!",
      )}
      footer={footer}
    >
      {!headerless && (
        <header
          data-slot="workspace-header"
          data-adg-id={motionId && `${motionId}-header`}
          className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border px-5"
          style={headerHeight ? { height: headerHeight } : undefined}
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
            {closeButton}
          </div>
        </header>
      )}
      {headerDetail && <div className="shrink-0 px-5 pt-3">{headerDetail}</div>}
      {description && (
        <div
          data-slot="workspace-description"
          className="shrink-0 border-b border-border px-5 py-2.5 text-small leading-5 text-text-secondary"
        >
          {description}
        </div>
      )}
      {headerless ? (
        <div
          data-slot="workspace-body"
          data-adg-id={motionId && `${motionId}-body`}
          className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden px-5 py-4"
        >
          {children}
        </div>
      ) : (
        <div
          data-slot="workspace-body"
          data-adg-id={motionId && `${motionId}-body`}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4"
        >
          {children}
        </div>
      )}
    </WorkspaceShellSurface>
  );
}

export function Dialog(props: Parameters<typeof Panel>[0]) {
  return <Panel {...props} kind="dialog" />;
}

/** Content-sized shell for topology panels and workspace-specific headers. */
export function PanelShell({
  viewportHeight = 800,
  viewportWidth = 1280,
  height,
  children,
  className: extra = "",
}: {
  viewportHeight?: number;
  viewportWidth?: number;
  height?: number;
  children?: ReactNode;
  className?: string;
}) {
  const narrow =
    Boolean(viewportHeight) &&
    (viewportWidth < 760 || viewportHeight > viewportWidth);

  return (
    <InspectorSheetSurface
      style={{
        width: narrow
          ? `calc(${viewportWidth}px - 2 * var(--layer-side-margin))`
          : undefined,
        height,
        maxHeight: viewportHeight
          ? `calc(${viewportHeight}px - 2 * var(--layer-panel-inset))`
          : undefined,
      }}
      className={cn(
        extra && "[&>[data-slot=inspector-body]]:contents",
        extra,
      )}
    >
      {children}
    </InspectorSheetSurface>
  );
}

export function PanelHeader({
  title,
  children,
  actions,
  close = true,
}: {
  title: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  close?: boolean;
}) {
  return (
    <header className="flex h-(--kit-control-height) shrink-0 items-center gap-3">
      <h2 className="text-[15px] font-semibold leading-5 text-foreground">
        {title}
      </h2>
      {children}
      <div className="ml-auto flex items-center gap-1.5">
        {actions}
        {close && <IconButton compact icon="x" label="Close" />}
      </div>
    </header>
  );
}

export function PanelLoading({ label }: { label: string }) {
  return (
    <div
      className="flex items-center justify-center gap-2 p-6 text-small text-text-secondary"
      role="status"
    >
      <Spinner size={16} />
      {label}
    </div>
  );
}

/** Replaces the dialog's normal footer after outside input or Escape. */
export function DialogDismissalFooter({
  state,
}: {
  state: "discard" | "cancellable" | "running";
}) {
  return (
    <DismissalFooter
      status={state === "discard" ? "discard" : "running"}
      cancellable={state === "cancellable"}
      onDiscard={() => {}}
      onStopAndClose={() => {}}
      onKeepOpen={() => {}}
      className="-mx-5 -my-3 w-[calc(100%+2.5rem)]"
    />
  );
}

export default () => {
  const actions = <IconButton compact icon="maximize-2" label="Expand" />;
  const content = (
    <div
      className="flex h-36 items-center justify-center rounded-kit-card border border-dashed
        border-border-strong font-mono text-caption text-text-tertiary"
    >
      {panelExample.content}
    </div>
  );
  return [
    <Frame
      key="panel"
      name="panel"
      width={992}
      note="Desktop XL WorkspaceShell in its host slot; the shell width caps at 960px."
    >
      <Panel title={panelExample.title} actions={actions}>{content}</Panel>
    </Frame>,
    <Frame key="dialog" name="dialog" width={592}>
      <Dialog title={panelExample.title} actions={actions}>{content}</Dialog>
    </Frame>,
    <Frame key="panel-shell" name="panel-shell" width={560}>
      <PanelShell>{content}</PanelShell>
    </Frame>,
    ...dismissalForms
      .filter((form) => form.name !== "dialog-running-cancellable")
      .map(({ name, state, note }) => (
        <Frame key={name} name={name} width={592} note={note}>
          <Dialog
            title={dismissalCopy.title}
            footer={<DialogDismissalFooter state={state} />}
          >
            <Field label={dismissalCopy.field}>
              <Input value={dismissalCopy.value} />
            </Field>
          </Dialog>
        </Frame>
      )),
    <Frame key="panel-header" name="panel-header" width={512}>
      <div className="w-full bg-surface-raised text-text">
        <PanelHeader title={panelExample.title} actions={actions} />
      </div>
    </Frame>,
  ];
};
