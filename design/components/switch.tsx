import { Frame } from "adg";
import { Switch as KitSwitch } from "@/components/kit";
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
    <span className="inline-flex shrink-0">
      <KitSwitch
        id={id}
        checked={checked}
        aria-label={label}
        disabled={disabled}
        readOnly
      />
    </span>
  );
}

export default () =>
  switchForms.map(({ name, ...props }) => (
    <Frame key={name} name={name}>
      <Switch {...props} />
    </Frame>
  ));
