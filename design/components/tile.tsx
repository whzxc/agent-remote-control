import { Frame, Icon } from "sdg";
import SourceArt from "../art/source.svg";
const forms = [
  { name: "card", icon: "globe" },
  { name: "phase", icon: "terminal" },
] as const;
export type TileTone =
  "command" | "file" | "thinking" | "warning" | "success" | "accent";
export function Tile({
  icon,
  form = "card",
  tone = "command",
  source = false,
}: {
  icon: string;
  form?: "card" | "phase";
  tone?: TileTone;
  source?: boolean;
}) {
  const paint = {
    command: "text-phase-command",
    file: "text-phase-file",
    thinking: "text-phase-thinking",
    warning: "text-warning",
    success: "text-success",
    accent: "text-accent",
  };
  return (
    <span
      class={`grid shrink-0 place-items-center ${form === "phase" ? "size-8 rounded-tile" : "size-10 rounded-field"} ${paint[tone]}`}
    >
      <span
        class={`col-start-1 row-start-1 size-full rounded-[inherit] bg-current ${form === "phase" ? "opacity-17" : "opacity-16"}`}
      />
      <Icon
        name={icon}
        size={form === "phase" ? 16 : 18}
        class="col-start-1 row-start-1"
      />
      {source && (
        <span class="col-start-1 row-start-1 self-end justify-self-end -mb-px -mr-px grid size-[13px] place-items-center rounded-[7px] bg-surface text-role-source">
          <SourceArt data-brand width={9} height={9} />
        </span>
      )}
    </span>
  );
}
export default () =>
  forms.map(({ name, icon }) => (
    <Frame name={name}>
      <Tile icon={icon} form={name} source={name === "phase"} />
    </Frame>
  ));
