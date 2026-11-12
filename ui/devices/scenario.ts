import { deviceOffer, devicePair, deviceSnapshot, deviceView, memberOutcome, type DeviceSnapshot, type PairState, type Peer } from './state';

export type DeviceFixture = { state: string; enabled?: boolean };
const controller: Peer = { deviceId: 'b10c'.repeat(16), name: 'Anchor Mac', addresses: [], tunnelUrl: null, addressOverride: null };
const members: Peer[] = [
  { deviceId: 'c34d'.repeat(16), name: 'Cedar Mac', addresses: ['192.168.50.21:7143', '[fd12:3456:789a::21]:7143'], tunnelUrl: 'https://cedar.example.net/arc-peer/3', addressOverride: 'cedar.local:7143' },
  { deviceId: 'd45e'.repeat(16), name: 'Quartz PC', addresses: ['192.168.50.32:7143'], tunnelUrl: 'https://quartz.example.net/arc-peer/3', addressOverride: null },
  { deviceId: 'e56f'.repeat(16), name: 'Moss Server', addresses: ['192.168.50.43:7143'], tunnelUrl: null, addressOverride: null },
];
// Synthetic, inert design content. It is never sent to a real service.
const pairingString = 'arc-device:3:' +
  'eyJ2ZXJzaW9uIjozLCJkZXZpY2VJZCI6ImMzNGRjMzRkYzM0ZGMzNGRjMzRkYzM0ZGMzNGRjMzRkYzM0ZGMzNGRjMzRkYzM0ZGMz' +
  'NGRjMzRkYzM0ZGMzNGQiLCJhZGRyZXNzZXMiOlsiMTkyLjE2OC41MC4yMTo3MTQzIl0sInR1bm5lbFVybCI6Imh0dHBzOi8vY2Vk' +
  'YXIuZXhhbXBsZS5uZXQvYXJjLXBlZXIvMyIsInNlY3JldCI6ImZpY3Rpb25hbC1vZmZlci1zZWNyZXQifQ';
