import { Frame } from 'adg';
import { Button } from '../components/button';
import { Card } from '../components/card';
import { CopyField } from '../components/copy-field';
import { Field, Input } from '../components/field';
import { IconButton } from '../components/icon-button';
import { Notice } from '../components/notice';
import { Dialog, Panel } from '../components/panel';
import { SettingLine } from '../components/settings-row';
import { SingleChoice } from '../components/single-choice';
import { Switch } from '../components/switch';
import { Tag } from '../components/tag';
import { Tile } from '../components/tile';
import { NavCapsule } from './nav-capsule';
import {
  controller, deviceCopy, errors, locales, members, pairStates, pairingString, invalidPairingString, type DeviceLocale,
} from '../fixtures/device-link';

export type DeviceMember = {
  name: string; icon: string; platform: string; arch: string; version: string; fingerprint: string;
  state: 'online' | 'offline'; path: 'lan' | 'tunnel'; latency: string | null; seen: 'now' | 'ago';
  screen: boolean; addresses: string[]; tunnel: string | null; override?: string;
};
export type PairState = 'input' | 'waiting' | 'success' | 'invalid' | 'expired' | 'protocol' | 'declined' | 'unreachable';
export type WorkspaceState = 'controller' | 'empty' | 'detail-mac' | 'detail-windows' | 'detail-linux'
  | 'member-idle' | 'member-offer' | 'member-pending' | 'member-controlled' | 'member-expired' | 'member-declined';
type Localized = { locale: DeviceLocale };

