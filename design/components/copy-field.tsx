import { Frame } from "adg";
import { CopyField as KitCopyField, PrivacyProvider } from "@/components/kit";
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
  const field = (
    <KitCopyField
      value={value}
      label={label}
      password={password}
      loading={loading}
      placeholder={placeholder}
    />
  );
  if (masked && !password) {
    return <PrivacyProvider hidden>{field}</PrivacyProvider>;
  }
  return field;
}

export default () => (
  <Frame name="default" width={680}>
    <CopyField {...copyFieldExample} />
  </Frame>
);
