import type { ReactNode } from "react";
import { Frame } from "adg";
import {
  DeviceFingerprintView,
  DeviceIdentityView,
} from "@/devices/DeviceFactsView";
import { LocaleProvider } from "@/i18n/react";

export function DeviceFacts({
  children,
  variant = "detail",
  className: extra,
}: {
  children: ReactNode;
  variant?: "detail" | "fingerprint" | "identity";
  className?: string;
}) {
  return (
    <div className={extra ?? (variant === "fingerprint" ? "text-small" : "")}>
      {children}
    </div>
  );
}

export default () => (
  <Frame name="content" width={480}>
    <LocaleProvider locale="en">
      <DeviceFacts className="flex flex-col gap-4">
        <DeviceIdentityView
          name="Cedar Mac"
          platform="macos"
          state="online"
          pathLabel="LAN · 4 ms · Last seen just now"
        />
        <DeviceFingerprintView value="b10cb10cb10cb10c" />
      </DeviceFacts>
    </LocaleProvider>
  </Frame>
);
