import { Frame } from "sdg";
import { IconButton } from "./icon-button";
const example = { title: "MCP 中枢", content: "内容区域" };
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
      class={`flex flex-col rounded-panel bg-surface-raised pb-6 px-6 text-text shadow-lg ${roomyHeader ? "gap-[29px] pt-[21px]" : "gap-[25px] pt-[13px]"}`}
    >
      {!headerless && (
        <header class="flex h-(--control-height) items-center justify-between gap-4">
          {leading}
          <h2 class="text-title leading-6 font-[650]">{title}</h2>
          <div class="flex items-center gap-[6px]">
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
export default () => (
  <Frame name="workspace">
    <Panel
      title={example.title}
      actions={<IconButton icon="maximize-2" label="Expand" />}
    >
      <div class="flex h-36 items-center justify-center rounded-card border border-dashed border-border-strong text-caption text-text-tertiary font-mono">
        {example.content}
      </div>
    </Panel>
  </Frame>
);

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
    <header class="flex h-[34px] shrink-0 items-center gap-4">
      <h2 class="text-title leading-6 font-[650]">{title}</h2>
      {children}
      <div class="ml-auto flex items-center gap-[6px]">
        {actions}
        {close && <IconButton icon="x" label="Close" />}
      </div>
    </header>
  );
}
