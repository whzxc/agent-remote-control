import { Frame, Icon } from "adg";
import { IconButton } from "./icon-button";
import { panelExample } from "../fixtures/panels";

export function Panel({
  title,
  children,
  actions,
  footer,
  leading,
  headerDetail,
  description,
  width = 560,
  headerless = false,
  roomyHeader = false,
}: {
  title?: unknown;
  children?: unknown;
  actions?: unknown;
  footer?: unknown;
  leading?: unknown;
  headerDetail?: unknown;
  description?: unknown;
  width?: number;
  headerless?: boolean;
  roomyHeader?: boolean;
}) {
  return (
    <section
      style={{ width }}
      class={`flex flex-col rounded-panel bg-surface-raised pb-6 px-6 text-text shadow-lg
        ${roomyHeader ? "gap-[29px] pt-[21px]" : "gap-[25px] pt-[13px]"}`}
    >
      {!headerless && (
        <header class="flex h-(--control-height) items-center justify-between gap-4">
          {leading}
          <h2 class="text-title leading-6 font-[650]">{title}</h2>
          <div class="flex items-center gap-(--control-gap)">
            {actions}
            <IconButton icon="x" label="Close" />
          </div>
        </header>
      )}
      {headerDetail}
      {description && (
        <p class="text-small text-text-secondary">{description}</p>
      )}
      {children}
      {footer}
    </section>
  );
}
export function Dialog(props: Parameters<typeof Panel>[0]) {
  return <Panel {...props} />;
}
/** Content-sized shell for topology panels and workspace-specific headers. */
export function PanelShell({
  width,
  height,
  children,
  class: extra = "",
}: {
  width: number;
  height?: number;
  children?: unknown;
  class?: string;
}) {
  return (
    <section
      style={{ width, height }}
      class={`flex flex-col rounded-panel bg-surface-raised text-text shadow-lg ${extra}`}
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
    <div class="flex items-center justify-center gap-2 p-6 text-text-secondary" role="status">
      <Icon name="loader-circle" size={16} />
      {label}
    </div>
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
