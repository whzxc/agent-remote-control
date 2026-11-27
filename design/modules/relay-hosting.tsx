import { Frame } from "adg";
import { LocaleProvider } from "@/i18n/react";
import { RelayHostingView } from "@/components/hosting/RelayHostingView";

export function RelayHostingContent() {
  return (
    <LocaleProvider locale="en">
      <RelayHostingView loaded hasOwners={false} />
    </LocaleProvider>
  );
}

export default () => [
  <Frame key="empty" name="empty" width={712}>
    <div className="w-full bg-surface-raised">
      <RelayHostingContent />
    </div>
  </Frame>,
];
