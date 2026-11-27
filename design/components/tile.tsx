import type { ReactNode } from "react";
import { Frame, Icon } from "adg";
import { forms } from "../fixtures/tiles";

export type TileTone =
  "agent" | "command" | "file" | "thinking" | "warning" | "success" | "accent" | "neutral" | "danger";
export function Tile({
  icon,
  form = "card",
  tone = "command",
  overlay,
  size,
}: {
  icon: string;
  form?: "card" | "phase";
  tone?: TileTone;
  overlay?: ReactNode;
  size?: 24;
}) {
  const paint = {
    agent: "text-role-agent",
    neutral: "text-text-tertiary",
    danger: "text-danger",
    command: "text-phase-command",
    file: "text-phase-file",
    thinking: "text-phase-thinking",
    warning: "text-warning",
    success: "text-success",
    accent: "text-accent",
  };
  return (
    <span
      className={`grid shrink-0 place-items-center ${size === 24 ? "size-6 rounded-[8px]" : form === "phase" ? "size-8 rounded-tile" : "size-10 rounded-field"} ${paint[tone]}`}
    >
      <span
        className={`col-start-1 row-start-1 size-full rounded-[inherit] bg-current ${form === "phase" ? "opacity-17" : "opacity-16"}`}
      />
      <Icon name={icon} size={form === "phase" ? 16 : 18} className="col-start-1 row-start-1" />
      {overlay}
    </span>
  );
}
export default () =>
  forms.map(({ name, icon }) => (
    <Frame name={name}>
      <Tile icon={icon} form={name} />
    </Frame>
  ));