const codes: Record<string, string> = { invalid: 'DEVICE_PAIRING_INVALID', expired: 'DEVICE_OFFER_EXPIRED', protocol: 'DEVICE_PROTOCOL_MISMATCH', declined: 'DEVICE_PAIRING_DECLINED', unreachable: 'DEVICE_LAN_UNAVAILABLE' };
export function deviceScenario(fixture?: DeviceFixture) {
  let snapshot: DeviceSnapshot | undefined;
  let cancelPair: ((reason: Error) => void) | undefined;
  if (fixture) {
    const state = fixture.state;
    const empty = ['empty', 'pair-input', 'member-idle', 'member-offer', 'member-pending', 'member-expired', 'member-declined', 'member-controlled', 'revoke-controller'].includes(state);
    snapshot = { deviceId: state.startsWith('member-') || state === 'revoke-controller' ? members[0].deviceId : controller.deviceId, name: state.startsWith('member-') ? members[0].name : controller.name,
      controller: state === 'member-controlled' || state === 'revoke-controller' ? controller : null,
      members: empty ? [] : structuredClone(members), pending: state === 'member-pending' ? { deviceId: controller.deviceId, name: controller.name, expiresInSeconds: 492 } : null,
      offerExpiresInSeconds: state === 'member-offer' ? 522 : null,
      devices: empty ? [] : members.map((member, index) => ({ id: member.deviceId, name: member.name, platform: ['darwin', 'windows', 'linux'][index], arch: ['arm64', 'x86_64', 'aarch64'][index], arcVersion: index === 1 ? '1.7.2' : '1.8.0',
        state: index === 2 ? 'offline' : 'online', path: index === 1 ? 'tunnel' : 'lan', lastSeen: index === 2 ? '2025-12-31T23:42:00Z' : '2026-01-01T00:00:00Z', latency: index === 2 ? null : index === 1 ? 82 : 4,
        capabilities: { tools: ['guide', 'query', 'act'], screen: index === 0, forwarding: false } })) };
    deviceSnapshot.set(structuredClone(snapshot));
    const detail = state === 'detail-windows' ? members[1].deviceId : state === 'detail-linux' ? members[2].deviceId : state === 'detail-mac' || state === 'address' || state === 'revoke-member' ? members[0].deviceId : undefined;
    deviceView.set({ side: state.startsWith('member-') || state === 'revoke-controller' ? 'member' : 'controller', detail,
      dialog: state.startsWith('pair-') ? 'pair' : state === 'address' ? 'address' : state.startsWith('revoke-') ? 'revoke' : undefined,
      revoke: state === 'revoke-controller' ? controller : state === 'revoke-member' ? members[0] : undefined });
    deviceOffer.set(state === 'member-offer' ? { pairingString, expiresAt: Date.now() + 522000 } : undefined);
    memberOutcome.set(state === 'member-expired' ? 'expired' : state === 'member-declined' ? 'declined' : undefined);
    const pairState = state.startsWith('pair-') ? state.slice(5) as PairState : 'input';
    devicePair.set({ state: pairState, input: pairState === 'input' ? '' : pairState === 'invalid' ? 'arc-device:3:fixture' : pairingString,
      name: members[0].name, memberId: members[0].deviceId, error: codes[pairState] });
  }
  return (path: string, method: string, body?: unknown): unknown => {
    if (!path.startsWith('device/') || method !== 'POST' || !snapshot) return undefined;
    const action = path.slice(7), args = body as Record<string, unknown> | undefined;
    if (action === 'cancel-pair') { cancelPair?.(new Error('DEVICE_PAIRING_CANCELLED')); cancelPair = undefined; return { cancelled: true }; }
    if (action === 'snapshot') return structuredClone(snapshot);
    if (action === 'offer') { snapshot.offerExpiresInSeconds = 600; return { pairingString, deviceId: snapshot.deviceId, expiresInSeconds: 600, protocolVersion: 3 }; }
    if (action === 'approve' || action === 'decline') { if (action === 'approve') snapshot.controller = controller; snapshot.pending = null; return { [action === 'approve' ? 'approved' : 'declined']: true, deviceId: controller.deviceId }; }
    if (action === 'revoke') { snapshot.members = snapshot.members.filter(member => member.deviceId !== args?.deviceId); snapshot.devices = snapshot.devices.filter(member => member.id !== args?.deviceId); if (snapshot.controller?.deviceId === args?.deviceId) snapshot.controller = null; return { revoked: true }; }
    if (action === 'address') {
      const member = snapshot.members.find(member => member.deviceId === args?.device);
      if (!member) throw new Error('DEVICE_UNKNOWN');
      if (args?.address !== null && !/^[\w.-]+:\d+$/.test(String(args?.address))) throw new Error('INVALID_ARGUMENT: address must be host:port');
      member.addressOverride = args?.address as string | null; return { deviceId: member.deviceId, address: member.addressOverride };
    }
    if (action === 'pair') {
      const input = String(args?.pairingString);
      if (fixture?.state === 'pair-waiting') return new Promise((_, reject) => { cancelPair = reject; });
      if (input === 'arc-device:3:fixture') throw new Error(codes.invalid);
      const failure = fixture?.state.replace('pair-', '');
      if (failure && codes[failure]) throw new Error(codes[failure]);
      if (!snapshot.members.some(member => member.deviceId === members[0].deviceId)) {
        snapshot.members.push(structuredClone(members[0]));
        snapshot.devices.push({ id: members[0].deviceId, platform: 'darwin', arch: 'arm64', arcVersion: '1.8.0', state: 'online', path: 'lan', lastSeen: new Date().toISOString(), latency: 4, capabilities: { tools: ['guide', 'query', 'act'], screen: true } });
      }
      return { paired: true, deviceId: members[0].deviceId, name: members[0].name, protocolVersion: 3 };
    }
    return undefined;
  };
}
