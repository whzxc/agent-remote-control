import { Frame } from "adg";
import { switchForms } from "../fixtures/inputs";

export function Switch({
  checked,
  label,
  disabled = false,
  id,
}: {
  checked: boolean;
  label: string;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <button
      id={id}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      class={`flex shrink-0 items-center w-(--switch-width) h-(--switch-height)
        p-(--control-inset) rounded-switch ${checked ? "justify-end bg-accent" : "bg-surface-sunken"}`}
    >
      <span class="size-(--switch-thumb-size) rounded-full bg-knob shadow-sm" />
    </button>
  );
}
export default () =>
  switchForms.map(({ name, ...props }) => (
    <Frame name={name}>
      <Switch {...props} />
    </Frame>
  ));
