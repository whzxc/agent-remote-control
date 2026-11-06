import { Frame, Icon } from "sdg";
const forms = [
  { name: "regular", compact: false, icon: "rotate-cw" },
  { name: "compact", compact: true, icon: "trash-2" },
];
export function IconButton({
  icon,
  label,
  busy = false,
  size = 16,
  compact = false,
  active = false,
  disabled = false,
}: {
  icon: string;
  label: string;
  busy?: boolean;
  size?: number;
  compact?: boolean;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      aria-label={label}
      disabled={disabled || busy}
      class={`flex shrink-0 items-center justify-center rounded-control text-text ${compact ? "size-[30px]" : "size-(--control-height)"} ${active ? "bg-surface-sunken" : ""}`}
    >
      <Icon name={busy ? "loader-circle" : icon} size={size} />
    </button>
  );
}
export default () =>
  forms.map(({ name, compact, icon }) => (
    <Frame name={name}>
      <IconButton icon={icon} label={icon} compact={compact} />
    </Frame>
  ));
