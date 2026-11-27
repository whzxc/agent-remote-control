import { Frame } from "adg";
import { SearchInput as KitSearchInput } from "@/components/kit";
import { searchInputExample } from "../fixtures/inputs";

export function SearchInput({
  placeholder,
  value,
  className: extra = "",
}: {
  placeholder: string;
  value?: string;
  className?: string;
}) {
  return (
    <KitSearchInput
      placeholder={placeholder}
      defaultValue={value}
      readOnly
      className={extra}
    />
  );
}

export default () => (
  <Frame name="default" width={240}>
    <SearchInput {...searchInputExample} />
  </Frame>
);
