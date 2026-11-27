import type { ReactNode } from "react";
import { Card } from "./card";
import { SingleChoice } from "./single-choice";
import { Frame } from "adg";
import { Switch } from "./switch";
import { example } from "../fixtures/settings-controls";
export function Setting({
  title,
  description,
  children,
  width = 300,
  toggle = false,
}: {
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  width?: number;
  toggle?: boolean;
}) {
  return (
    <div className={`flex w-full items-center justify-between gap-6 px-4 min-h-14 ${description ? "py-[14px]" : "py-[11px]"}`}>
      <div className="flex min-w-0 flex-col gap-1">
        <div className="text-body leading-5 font-medium text-text">{title}</div>
        {description && (
          <div className="text-meta leading-[18px] text-text-secondary whitespace-pre-line">
            {description}
          </div>
        )}
      </div>
      <div className="shrink-0" style={{ width: toggle ? "var(--switch-width)" : width }}>
        {children}
      </div>
    </div>
  );
}
export function SettingsSection({
  title,
  children,
}: {
  title?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      {title && <h2 className="text-small leading-4 font-[650] text-text-secondary">{title}</h2>}
      <Card className="py-0! gap-0!">{children}</Card>
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
  className: extra = "",
}: {
  title: ReactNode;
  description?: readonly string[] | string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`flex min-h-14 items-center justify-between gap-4 px-4 ${description ? "py-[15px]" : "py-[11px]"} ${extra}`}
    >
      <div className="flex min-w-0 flex-col gap-[6px]">
        <div className="text-body leading-4 font-medium">{title}</div>
        {description && (
          <div className="text-meta leading-[18px] text-text-secondary">
            {typeof description === "string" ? description : description.map((line) => (
              <div>{line}</div>
            ))}
          </div>
        )}
      </div>
      <div className="shrink-0">{children}</div>
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
export function SettingsGroup({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-small leading-4 font-[650] text-text-secondary">
        {title}
      </h3>
      <Card className="py-0! gap-0!">{children}</Card>
    </section>
  );
}
export function SettingsToggleRows({ rows }: { rows: { title: string; description: string[] | string; checked: boolean }[] }) {
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
