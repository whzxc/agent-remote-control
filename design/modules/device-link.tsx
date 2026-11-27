import { Frame } from "adg";
import { DeviceFingerprintView } from "@/devices/DeviceFactsView";
import {
  DeviceAddressFormView,
  DevicePairFormView,
  DeviceRevokeCopyView,
} from "@/devices/DeviceLinkView";
import { LocaleProvider } from "@/i18n/react";
import { Button } from "../components/button";
import { Dialog } from "../components/panel";
import {
  controller,
  deviceCopy,
  errors,
  invalidPairingString,
  member,
  pairStates,
  pairingString,
  type DeviceLocale,
} from "../fixtures/device-link";

export type PairState =
  | "input"
  | "waiting"
  | "success"
  | "invalid"
  | "expired"
  | "protocol"
  | "declined"
  | "unreachable";

type Localized = { locale: DeviceLocale };

export function DeviceFingerprint({
  locale,
  value,
  controller: isController = false,
}: Localized & {
  value: string;
  controller?: boolean;
}) {
  return (
    <LocaleProvider locale={locale}>
      <DeviceFingerprintView value={value} controller={isController} />
    </LocaleProvider>
  );
}

export function DevicePairDialog({
  locale,
  state,
}: Localized & { state: PairState }) {
  const c = deviceCopy[locale];
  const error =
    state in errors ? errors[state as keyof typeof errors] : undefined;
  const waiting = state === "waiting";
  const success = state === "success";
  return (
    <LocaleProvider locale={locale}>
      <Dialog
        title={c.add}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="primary" busy={waiting}>
              {success ? c.done : waiting ? c.waiting : c.pair}
            </Button>
          </div>
        }
      >
        <DevicePairFormView
          state={state}
          input={
            state === "input"
              ? ""
              : state === "invalid"
                ? invalidPairingString
                : pairingString
          }
          memberName={member.name}
          controllerName="Anchor Mac"
          controllerFingerprint={controller.fingerprint}
          memberStatusLabel={`${c.online} · ${c.lan} · ${member.latency}`}
          errorCode={error?.code}
        />
      </Dialog>
    </LocaleProvider>
  );
}

export function DeviceAddressDialog({ locale }: Localized) {
  const c = deviceCopy[locale];
  return (
    <LocaleProvider locale={locale}>
      <Dialog
        title={c.override}
        footer={
          <div className="flex justify-end gap-2">
            <Button>{c.clear}</Button>
            <Button variant="primary">{c.save}</Button>
          </div>
        }
      >
        <DeviceAddressFormView deviceName={member.name} value={member.override} />
      </Dialog>
    </LocaleProvider>
  );
}

export function DeviceRevokeDialog({
  locale,
  memberSide,
}: Localized & { memberSide: boolean }) {
  const c = deviceCopy[locale];
  return (
    <LocaleProvider locale={locale}>
      <Dialog
        title={memberSide ? c.revokeMemberTitle : c.revokeTitle}
        footer={
          <div className="flex justify-end gap-2">
            <Button>{c.cancel}</Button>
            <Button variant="danger">{c.revoke}</Button>
          </div>
        }
      >
        <DeviceRevokeCopyView
          peerName={memberSide ? "Anchor Mac" : member.name}
          memberSide={memberSide}
        />
      </Dialog>
    </LocaleProvider>
  );
}

export default () =>
  (["en"] as const).flatMap((locale) => [
    ...pairStates
      .filter((state) => !["protocol", "declined", "unreachable"].includes(state))
      .map((state) => (
        <Frame
          key={`device-pair-${state}-${locale}`}
          width={592}
          name={`device-pair-${state}-${locale}`}
          fixture={`device-pair-${state}-${locale}@light`}
          capture={{ selector: ".device-dialog", viewport: "1280x800" }}
        >
          <DevicePairDialog locale={locale} state={state} />
        </Frame>
      )),
    <Frame
      key={`device-address-${locale}`}
      width={592}
      name={`device-address-${locale}`}
      fixture={`device-address-${locale}@light`}
      capture={{ selector: ".device-dialog", viewport: "1280x800" }}
    >
      <DeviceAddressDialog locale={locale} />
    </Frame>,
    ...[false].map((memberSide) => (
      <Frame
        key={`device-revoke-${memberSide ? "controller" : "member"}-${locale}`}
        width={592}
        name={`device-revoke-${memberSide ? "controller" : "member"}-${locale}`}
        fixture={`device-revoke-${memberSide ? "controller" : "member"}-${locale}@light`}
        capture={{ selector: ".device-dialog", viewport: "1280x800" }}
      >
        <DeviceRevokeDialog locale={locale} memberSide={memberSide} />
      </Frame>
    )),
  ]);
