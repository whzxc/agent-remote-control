import { api } from '../api';
import { createStore, preference } from '../state/store';
import { notify } from '../state/connector';
import { t } from '../i18n';

export const deviceLinkEnabled = preference('device-link', false, value => value === 'on', value => value ? 'on' : 'off');
export type Peer = { deviceId: string; name: string; addresses: string[]; tunnelUrl: string | null; addressOverride: string | null };
export type Device = Peer & { id: string; platform: string | null; arch: string | null; arcVersion: string | null; state: 'online' | 'offline'; path: 'lan' | 'tunnel'; latency: number | null; lastSeen: string | null; capabilities: { tools: string[]; screen: boolean; forwarding?: boolean } | null };
export type DeviceSnapshot = {
  deviceId: string; name: string; controller: Peer | null; members: Peer[];
  pending: { deviceId: string; name: string; expiresInSeconds: number } | null;
  offerExpiresInSeconds: number | null; devices: Omit<Device, keyof Peer>[];
};
export type PairState = 'input' | 'waiting' | 'success' | 'invalid' | 'expired' | 'protocol' | 'declined' | 'unreachable' | 'error';
export const deviceSnapshot = createStore<DeviceSnapshot | undefined>(undefined);
export const deviceError = createStore('');
export const deviceView = createStore<{ side: 'controller' | 'member'; detail?: string; dialog?: 'pair' | 'address' | 'revoke'; revoke?: Peer }>({ side: 'controller' });
export const deviceOffer = createStore<{ pairingString: string; expiresAt: number } | undefined>(undefined);
export const memberOutcome = createStore<'expired' | 'declined' | undefined>(undefined);
export const devicePair = createStore<{ state: PairState; input: string; name?: string; memberId?: string; error?: string }>({ state: 'input', input: '' });

export function pairedDevices(snapshot = deviceSnapshot.get()): Device[] {
  return snapshot?.members.map(peer => ({ id: peer.deviceId, platform: null, arch: null, arcVersion: null,
    state: 'offline', path: 'lan', latency: null, lastSeen: null, capabilities: null,
    ...snapshot.devices.find(device => device.id === peer.deviceId), ...peer })) ?? [];
}
let read: Promise<void> | undefined;
export function refreshDevices(): Promise<void> {
  if (!deviceLinkEnabled.get()) return Promise.resolve();
  return read ??= api<DeviceSnapshot>('device/snapshot', 'POST').then(snapshot => {
    if (deviceLinkEnabled.get()) { deviceSnapshot.set(snapshot); deviceError.set(''); }
  }).catch(error => { if (deviceLinkEnabled.get()) deviceError.set(String(error)); }).finally(() => { read = undefined; });
}
export function observeDevices() {
  let timer: ReturnType<typeof setInterval> | undefined;
  const update = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
    if (deviceLinkEnabled.get()) {
      void refreshDevices();
      timer = setInterval(() => { if (document.visibilityState === 'visible') void refreshDevices(); }, 2000);
    } else {
      deviceSnapshot.set(undefined); deviceError.set(''); deviceOffer.set(undefined); memberOutcome.set(undefined);
      deviceView.set({ side: 'controller' }); devicePair.set({ state: 'input', input: '' });
    }
  };
  const visible = () => { if (document.visibilityState === 'visible') void refreshDevices(); };
  update();
  const stop = deviceLinkEnabled.subscribe(update);
  document.addEventListener('visibilitychange', visible);
  return () => { stop(); if (timer) clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
}
let pairAttempt = 0;
export async function connectDevice() {
  const attempt = ++pairAttempt;
  const input = devicePair.get().input.trim();
  devicePair.set({ state: 'waiting', input });
  try {
    const result = await api<{ deviceId: string; name: string }>('device/pair', 'POST', { pairingString: input });
    if (!deviceLinkEnabled.get() || attempt !== pairAttempt) return;
    if (deviceView.get().dialog !== 'pair') notify(t('device.paired', { name: result.name }));
    devicePair.set({ state: 'success', input, name: result.name, memberId: result.deviceId });
    await refreshDevices();
  } catch (error) {
    if (!deviceLinkEnabled.get()) return;
    const text = String(error);
    if (deviceView.get().dialog !== 'pair') notify(text, true);
    const state: PairState = text.includes('DEVICE_PAIRING_INVALID') ? 'invalid' : text.includes('DEVICE_OFFER_EXPIRED') ? 'expired'
      : text.includes('DEVICE_PROTOCOL_MISMATCH') ? 'protocol' : text.includes('DEVICE_PAIRING_DECLINED') ? 'declined'
      : /DEVICE_(LAN_UNAVAILABLE|CONNECTION_REFUSED|TLS_FAILED)/.test(text) ? 'unreachable' : 'error';
    devicePair.set({ state, input, error: text });
  }
}

export async function cancelDevicePair() {
  try {
    await api('device/cancel-pair', 'POST');
    pairAttempt++;
    devicePair.set({ state: 'input', input: '' });
    return true;
  } catch (error) {
    devicePair.set(old => ({ ...old, error: String(error) }));
    return false;
  }
}
