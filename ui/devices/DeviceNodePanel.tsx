import { deviceTasks } from './tasks';
import { focusNodeTasks } from '../state/homepage';
import { icons, name as agentName } from '../state/agents';
import { setControllerSources } from './state';
import { useSubmittedDirty } from "../components/ui/useSubmittedDirty";
import Panel from "../components/ui/Panel";
import { DialogActions, useDialogCompletion } from "../components/ui/Dialog";
import { useEffect, useId, useRef, useState } from 'react';
import { ChevronRight, Laptop, Monitor, Pencil, Plus, Server, Unlink } from 'lucide-react';
import { api } from '../api';
import { locale, t } from '../i18n';
import { relativeTime } from '../lib/relativeTime';
import { ConfirmDialog, Button, CopyField, Dialog, Field, Icon, IconButton, Input, Notice, Tag, Tile, Switch, BrandMark } from '../components/ui';
import { Card } from '../components/ui/card';
import { SettingLine } from '../components/ui/Settings';
import { cancelDevicePair, connectDevice, deviceError, deviceOffer, devicePair, deviceSnapshot, deviceView, memberOutcome, pairedDevices, refreshDevices, type Device, type Peer } from './state';
import './devices.css';

const c = (key: string, params?: Record<string, unknown>) => t(`device.${key}`, params);
const iconFor = (device: Device) => device.platform === 'darwin' || device.platform === 'macos' ? Laptop : device.platform === 'linux' ? Server : Monitor;
const countdown = (seconds: number) => `${String(Math.max(0, Math.floor(seconds / 60))).padStart(2, '0')}:${String(Math.max(0, seconds % 60)).padStart(2, '0')}`;
function Fingerprint({ value, controller = false }: { value: string; controller?: boolean }) {
  return <div className="device-fingerprint"><span>{c(controller ? 'controllerFingerprint' : 'fingerprint')}</span><code>{value.match(/.{1,16}/g)?.join(' ')}</code></div>;
}
function DeviceStatus({ device }: { device: Device }) {
  return <span className="device-status" data-state={device.state}><span aria-hidden="true" />{c(device.state)}</span>;
}
function Path({ device }: { device: Device }) {
  const elapsed = device.lastSeen ? Date.now() - Date.parse(device.lastSeen) : NaN;
  const seen = elapsed >= 60000 && elapsed < 3600000 ? c('minutesAgo', { minutes: Math.round(elapsed / 60000) }) : relativeTime(device.lastSeen, Date.now(), locale.get(), c('now'));
  const text = `${device.state === 'offline' ? `${c('lastPath')}: ` : ''}${c(device.path === 'lan' ? 'lan' : 'tunnelPath')}${device.latency !== null ? ` · ${device.latency} ms` : ''} · ${c('lastSeen')} ${seen || c('none')}`;
  return <span className="device-meta">{text}</span>;
}
function DeviceIdentity({ device, row = false }: { device: Device; row?: boolean }) {
  return <div className="device-identity"><Tile icon={iconFor(device)} className={row && device.state === 'offline' ? 'device-neutral' : 'device-command'} />
    <div className="device-name"><div><strong>{device.name}</strong>{row && <DeviceStatus device={device} />}</div><Path device={device} /></div>
    {!row && <DeviceStatus device={device} />}
    {row && <IconButton icon={ChevronRight} label={`${c('open')}: ${device.name}`} onClick={() => deviceView.set({ side: 'controller', detail: device.id })} />}
  </div>;
}
function Detail({ device }: { device: Device }) {
  const capabilityLabels = device.capabilities ? ['tasks', 'command', 'files', device.capabilities.screen ? 'screen' : 'noScreen'] : [];
  const platform = device.platform === 'darwin' || device.platform === 'macos' ? 'macOS' : device.platform === 'windows' ? 'Windows' : device.platform === 'linux' ? 'Linux' : device.platform;
  return <div className="device-detail">
    <DeviceIdentity device={device} />
    {device.state === 'offline' && <Notice layout="inline" tone="warning">{device.error || c('offlineHint')}</Notice>}
    <Card padded><Fingerprint value={device.id} /><dl className="device-facts">
      <div><dt>{c('platform')}</dt><dd>{[platform, device.arch].filter(Boolean).join(' · ') || c('none')}</dd></div>
      <div><dt>{c('version')}</dt><dd>{device.arcVersion || c('none')}</dd></div>
    </dl><div className="device-fingerprint"><span>{c('capabilities')}</span><div className="device-tags">{capabilityLabels.length ? capabilityLabels.map(label => <Tag key={label} form="fact">{c(label)}</Tag>) : c('none')}</div></div></Card>
    <Card padded><div className="device-fingerprint device-addresses"><span>{c('addresses')}</span>{device.addresses.length ? device.addresses.map(address => <code key={address}>{address}</code>) : c('none')}</div>
      <div className="device-fingerprint"><span>{c('tunnel')}</span><code className="device-address-code">{device.tunnelUrl || c('none')}</code>{device.tunnelUrl && <p className="device-meta device-paragraph">{c('tunnelNotice')}</p>}</div>
    </Card>
    <Card className="device-setting"><SettingLine title={c('override')} description={device.addressOverride || c('automatic')}><Button onClick={() => deviceView.set(old => ({ ...old, dialog: 'address' }))}><Icon icon={Pencil} />{c('edit')}</Button></SettingLine></Card>
    <div className="device-actions"><Button variant="danger" onClick={() => deviceView.set(old => ({ ...old, dialog: 'revoke', revoke: device }))}><Icon icon={Unlink} />{c('revoke')}</Button></div>
  </div>;
}
function Member({ act, busy }: { act: (action: 'offer' | 'approve' | 'decline') => void; busy: boolean }) {
  const snapshot = deviceSnapshot.use(), offer = deviceOffer.use(), outcome = memberOutcome.use();
  const pending = snapshot?.pending, controller = snapshot?.controller;
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const seconds = offer ? Math.max(0, Math.ceil((offer.expiresAt - now) / 1000)) : 0;
  if (controller) return <Card padded><div className="device-identity"><Tile icon={Laptop} className="device-command" /><div className="device-name"><span className="device-meta">{c('controlledBy')}</span><strong>{controller.name}</strong></div><Button variant="danger" onClick={() => deviceView.set(old => ({ ...old, dialog: 'revoke', revoke: controller }))}><Icon icon={Unlink} />{c('revoke')}</Button></div><Fingerprint value={controller.deviceId} controller /><p className="device-paragraph device-muted">{c('currentAuthority')}</p></Card>;
  if (pending) return <Card padded><div className="device-identity"><Tile icon={Laptop} className="device-warning" /><div className="device-name"><strong className="device-heavy">{c('pending')}</strong><span>{pending.name}</span></div></div><Fingerprint value={pending.deviceId} controller /><p className="device-paragraph device-muted">{c('compare', { name: pending.name })}</p><Notice layout="inline" tone="warning">{c('fullAuthority')}</Notice><div className="device-split"><span className="device-meta">{c('offerDeadline', { time: countdown(pending.expiresInSeconds) })}</span><div className="device-actions"><Button disabled={busy} onClick={() => act('decline')}>{c('decline')}</Button><Button variant="primary" disabled={busy} onClick={() => act('approve')}>{c('approve')}</Button></div></div></Card>;
  if (offer && seconds > 0) return <Card padded><Field label={c('pairing')} help={<span className="device-meta">{c('offerExpiry', { time: countdown(seconds) })}</span>}><CopyField value={offer.pairingString} label={c('copy')} /></Field><p className="device-paragraph device-muted">{c('offerHint')}</p><Fingerprint value={snapshot!.deviceId} /></Card>;
  return <div className="device-member-state">{(outcome || offer && seconds === 0) && <Notice layout="inline" tone="warning">{c(outcome === 'declined' ? 'offerDeclined' : 'offerExpired')}</Notice>}<Card padded><div className="device-identity"><Tile icon={Monitor} className="device-neutral" /><div className="device-name"><strong className="device-heavy">{c('unpaired')}</strong><span className="device-meta">{c('oneController')}</span></div><Button data-device-offer variant="primary" busy={busy} onClick={() => act('offer')}><Icon icon={Plus} />{c('createOffer')}</Button></div></Card></div>;
}
function PairDialog({ close }: { close: () => void }) {
  const pair = devicePair.use(), snapshot = deviceSnapshot.use(), inputId = useId(), input = useRef<HTMLInputElement>(null);
  const waiting = pair.state === 'waiting', success = pair.state === 'success';
  const dismiss = () => { if (devicePair.get().state === 'success') devicePair.set({ state: 'input', input: '' }); close(); };
  const error = !['input', 'waiting', 'success'].includes(pair.state);
  useEffect(() => { if (error) input.current?.focus(); }, [pair.state, error]);
  const titles: Record<string, string> = { invalid: 'invalid', expired: 'expired', protocol: 'protocol', declined: 'declined', unreachable: 'unreachable' };
  const member = pair.memberId && pairedDevices(snapshot).find(device => device.id === pair.memberId);
  return <Dialog title={c('add')} className="device-dialog" onClose={dismiss} dirty={pair.state === "input" && !!pair.input} busy={waiting} onCancel={waiting ? cancelDevicePair : undefined} returnFocus="[data-device-pair-add]">
    <form className="device-form" onSubmit={event => { event.preventDefault(); if (!waiting && !success) void connectDevice(); }}>
      {success ? <Notice layout="inline" tone="success" title={c('paired', { name: pair.name })}>{member ? <span className="device-success-status">{`${c(member.state)} · ${c(member.path === 'lan' ? 'lan' : 'tunnelPath')}${member.latency !== null ? ` · ${member.latency} ms` : ''}`}</span> : null}</Notice> : <>
        <Field id={inputId} label={c('pairing')} error={pair.state === 'invalid' ? c('invalidHint') : undefined}>
          <Input ref={input} id={inputId} value={pair.input} placeholder={c('paste')} readOnly={waiting} aria-invalid={error || undefined} aria-describedby={error ? `${inputId}-error` : undefined} className="device-pair-input" onChange={event => devicePair.set({ state: 'input', input: event.target.value })} />
        </Field>
        {waiting ? <div className="device-waiting" role="status">{pair.error && <Notice>{pair.error}</Notice>}<p className="device-paragraph">{c('waitingHint', { member: pair.name || c('members'), controller: snapshot?.name || '' })}</p>{snapshot && <Fingerprint value={snapshot.deviceId} controller />}<p className="device-meta">{c('deadline')}</p></div>
          : pair.state === 'invalid' ? <code className="device-error-code">DEVICE_PAIRING_INVALID</code>
          : error ? <div id={`${inputId}-error`}><Notice layout="inline" title={titles[pair.state] ? c(titles[pair.state]) : undefined}><p>{titles[pair.state] ? c(`${titles[pair.state]}Hint`) : pair.error}</p>{titles[pair.state] && <code>{pair.error?.match(/DEVICE_[A-Z_]+/)?.[0]}</code>}</Notice></div>
          : <p className="device-paragraph device-muted">{c('lanOnly')}</p>}
      </>}
      <DialogActions className="device-actions"><Button variant="primary" busy={waiting} type={success ? 'button' : 'submit'} onClick={success ? dismiss : undefined}>{success ? c('done') : waiting ? c('waiting') : c('pair')}</Button></DialogActions>
    </form>
  </Dialog>;
}
function AddressDialog({ device, close }: { device: Device; close: () => void }) {
  const [value, setValue] = useState(device.addressOverride || ''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const id = useId(), input = useRef<HTMLInputElement>(null);
  const completion = useDialogCompletion(close);
  const draft = useSubmittedDirty(value, value !== (device.addressOverride || ''));
  async function save(address: string | null) {
    draft.submit(); setBusy(true); setError('');
    try { await api('device/address', 'POST', { device: device.id, address }); await refreshDevices(); await completion.finish(); }
    catch (error) { setError(String(error)); requestAnimationFrame(() => input.current?.focus()); }
    finally { setBusy(false); }
  }
  return <Dialog layerId={completion.layerId} title={c('override')} className="device-dialog" onClose={close} busy={busy} dirty={draft.dirty}>
    <form className="device-form" noValidate onSubmit={event => { event.preventDefault(); if (!value.trim()) { setError(c('overrideInvalid')); input.current?.focus(); return; } void save(value.trim()); }}>
      <Field id={id} label={device.name} error={error}><Input ref={input} id={id} value={value} aria-invalid={!!error || undefined} aria-describedby={error ? `${id}-error` : undefined} onChange={event => setValue(event.target.value)} /></Field>
      <p className="device-paragraph device-muted">{c('overrideHint')}</p><DialogActions className="device-actions"><Button disabled={busy} onClick={() => void save(null)}>{c('clear')}</Button><Button variant="primary" type="submit" busy={busy}>{c('save')}</Button></DialogActions>
    </form>
  </Dialog>;
}
function RevokeDialog({ peer, memberSide, close }: { peer: Peer; memberSide: boolean; close: () => void }) {
  const completion = useDialogCompletion(() => deviceView.set({ side: memberSide ? 'member' : 'controller' }));
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function revoke() {
    setBusy(true); setError('');
    try { await api('device/revoke', 'POST', { deviceId: peer.deviceId }); await refreshDevices(); await completion.finish(); }
    catch (error) { setError(String(error)); } finally { setBusy(false); }
  }
  return <ConfirmDialog layerId={completion.layerId} returnFocus='[data-device-add]' title={c(memberSide ? 'revokeMemberTitle' : 'revokeTitle', { name: peer.name })} className="device-dialog" onClose={close} busy={busy} actionsClassName="device-actions" confirmLabel={c('revoke')} onConfirm={revoke}>
    <div className="device-revoke-copy"><p>{c(memberSide ? 'revokeMemberEffect' : 'revokeEffect', { name: peer.name })}</p><p className="device-muted">{c('localWork')}</p></div>
    {error && <Notice layout="inline">{error}</Notice>}
  </ConfirmDialog>;
}
export default function DeviceNodePanel({ onPanelFrame }: { onPanelFrame?: (rect: import('../components/ui/layerFrame').LayerRect | null) => void } = {}) {
  const snapshot = deviceSnapshot.use(), error = deviceError.use(), view = deviceView.use();
  const devices = pairedDevices(snapshot), detail = devices.find(device => device.id === view.detail);
  const remote = deviceTasks.use();
  const selectedAgent = detail && remote[detail.id]?.snapshot?.availableAgents.find(agent => agent.agent === view.agent);
  const upstream = snapshot?.controller?.upstreamSources?.find(source => source.sourceId === view.upstreamSource);
  const controller = view.side === 'member' && view.detail === snapshot?.controller?.deviceId;
  const [busy, setBusy] = useState(false), [actionError, setActionError] = useState('');
  const close = () => deviceView.set(old => ({ ...old, dialog: undefined, revoke: undefined }));
  async function act(action: 'offer' | 'approve' | 'decline') {
    setBusy(true); setActionError('');
    try {
      const result = await api<{ pairingString?: string; expiresInSeconds: number }>(`device/${action}`, 'POST');
      if (result.pairingString) deviceOffer.set({ pairingString: result.pairingString, expiresAt: Date.now() + result.expiresInSeconds * 1000 });
      if (action !== 'offer') { deviceOffer.set(undefined); memberOutcome.set(action === 'decline' ? 'declined' : undefined); }
      else memberOutcome.set(undefined);
      await refreshDevices();
    } catch (error) { setActionError(String(error)); } finally { setBusy(false); }
  }
  async function showSources(show: boolean) {
    setBusy(true); setActionError('');
    try { await setControllerSources(show); } catch (error) { setActionError(String(error)); } finally { setBusy(false); }
  }
  return <>
    {(detail || controller || view.detail === 'pairing') && <Panel size="m" title={selectedAgent ? `${detail!.name} · ${agentName(selectedAgent)}` : upstream?.sourceLabel ?? detail?.name ?? (controller ? snapshot?.controller?.name : c('deviceLink'))}
      returnFocus={view.detail === 'pairing' ? '.hub-device-link' : undefined} className="device-node-panel" onPanelFrame={onPanelFrame} busy={busy} onClose={() => deviceView.set({ side: view.side })}>
      <div className="devices-content">{view.detail === 'pairing' && <Button data-device-pair-add variant="primary" onClick={() => deviceView.set(old => ({ ...old, dialog: 'pair' }))}><Icon icon={Plus} />{c('add')}</Button>}{detail && remote[detail.id]?.error && <Notice layout="inline">{remote[detail.id].error}</Notice>}{(error || actionError) && <Notice layout="inline">{error || actionError}</Notice>}
        {selectedAgent && detail ? <div className="device-detail"><div className="device-identity"><BrandMark markup={icons[selectedAgent.agent]} size={28} /><strong>{agentName(selectedAgent)}</strong></div>
          <p>{selectedAgent.version}</p><Button onClick={() => { deviceView.set({ side: 'controller' }); focusNodeTasks({ id: `device:${detail.id}:agent:${selectedAgent.agent}`, deviceId: detail.id, agent: selectedAgent.agent, label: `${detail.name} · ${agentName(selectedAgent)}` }); }}>{t('homepage.tasks')}</Button>
        </div> : detail ? <Detail device={detail} /> : <><Member busy={busy} act={action => void act(action)} />
          {controller && <Card className="device-setting"><SettingLine title={t('homepage.upstreamSources')}><Switch label={t('homepage.upstreamSources')} checked={snapshot?.controller?.showUpstreamSources === true} disabled={busy} onChange={show => void showSources(show)} /></SettingLine></Card>}
        </>}
      </div>
    </Panel>}
    {view.dialog === 'pair' && <PairDialog close={close} />}
    {view.dialog === 'address' && detail && <AddressDialog device={detail} close={close} />}
    {view.dialog === 'revoke' && view.revoke && <RevokeDialog peer={view.revoke} memberSide={view.side === 'member'} close={close} />}
  </>;
}
