import { Frame, Icon } from "adg";
import { iconButtonForms } from "../fixtures/buttons";

export function IconButton({
  icon,
  label,
  busy = false,
  size,
  compact = false,
  active = false,
  anchor,
  disabled = false,
  agent = false,
}: {
  icon: string;
  label: string;
  busy?: boolean;
  size?: number;
  compact?: boolean;
  active?: boolean;
  anchor?: string;
  disabled?: boolean;
  agent?: boolean;
}) {
  return (
    <button
      data-adg-id={anchor}
      aria-label={label}
      disabled={disabled || busy}
      className={`flex shrink-0 items-center justify-center rounded-control text-text
        ${compact ? "size-(--control-height-compact)" : "size-(--control-height)"} ${active ? "bg-surface-sunken" : ""}`}
    >
      <span className={agent ? "grid size-5 place-items-center rounded-full bg-role-agent text-canvas" : "flex"}>
        <Icon
          name={busy ? "loader-circle" : icon}
          size={size}
          className={size === undefined ? "size-(--control-icon-size)" : ""}
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
