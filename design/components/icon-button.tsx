import { Frame, Icon } from "sdg";
import { iconButtonForms } from "../fixtures/buttons";

export function IconButton({
  icon,
  label,
  busy = false,
  size,
  compact = false,
  active = false,
  disabled = false,
  agent = false,
}: {
  icon: string;
  label: string;
  busy?: boolean;
  size?: number;
  compact?: boolean;
  active?: boolean;
  disabled?: boolean;
  agent?: boolean;
}) {
  return (
    <button
      aria-label={label}
      disabled={disabled || busy}
      class={`flex shrink-0 items-center justify-center rounded-control text-text
        ${compact ? "size-(--control-height-compact)" : "size-(--control-height)"} ${active ? "bg-surface-sunken" : ""}`}
    >
      <span class={agent ? "grid size-5 place-items-center rounded-full bg-role-agent text-canvas" : "flex"}>
        <Icon
          name={busy ? "loader-circle" : icon}
          size={size}
          class={size === undefined ? "size-(--control-icon-size)" : ""}
        />
      </span>
    </button>
  );
}
export default () =>
  iconButtonForms.map(({ name, ...props }) => (
    <Frame name={name}>
      <IconButton {...props} />
    </Frame>
  ));
