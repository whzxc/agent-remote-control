
import { Frame } from 'adg';
import { Button } from '../components/button';
import { Card } from '../components/card';
import { Field, Input } from '../components/field';
import { Notice } from '../components/notice';
import { Dialog } from '../components/panel';
import { SettingLine } from '../components/settings-row';
import { Switch } from '../components/switch';
import { controller, deviceCopy, errors, locales, member, pairStates, pairingString, invalidPairingString, type DeviceLocale } from '../fixtures/device-link';

export type PairState = 'input' | 'waiting' | 'success' | 'invalid' | 'expired' | 'protocol' | 'declined' | 'unreachable';
type Localized = { locale: DeviceLocale };
export function DeviceFingerprint({ locale, value, controller: isController = false }: Localized & {
  value: string; controller?: boolean;
}) {
  const c = deviceCopy[locale];
  return <div className="flex flex-col gap-2">
    <span className="text-small font-semibold">{isController ? c.controllerFingerprint : c.fingerprint}</span>
    <code className="break-all font-mono text-meta leading-5 text-text-secondary">{value.match(/.{1,16}/g)?.join(' ')}</code>
  </div>;
}
export function DevicePairDialog({ locale, state }: Localized & { state: PairState }) {
  const c = deviceCopy[locale];
  const error = state in errors ? errors[state as keyof typeof errors] : undefined;
  const waiting = state === 'waiting', success = state === 'success';
  return <Dialog title={c.add} footer={<div className="flex justify-end gap-2">
    <Button variant="primary" busy={waiting}>{success ? c.done : waiting ? c.waiting : c.pair}</Button>
  </div>}>
    <div className="flex flex-col gap-5">
      {success ? <Notice tone="success" title={c.paired}>
        <span className="text-text">{c.online} · {c.lan} · {member.latency}</span>
      </Notice> : <>
        <Field label={c.pairing} error={state === 'invalid' ? c.invalidHint : undefined}>
          <Input value={state === 'input' ? undefined : state === 'invalid' ? invalidPairingString : pairingString}
            placeholder={c.paste} invalid={!!error} truncate className="font-mono text-small" />
        </Field>
        {waiting ? <div className="flex flex-col gap-4" role="status">
          <p className="text-small leading-5">{c.waitingHint}</p>
          <DeviceFingerprint locale={locale} value={controller.fingerprint} controller />
          <p className="text-meta text-text-secondary">{c.deadline}</p>
        </div> : state === 'invalid' ? <code className="font-mono text-caption text-danger">{errors.invalid.code}</code>
          : error ? <Notice title={c[error.title]}>
          <p className="text-text">{c[error.detail]}</p><code className="font-mono text-caption">{error.code}</code>
        </Notice> : <p className="text-small leading-5 text-text-secondary">{c.lanOnly}</p>}
      </>}
    </div>
  </Dialog>;
}
export function DeviceAddressDialog({ locale }: Localized) {
  const c = deviceCopy[locale];
  return <Dialog title={c.override} footer={<div className="flex justify-end gap-2"><Button>{c.clear}</Button><Button variant="primary">{c.save}</Button></div>}>
    <form className="flex flex-col gap-5">
      <Field label={member.name}><Input value={member.override} /></Field>
      <p className="text-small leading-5 text-text-secondary">{c.overrideHint}</p>
    </form>
  </Dialog>;
}
export function DeviceRevokeDialog({ locale, memberSide }: Localized & { memberSide: boolean }) {
  const c = deviceCopy[locale];
  return <Dialog title={memberSide ? c.revokeMemberTitle : c.revokeTitle} footer={<div className="flex justify-end gap-2"><Button>{c.cancel}</Button><Button variant="danger">{c.revoke}</Button></div>}>
    <div className="flex flex-col gap-3 text-small leading-5">
      <p>{memberSide ? c.revokeMemberEffect : c.revokeEffect}</p>
      <p className="text-text-secondary">{c.localWork}</p>
    </div>
  </Dialog>;
}
export default () => (['en'] as const).flatMap(locale => [
  ...pairStates.filter(state => !['protocol', 'declined', 'unreachable'].includes(state)).map(state => <Frame width={592} name={`device-pair-${state}-${locale}`}
    fixture={`device-pair-${state}-${locale}@light`} capture={{ selector: ".device-dialog", viewport: "1280x800" }}>
    <DevicePairDialog locale={locale} state={state} />
  </Frame>),
  <Frame width={592} name={`device-address-${locale}`} fixture={`device-address-${locale}@light`} capture={{ selector: ".device-dialog", viewport: "1280x800" }}><DeviceAddressDialog locale={locale} /></Frame>,
  ...[false].map(memberSide => <Frame width={592} name={`device-revoke-${memberSide ? 'controller' : 'member'}-${locale}`}
    fixture={`device-revoke-${memberSide ? 'controller' : 'member'}-${locale}@light`} capture={{ selector: ".device-dialog", viewport: "1280x800" }}>
    <DeviceRevokeDialog locale={locale} memberSide={memberSide} />
  </Frame>),
]);
