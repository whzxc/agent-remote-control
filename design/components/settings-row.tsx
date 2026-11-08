import { Card } from "./card";
import { SingleChoice } from "./single-choice";
import { Frame } from "sdg";
import { Switch } from "./switch";
import { example } from "../fixtures/settings-controls";
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
  <Frame name="setting" width={640}>
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

export function SettingsChoices({
  label,
  options,
  value = options[0],
  width = 300,
  dropdown = false,
}: {
  label: string;
  options: string[];
  value?: string;
  width?: number;
  dropdown?: boolean;
}) {
  return (
    <div style={{ width }}>
      <SingleChoice
        label={label}
        value={value}
        options={options.map((text) => ({ value: text, label: text }))}
        fill
        dropdown={dropdown}
      />
    </div>
  );
}
export function SettingsGroup({ title, children }: { title: string; children?: unknown }) {
  return (
    <section class="flex flex-col gap-3">
      <h3 class="text-small leading-4 font-[650] text-text-secondary">
        {title}
      </h3>
      <Card class="py-0! gap-0!">{children}</Card>
    </section>
  );
}
export function SettingsToggleRows({ rows }: { rows: { title: string; description: string[]; checked: boolean }[] }) {
  return (
    <>
      {rows.map((row) => (
        <SettingLine {...row}>
          <Switch checked={row.checked} label={row.title} />
        </SettingLine>
      ))}
    </>
  );
}
