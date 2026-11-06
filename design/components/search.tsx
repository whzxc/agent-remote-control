import { Frame, Icon } from "sdg";
const example = "搜索服务器和工具";
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
      class={`flex w-full items-center gap-[6px] h-(--control-height) px-3 rounded-control bg-surface-sunken text-text-tertiary text-small ${extra}`}
    >
      <Icon name="search" size={14} />
      <span>{value || placeholder}</span>
    </div>
  );
}
export default () => (
  <Frame name="default" width={240}>
    <SearchInput placeholder={example} />
  </Frame>
);
