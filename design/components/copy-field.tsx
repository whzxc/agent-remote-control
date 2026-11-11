import { Frame } from "adg";
import { IconButton } from "./icon-button";
import { copyFieldExample } from "../fixtures/inputs";

export function CopyField({
  value,
  label = "Copy",
  masked = false,
  password = false,
  loading = false,
  placeholder = "",
}: {
  value: string;
  label?: string;
  masked?: boolean;
  password?: boolean;
  loading?: boolean;
  placeholder?: string;
}) {
  return (
    <div
      class="flex w-full items-center justify-between gap-3 h-(--field-height)
        pl-(--field-padding-inline) pr-(--control-inset) rounded-field bg-surface-sunken text-text"
    >
      <span
        class={`min-w-0 truncate font-mono text-small ${masked || password ? "blur-[2px] opacity-50" : ""}`}
      >
        {value || placeholder}
      </span>
      <IconButton icon="copy" label={label} busy={loading} />
    </div>
  );
}
export default () => (
  <Frame name="default" width={680}>
    <CopyField {...copyFieldExample} />
  </Frame>
);
