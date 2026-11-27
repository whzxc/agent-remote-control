import type { ReactNode } from "react";
import { Frame, Icon } from "adg";
import { IconButton } from "./icon-button";
import { Button } from "./button";
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
  roomyHeader = false,
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
  return (
    <section
      role={motionId ? (kind === "dialog" ? "dialog" : "region") : undefined}
      aria-label={motionId && typeof title === "string" ? title : undefined}
      data-adg-id={motionId} tabIndex={motionId ? -1 : undefined}
      style={{ height, width: viewportHeight && (viewportWidth < 760 || viewportHeight > viewportWidth) ? `calc(${viewportWidth}px - 2 * var(--layer-side-margin))` : `var(--layer-${size ?? (kind === "panel" ? "xl" : "m")})`, "--layer-retained-height": retainedHeight ? `${retainedHeight}px` : "0px", "--layer-viewport-height": viewportHeight ? `${viewportHeight}px` : undefined, "--layer-frame-top": `var(${kind === "panel" ? "--layer-panel-inset" : "--layer-top-browser"})`, "--layer-frame-bottom": `var(${kind === "panel" ? "--layer-panel-inset" : "--layer-top-browser"})` }}
      className={`${motionId ? "pointer-events-auto" : ""} flex min-h-(--layer-retained-height) flex-col rounded-panel ${transparent ? "bg-transparent backdrop-blur-[24px]" : "bg-surface-raised"} pb-6 px-6 text-text shadow-lg
        mx-auto max-w-[calc(100%_-_2_*_var(--layer-side-margin))]! max-h-[calc(100%_-_var(--layer-frame-top)_-_var(--layer-frame-bottom))]!
        ${viewportHeight ? "max-h-[calc(var(--layer-viewport-height)_-_var(--layer-frame-top)_-_var(--layer-frame-bottom))]!" : ""}
        max-w-full [&>header]:shrink-0
        ${roomyHeader ? "gap-[29px] pt-[21px]" : "gap-[25px] pt-[13px]"}`}
    >
      {!headerless && (
        <header data-adg-id={motionId && `${motionId}-header`} className="flex h-(--control-height) items-center justify-between gap-4" style={{height: headerHeight}}>
          {leading}
          <h2 className="text-title leading-6 font-[650]">{title}</h2>
          {headerNavigation}
          <div className="ml-auto flex items-center gap-(--control-gap)">
            {actions}
            <IconButton key="close" anchor={motionId && `${motionId}-close`} icon="x" label={closeLabel} />
          </div>
        </header>
      )}
      {headerDetail}
      {description && (
        <div className="text-small text-text-secondary">{description}</div>
      )}
      {headerless ? children : <div data-adg-id={motionId && `${motionId}-body`} className="min-h-0 flex-1 overflow-y-auto">{children}</div>}
      {footer ? <div className="shrink-0">{footer}</div> : footer}
    </section>
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
  return (
    <section
      style={{ width: viewportHeight && (viewportWidth < 760 || viewportHeight > viewportWidth) ? `calc(${viewportWidth}px - 2 * var(--layer-side-margin))` : "var(--layer-m)", height, "--layer-viewport-height": viewportHeight ? `${viewportHeight}px` : undefined }}
      className={`flex min-h-(--layer-retained-height) flex-col rounded-panel bg-surface-raised text-text shadow-lg ${viewportHeight ? "max-h-[calc(var(--layer-viewport-height)_-_2_*_var(--layer-panel-inset))]!" : ""} ${extra}`}
    >
      {children}
    </section>
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
    <header className="flex h-(--control-height) shrink-0 items-center gap-4">
      <h2 className="text-title leading-6 font-[650]">{title}</h2>
      {children}
      <div className="ml-auto flex items-center gap-(--control-gap)">
        {actions}
        {close && <IconButton icon="x" label="Close" />}
      </div>
    </header>
  );
}

export function PanelLoading({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center gap-2 p-6 text-body text-text-secondary" role="status">
      <Icon name="loader-circle" size={16} />
      {label}
    </div>
  );
}


/** Replaces the dialog's normal footer after outside input or Escape. */
export function DialogDismissalFooter({ state }: { state: "discard" | "cancellable" | "running" }) {
  return (
    <footer className="flex flex-col gap-4 border-t border-border pt-4" role="status">
      <p className="text-small leading-5 text-text-secondary">{dismissalCopy[state]}</p>
      {state === "discard" && (
        <div className="flex flex-wrap justify-end gap-3">
          <Button variant="danger">{dismissalCopy.discardAction}</Button>
          <Button variant="primary" className="outline-2 outline-offset-2 outline-accent">{dismissalCopy.keep}</Button>
        </div>
      )}
      {state !== "discard" && (
        <div className="flex flex-wrap justify-end gap-3">
          {state === "cancellable" && <Button variant="danger">{dismissalCopy.stop}</Button>}
          <Button variant="primary" className="outline-2 outline-offset-2 outline-accent">{dismissalCopy.keepOpen}</Button>
        </div>
      )}
    </footer>
  );
}

export default () => {
  const actions = <IconButton icon="maximize-2" label="Expand" />;
  const content = (
    <div
      className="flex h-36 items-center justify-center rounded-card border border-dashed
        border-border-strong text-caption text-text-tertiary font-mono"
    >
      {panelExample.content}
    </div>
  );
  return [
    <Frame name="panel" width={992} note="Desktop XL panel in its host slot; the panel body is 960px wide.">
      <Panel title={panelExample.title} actions={actions}>{content}</Panel>
    </Frame>,
    <Frame name="dialog" width={592}>
      <Dialog title={panelExample.title} actions={actions}>{content}</Dialog>
    </Frame>,
    <Frame name="panel-shell" width={560}>
      <PanelShell>{content}</PanelShell>
    </Frame>,
    ...dismissalForms.filter(form => form.name !== 'dialog-running-cancellable').map(({ name, state, note }) => (
      <Frame name={name} width={592} note={note}>
        <Dialog title={dismissalCopy.title} footer={<DialogDismissalFooter state={state} />}>
          <Field label={dismissalCopy.field}><Input value={dismissalCopy.value} /></Field>
        </Dialog>
      </Frame>
    )),
    <Frame name="panel-header" width={512}>
      <div className="w-full bg-surface-raised text-text">
        <PanelHeader title={panelExample.title} actions={actions} />
      </div>
    </Frame>,
  ];
};
