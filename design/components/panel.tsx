import { Frame, Icon } from "adg";
import { IconButton } from "./icon-button";
import { Button } from "./button";
import { Field, Input } from "./field";
import { dismissalCopy, dismissalForms } from "../fixtures/layers";
import { panelExample } from "../fixtures/panels";

export type LayerSize = "s" | "m" | "l" | "xl";
const layerWidths: Record<LayerSize, string> = {
  s: "var(--layer-s)", m: "var(--layer-m)", l: "var(--layer-l)", xl: "var(--layer-xl)",
};

export function Panel({
  title,
  kind = "panel",
  children,
  actions,
  footer,
  leading,
  headerDetail,
  headerNavigation,
  description,
  width = 560,
  size,
  slot,
  retainedHeight,
  viewportHeight,
  viewportWidth = 1280,
  headerless = false,
  roomyHeader = false,
}: {
  title?: unknown;
  kind?: "panel" | "dialog";
  children?: unknown;
  actions?: unknown;
  footer?: unknown;
  leading?: unknown;
  headerDetail?: unknown;
  headerNavigation?: unknown;
  description?: unknown;
  width?: number;
  size?: LayerSize;
  slot?: "center";
  retainedHeight?: number;
  viewportHeight?: number;
  viewportWidth?: number;
  headerless?: boolean;
  roomyHeader?: boolean;
}) {
  return (
    <section
      style={{ width: viewportHeight && (viewportWidth < 760 || viewportHeight > viewportWidth) ? `calc(${viewportWidth}px - 2 * var(--layer-side-margin))` : size ? layerWidths[size] : width, "--layer-retained-height": retainedHeight ? `${retainedHeight}px` : "0px", "--layer-viewport-height": viewportHeight ? `${viewportHeight}px` : undefined, "--layer-frame-top": kind === "dialog" ? "max(var(--layer-top-browser), calc(var(--layer-viewport-height) * 0.12))" : "var(--layer-top-browser)" }}
      class={`flex min-h-(--layer-retained-height) flex-col rounded-panel bg-surface-raised pb-6 px-6 text-text shadow-lg
        ${slot ? "mx-auto mt-(--layer-top) max-w-[calc(100%_-_2_*_var(--layer-side-margin))]! max-h-[calc(100%_-_var(--layer-top)_-_var(--layer-side-margin))]! max-[759px]:w-[calc(100%_-_2_*_var(--layer-side-margin))]! portrait:w-[calc(100%_-_2_*_var(--layer-side-margin))]!" : ""}
        ${viewportHeight ? "max-h-[calc(var(--layer-viewport-height)_-_var(--layer-frame-top)_-_var(--layer-side-margin))]!" : ""}
        ${size ? "max-w-full max-h-full [&>header]:shrink-0" : ""}
        ${roomyHeader ? "gap-[29px] pt-[21px]" : "gap-[25px] pt-[13px]"}`}
    >
      {!headerless && (
        <header class="flex h-(--control-height) items-center justify-between gap-4">
          {leading}
          <h2 class="text-title leading-6 font-[650]">{title}</h2>
          {headerNavigation}
          <div class="ml-auto flex items-center gap-(--control-gap)">
            {actions}
            <IconButton icon="x" label="Close" />
          </div>
        </header>
      )}
      {headerDetail}
      {description && (
        <div class="text-small text-text-secondary">{description}</div>
      )}
      {size ? <div class="min-h-0 flex-1 overflow-y-auto">{children}</div> : children}
      {size && footer ? <div class="shrink-0">{footer}</div> : footer}
    </section>
  );
}
export function Dialog(props: Parameters<typeof Panel>[0]) {
  return <Panel {...props} kind="dialog" />;
}
/** Content-sized shell for topology panels and workspace-specific headers. */
export function PanelShell({
  width,
  size,
  viewportHeight,
  viewportWidth = 1280,
  height,
  children,
  class: extra = "",
}: {
  width?: number;
  size?: LayerSize;
  viewportHeight?: number;
  viewportWidth?: number;
  height?: number;
  children?: unknown;
  class?: string;
}) {
  return (
    <section
      style={{ width: viewportHeight && (viewportWidth < 760 || viewportHeight > viewportWidth) ? `calc(${viewportWidth}px - 2 * var(--layer-side-margin))` : size ? layerWidths[size] : width, height, "--layer-viewport-height": viewportHeight ? `${viewportHeight}px` : undefined }}
      class={`flex min-h-(--layer-retained-height) flex-col rounded-panel bg-surface-raised text-text shadow-lg ${viewportHeight ? "max-h-[calc(var(--layer-viewport-height)_-_var(--layer-top-browser)_-_var(--layer-side-margin))]!" : ""} ${extra}`}
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
  title: unknown;
  children?: unknown;
  actions?: unknown;
  close?: boolean;
}) {
  return (
    <header class="flex h-(--control-height) shrink-0 items-center gap-4">
      <h2 class="text-title leading-6 font-[650]">{title}</h2>
      {children}
      <div class="ml-auto flex items-center gap-(--control-gap)">
        {actions}
        {close && <IconButton icon="x" label="Close" />}
      </div>
    </header>
  );
}

export function PanelLoading({ label }: { label: string }) {
  return (
    <div class="flex items-center justify-center gap-2 p-6 text-body text-text-secondary" role="status">
      <Icon name="loader-circle" size={16} />
      {label}
    </div>
  );
}


/** Replaces the dialog's normal footer after outside input or Escape. */
export function DialogDismissalFooter({ state }: { state: "discard" | "cancellable" | "running" }) {
  return (
    <footer class="flex flex-col gap-4 border-t border-border pt-4" role="status">
      <p class="text-small leading-5 text-text-secondary">{dismissalCopy[state]}</p>
      {state === "discard" && (
        <div class="flex flex-wrap justify-end gap-3">
          <Button variant="danger">{dismissalCopy.discardAction}</Button>
          <Button variant="primary" class="outline-2 outline-offset-2 outline-accent">{dismissalCopy.keep}</Button>
        </div>
      )}
      {state !== "discard" && (
        <div class="flex flex-wrap justify-end gap-3">
          {state === "cancellable" && <Button variant="danger">{dismissalCopy.stop}</Button>}
          <Button variant="primary" class="outline-2 outline-offset-2 outline-accent">{dismissalCopy.keepOpen}</Button>
        </div>
      )}
    </footer>
  );
}

export default () => {
  const actions = <IconButton icon="maximize-2" label="Expand" />;
  const content = (
    <div
      class="flex h-36 items-center justify-center rounded-card border border-dashed
        border-border-strong text-caption text-text-tertiary font-mono"
    >
      {panelExample.content}
    </div>
  );
  return [
    ...dismissalForms.map(({ name, state, note }) => (
      <Frame name={name} note={note}>
        <Dialog size="s" title={dismissalCopy.title} footer={<DialogDismissalFooter state={state} />}>
          <Field label={dismissalCopy.field}><Input value={dismissalCopy.value} /></Field>
        </Dialog>
      </Frame>
    )),
    <Frame name="panel">
      <Panel title={panelExample.title} actions={actions}>{content}</Panel>
    </Frame>,
    <Frame name="dialog">
      <Dialog title={panelExample.title} actions={actions}>{content}</Dialog>
    </Frame>,
    <Frame name="panel-shell">
      <PanelShell width={560}>{content}</PanelShell>
    </Frame>,
    <Frame name="panel-header" width={512}>
      <div class="w-full bg-surface-raised text-text">
        <PanelHeader title={panelExample.title} actions={actions} />
      </div>
    </Frame>,
  ];
};
