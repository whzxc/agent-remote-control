import { Frame } from "sdg";
const forms = [
  { name: "on", checked: true },
  { name: "off", checked: false },
];
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
      class={`flex shrink-0 items-center w-11 h-[26px] p-[3px] rounded-[13px] ${checked ? "justify-end bg-accent" : "bg-surface-sunken"}`}
    >
      <span class="size-5 rounded-[10px] bg-knob shadow-sm" />
    </button>
  );
}
export default () =>
  forms.map(({ name, checked }) => (
    <Frame name={name}>
      <Switch checked={checked} label={name} />
    </Frame>
  ));