export function DeviceExperiment({ locale, enabled }: Localized & { enabled: boolean }) {
  const c = deviceCopy[locale];
  return <Card class="py-0! gap-0!">
    <SettingLine title={c.deviceLink}><Switch checked={enabled} label={c.deviceLink} /></SettingLine>
  </Card>;
}
export function DeviceNavigation({ locale, enabled = true }: Localized & { enabled?: boolean }) {
  const c = deviceCopy[locale];
  const entries = [
    { id: 'settings', icon: 'settings', label: c.settings },
    { id: 'agents', icon: 'users', label: c.agents },
    { id: 'permissions', icon: 'shield-check', label: c.permissions },
    ...(enabled ? [{ id: 'devices', icon: 'monitor', label: c.devices }] : []),
  ];
  return <NavCapsule items={entries} active={enabled ? 'devices' : 'permissions'} />;
}
export function DeviceStatus({ member, locale }: Localized & { member: DeviceMember }) {
  const c = deviceCopy[locale];
  return <span class={`inline-flex items-center gap-1 text-meta ${member.state === 'online' ? 'text-success' : 'text-text-secondary'}`}>
    <span class="size-[6px] rounded-full bg-current" />{c[member.state]}
  </span>;
}
export function DeviceMemberRow({ member: m, locale }: Localized & { member: DeviceMember }) {
  const c = deviceCopy[locale];
  return <Card padded>
    <div class="flex items-center gap-3">
      <Tile icon={m.icon} tone={m.state === 'online' ? 'command' : 'neutral'} />
      <div class="flex min-w-0 flex-1 flex-col gap-1">
        <div class="flex items-center gap-3">
          <strong class="text-body font-semibold">{m.name}</strong><DeviceStatus member={m} locale={locale} />
        </div>
        <p class="text-meta leading-4 text-text-secondary">
          {m.state === 'offline' ? `${c.lastPath}: ` : ''}{m.path === 'lan' ? c.lan : c.tunnelPath}
          {m.latency ? ` · ${m.latency}` : ''}{` · ${c.lastSeen} ${c[m.seen]}`}
        </p>
      </div>
      <IconButton icon="chevron-right" label={`${c.open}: ${m.name}`} />
    </div>
  </Card>;
}
export function DeviceFingerprint({ locale, value, controller: isController = false }: Localized & {
  value: string; controller?: boolean;
}) {
  const c = deviceCopy[locale];
  return <div class="flex flex-col gap-2">
    <span class="text-small font-semibold">{isController ? c.controllerFingerprint : c.fingerprint}</span>
    <code class="break-all font-mono text-meta leading-5 text-text-secondary">{value.match(/.{1,16}/g)?.join(' ')}</code>
  </div>;
}
export function DeviceDetail({ locale, member: m }: Localized & { member: DeviceMember }) {
  const c = deviceCopy[locale];
  return <div class="flex flex-col gap-5">
    <div class="flex items-center gap-3">
      <Tile icon={m.icon} tone="command" /><div class="flex flex-1 flex-col gap-1">
        <strong class="text-body font-semibold">{m.name}</strong>
        <span class="text-meta text-text-secondary">
          {m.state === 'offline' ? `${c.lastPath}: ` : ''}{m.path === 'lan' ? c.lan : c.tunnelPath}
          {m.latency ? ` · ${m.latency}` : ''}{` · ${c.lastSeen} ${c[m.seen]}`}
        </span>
      </div><DeviceStatus locale={locale} member={m} />
    </div>
    {m.state === 'offline' && <Notice tone="warning">{c.offlineHint}</Notice>}
    <Card padded>
      <DeviceFingerprint locale={locale} value={m.fingerprint} />
      <dl class="grid grid-cols-2 gap-4 text-small">
        {[{ label: c.platform, value: `${m.platform} · ${m.arch}` }, { label: c.version, value: m.version }].map(f =>
          <div class="flex flex-col gap-2"><dt class="text-text-secondary">{f.label}</dt><dd>{f.value}</dd></div>)}
      </dl>
      <div class="flex flex-col gap-2">
        <span class="text-small font-semibold">{c.capabilities}</span>
        <div class="flex flex-wrap gap-2">
          {[c.tasks, c.command, c.files, m.screen ? c.screen : c.noScreen].map(label => <Tag form="fact">{label}</Tag>)}
        </div>
      </div>
    </Card>
    <Card padded>
      <div class="flex flex-col gap-2">
        <span class="text-small font-semibold">{c.addresses}</span>
        {m.addresses.map(address => <code class="font-mono text-small text-text-secondary">{address}</code>)}
      </div>
      <div class="flex flex-col gap-2">
        <span class="text-small font-semibold">{c.tunnel}</span>
        <code class="break-all font-mono text-small text-text-secondary">{m.tunnel ?? c.none}</code>
        {m.tunnel && <p class="text-meta leading-5 text-text-secondary">{c.tunnelNotice}</p>}
      </div>
    </Card>
    <Card class="py-0! gap-0!">
      <SettingLine title={c.override} description={[m.override ?? c.automatic]}>
        <Button icon="pencil">{c.edit}</Button>
      </SettingLine>
    </Card>
    <div class="flex justify-end"><Button variant="danger" icon="unlink">{c.revoke}</Button></div>
  </div>;
}
export function DevicePairDialog({ locale, state }: Localized & { state: PairState }) {
  const c = deviceCopy[locale];
  const error = state in errors ? errors[state as keyof typeof errors] : undefined;
  const waiting = state === 'waiting', success = state === 'success';
  return <Dialog title={c.add} size="m" footer={<div class="flex justify-end gap-2">
    <Button variant="primary" busy={waiting}>{success ? c.done : waiting ? c.waiting : c.pair}</Button>
  </div>}>
    <div class="flex flex-col gap-5">
      {success ? <Notice tone="success" title={c.paired}>
        <span class="text-text">{c.online} · {c.lan} · {members[0].latency}</span>
      </Notice> : <>
        <Field label={c.pairing} error={state === 'invalid' ? c.invalidHint : undefined}>
          <Input value={state === 'input' ? undefined : state === 'invalid' ? invalidPairingString : pairingString}
            placeholder={c.paste} invalid={!!error} truncate class="font-mono text-small" />
        </Field>
        {waiting ? <div class="flex flex-col gap-4" role="status">
          <p class="text-small leading-5">{c.waitingHint}</p>
          <DeviceFingerprint locale={locale} value={controller.fingerprint} controller />
          <p class="text-meta text-text-secondary">{c.deadline}</p>
        </div> : state === 'invalid' ? <code class="font-mono text-caption text-danger">{errors.invalid.code}</code>
          : error ? <Notice title={c[error.title]}>
          <p class="text-text">{c[error.detail]}</p><code class="font-mono text-caption">{error.code}</code>
        </Notice> : <p class="text-small leading-5 text-text-secondary">{c.lanOnly}</p>}
      </>}
    </div>
  </Dialog>;
}
export function DeviceAddressDialog({ locale }: Localized) {
  const c = deviceCopy[locale];
  return <Dialog title={c.override} size="s" footer={<div class="flex justify-end gap-2"><Button>{c.clear}</Button><Button variant="primary">{c.save}</Button></div>}>
    <form class="flex flex-col gap-5">
      <Field label={members[0].name}><Input value={members[0].override} /></Field>
      <p class="text-small leading-5 text-text-secondary">{c.overrideHint}</p>
    </form>
  </Dialog>;
}
export function DeviceRevokeDialog({ locale, memberSide }: Localized & { memberSide: boolean }) {
  const c = deviceCopy[locale];
  return <Dialog title={memberSide ? c.revokeMemberTitle : c.revokeTitle} size="s" footer={<div class="flex justify-end gap-2"><Button>{c.cancel}</Button><Button variant="danger">{c.revoke}</Button></div>}>
    <div class="flex flex-col gap-3 text-small leading-5">
      <p>{memberSide ? c.revokeMemberEffect : c.revokeEffect}</p>
      <p class="text-text-secondary">{c.localWork}</p>
    </div>
  </Dialog>;
}
export function DeviceMemberView({ locale, state }: Localized & { state: WorkspaceState }) {
  const c = deviceCopy[locale];
  if (state === 'member-controlled') return <Card padded>
    <div class="flex items-center gap-3"><Tile icon="laptop" tone="command" />
      <div class="flex flex-1 flex-col gap-1"><span class="text-meta text-text-secondary">{c.controlledBy}</span>
        <strong class="text-body">{controller.name}</strong></div>
      <Button variant="danger" icon="unlink">{c.revoke}</Button>
    </div>
    <DeviceFingerprint locale={locale} value={controller.fingerprint} controller />
    <p class="text-small leading-5 text-text-secondary">{c.currentAuthority}</p>
  </Card>;
  if (state === 'member-pending') return <Card padded>
    <div class="flex items-center gap-3"><Tile icon="laptop" tone="warning" />
      <div class="flex flex-col gap-1"><strong class="text-body">{c.pending}</strong>
        <span class="text-small">{controller.name}</span></div>
    </div>
    <DeviceFingerprint locale={locale} value={controller.fingerprint} controller />
    <p class="text-small leading-5 text-text-secondary">{c.compare}</p>
    <Notice tone="warning">{c.fullAuthority}</Notice>
    <div class="flex items-center justify-between gap-4">
      <span class="text-meta text-text-secondary">{c.offerDeadline}</span>
      <div class="flex gap-2"><Button>{c.decline}</Button><Button variant="primary">{c.approve}</Button></div>
    </div>
  </Card>;
  if (state === 'member-offer') return <Card padded>
    <Field label={c.pairing} help={<span class="text-meta font-normal text-text-secondary">{c.offerExpiry}</span>}>
      <CopyField value={pairingString} label={c.copy} />
    </Field>
    <p class="text-small leading-5 text-text-secondary">{c.offerHint}</p>
    <DeviceFingerprint locale={locale} value={members[0].fingerprint} />
  </Card>;
  return <div class="flex flex-col gap-4">
    {(state === 'member-expired' || state === 'member-declined') &&
      <Notice tone="warning">{state === 'member-expired' ? c.offerExpired : c.offerDeclined}</Notice>}
    <Card padded>
      <div class="flex items-center gap-3"><Tile icon="monitor" tone="neutral" />
        <div class="flex flex-1 flex-col gap-1"><strong class="text-body">{c.unpaired}</strong>
          <p class="text-meta text-text-secondary">{c.oneController}</p></div>
        <Button variant="primary" icon="plus">{c.createOffer}</Button>
      </div>
    </Card>
  </div>;
}
export function DevicesWorkspace({ locale, state, workspace = false }: Localized & { state: WorkspaceState; workspace?: boolean }) {
  const c = deviceCopy[locale], memberSide = state.startsWith('member-'), detail = state.startsWith('detail-');
  const member = members[state === 'detail-windows' ? 1 : state === 'detail-linux' ? 2 : 0];
  return <Panel size="l" slot={workspace ? "center" : undefined}
    title={c.devices} leading={detail ? <IconButton icon="arrow-left" label={c.back} /> : undefined}
    actions={<>{!memberSide && !detail && state !== 'empty' && <Button variant="primary" icon="plus">{c.add}</Button>}
      <IconButton icon="maximize-2" label={c.expand} /></>}>
    <div class="flex flex-col gap-6">
    {!detail && <div class="flex items-center justify-between">
      <SingleChoice label={c.view} value={memberSide ? 'member' : 'controller'} options={[
        { value: 'controller', label: c.members }, { value: 'member', label: c.thisDevice },
      ]} />
    </div>}
    {detail ? <DeviceDetail locale={locale} member={member} /> : memberSide ?
      <DeviceMemberView locale={locale} state={state} /> : state === 'empty' ?
        <div class="flex flex-col items-center gap-4 py-6">
          <Tile icon="monitor" tone="neutral" /><h3 class="text-title font-semibold">{c.empty}</h3>
          <p class="text-small leading-5 text-text-secondary">{c.emptyHint}</p>
          <Button variant="primary" icon="plus">{c.add}</Button>
        </div> : <div class="flex flex-col gap-3">
          {members.map(m => <DeviceMemberRow locale={locale} member={m} />)}
        </div>}
    </div>
  </Panel>;
}
export function DeviceTopologyEntry({ locale }: Localized) {
  return <Button icon="monitor">{deviceCopy[locale].topologySummary}</Button>;
}
export default () => locales.flatMap(locale => [
  ...[false, true].map(enabled => <Frame name={`device-experiment-${enabled ? 'on' : 'off'}-${locale}`} width={672}
    fixture={`device-experiment-${enabled ? 'on' : 'off'}-${locale}-light`}
    capture={{ selector: ".device-experiment", viewport: "1280x800" }}>
    <DeviceExperiment locale={locale} enabled={enabled} />
  </Frame>),
  ...[false, true].map(enabled => <Frame name={`device-navigation-${enabled ? 'enabled' : 'disabled'}-${locale}`}
    fixture={`device-navigation-${enabled ? 'enabled' : 'disabled'}-${locale}-light`}
    capture={{ selector: ".navigation-capsule", viewport: "1280x800" }}>
    <DeviceNavigation locale={locale} enabled={enabled} />
  </Frame>),
  ...pairStates.map(state => <Frame name={`device-pair-${state}-${locale}`}
    fixture={`device-pair-${state}-${locale}-light`} capture={{ selector: ".device-dialog", viewport: "1280x800" }}>
    <DevicePairDialog locale={locale} state={state} />
  </Frame>),
  <Frame name={`device-address-${locale}`} fixture={`device-address-${locale}-light`} capture={{ selector: ".device-dialog", viewport: "1280x800" }}><DeviceAddressDialog locale={locale} /></Frame>,
  ...[false, true].map(memberSide => <Frame name={`device-revoke-${memberSide ? 'controller' : 'member'}-${locale}`}
    fixture={`device-revoke-${memberSide ? 'controller' : 'member'}-${locale}-light`} capture={{ selector: ".device-dialog", viewport: "1280x800" }}>
    <DeviceRevokeDialog locale={locale} memberSide={memberSide} />
  </Frame>),
]);
