import { Frame, Icon } from "adg";
import { searchInputExample } from "../fixtures/inputs";

export function SearchInput({
  placeholder,
  value,
  class: extra = "",
}: {
  placeholder: string;
  value?: string;
  class?: string;
}) {
  return (
    <div
      role="search"
      aria-label={placeholder}
      class={`flex w-full items-center gap-(--control-gap) h-(--control-height) px-3
        rounded-control bg-surface-sunken text-text-tertiary text-small ${extra}`}
    >
      <Icon name="search" size={14} class="size-(--field-icon-size)" />
      <span>{value || placeholder}</span>
    </div>
  );
}
export default () => (
  <Frame name="default" width={240}>
    <SearchInput {...searchInputExample} />
  </Frame>
);
