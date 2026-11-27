import { Frame, Icon } from "adg";
import { Button as KitButton } from "@/components/kit";
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
    <KitButton
      variant={active ? "secondary" : "ghost"}
      size={compact ? "icon-sm" : "icon"}
      busy={busy}
      disabled={disabled}
      aria-label={label}
      data-adg-id={anchor}
      data-slot="icon-button"
      className="rounded-pill"
    >
      {!busy && (
        <span
          className={
            agent
              ? "grid size-5 place-items-center rounded-full bg-role-agent text-canvas"
              : "flex"
          }
        >
          <Icon
            name={icon}
            size={size}
            className={size === undefined ? "size-(--control-icon-size)" : ""}
          />
        </span>
      )}
    </KitButton>
  );
}

export default () =>
  iconButtonForms.map(({ name, ...props }) => (
    <Frame key={name} name={name}>
      <IconButton {...props} />
    </Frame>
  ));
