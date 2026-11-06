import { Frame } from "sdg";
import { Switch } from "./switch";
const example = {
  title: "Wake control sources",
  description: [
    "Send task status notifications to bound control sources.",
    "Inboxes remain available when disabled.",
  ],
};
export function Setting({
  title,
  description,
  children,
  width = 300,
  toggle = false,
}: {
  title: unknown;
  description?: unknown;
  children?: unknown;
  width?: number;
  toggle?: boolean;
}) {
  return (
    <div class="flex w-full items-center justify-between gap-4 rounded-card bg-surface-subtle px-4 py-4">
      <div class="flex min-w-0 flex-col gap-[5px]">
        <div class="text-body leading-4 font-medium text-text">{title}</div>
        {description && (
          <div class="text-meta leading-[18px] text-text-secondary">
            {description}
          </div>
        )}
      </div>
      <div class="shrink-0" style={{ width: toggle ? 44 : width }}>
        {children}
      </div>
    </div>
  );
}
export function SettingsSection({
  title,
  children,
}: {
  title?: unknown;
  children?: unknown;
}) {
  return (
    <section class="flex flex-col gap-3">
      {title && <h2 class="text-body font-semibold text-text">{title}</h2>}
      {children}
    </section>
  );
}
export default () => (
  <Frame name="default" width={640}>
    <Setting
      title={example.title}
      description={example.description.map((line) => (
        <div>{line}</div>
      ))}
      toggle
    >
      <Switch checked={false} label={example.title} />
    </Setting>
  </Frame>
);

// Rows inside a shared settings card have their own content-driven height.
export function SettingLine({
  title,
  description,
  children,
  class: extra = "",
}: {
  title: unknown;
  description?: readonly string[];
  children?: unknown;
  class?: string;
}) {
  return (
    <div
      class={`flex min-h-14 items-center justify-between gap-4 px-4 ${description ? "py-[15px]" : "py-[11px]"} ${extra}`}
    >
      <div class="flex min-w-0 flex-col gap-[6px]">
        <div class="text-body leading-4 font-medium">{title}</div>
        {description && (
          <div class="text-meta leading-[18px] text-text-secondary">
            {description.map((line) => (
              <div>{line}</div>
            ))}
          </div>
        )}
      </div>
      <div class="shrink-0">{children}</div>
    </div>
  );
}
