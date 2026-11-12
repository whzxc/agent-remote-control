import type { DeviceTopologyState, DeviceBranchForm } from '../modules/device-topology';
import type { ScenePath } from '../modules/topology-scene';

// Fictional names and inert example endpoints; never read native device state.
export const copy = {
  member: 'Cedar Mac', controller: 'Anchor Mac', merged: 'Cedar Mac · Codex',
  paired: 'Paired', online: 'Online', offline: 'Offline', lastSeen: 'Last seen 18 min ago', lastSeenNow: 'Last seen just now',
  offlineError: 'No reachable path', lastPath: 'Last path: LAN',
  address: 'LAN address', override: 'LAN address override', automatic: 'Automatic discovery',
  addressValue: '192.168.50.21:7143', overrideValue: 'cedar.local:7143',
  tunnel: 'Tunnel URL', tunnelValue: 'https://cedar.example.net/arc-peer/3',
  upstreams: 'Show upstream control sources', manage: 'Manage device', transfer: 'Transfer files',
  unpair: 'Unpair', save: 'Save', add: 'Add Agent or device', addAgent: 'Add Agent', addDevice: 'Add device',
  profile: 'Studio', accounts: '3 accounts', profiles: '2 profiles',
  board: 'Board', date: 'January 1 · Thu', time: '08:00',
};
export const states: { name: DeviceTopologyState; status: string }[] = [
  { name: 'lan', status: 'Online · LAN · 4 ms' },
  { name: 'tunnel', status: 'Online · Tunnel · 82 ms' },
  { name: 'offline', status: 'Offline · 18 min ago' },
];
export const branchForms: { name: string; state: DeviceTopologyState; form?: DeviceBranchForm; idle?: boolean }[] = [
  { name: 'device-branch-idle', state: 'lan', idle: true },
  ...states.map(({ name }) => ({ name: `device-branch-${name}`, state: name })),
  { name: 'device-branch-merged-collapsed', state: 'lan', form: 'merged-collapsed' },
  { name: 'device-branch-merged-expanded', state: 'lan', form: 'merged-expanded' },
];
export const controllerForms = [
  { name: 'controller-idle', state: 'lan', idle: true },
  { name: 'controller-overflow', state: 'lan', overflow: true },
  { name: 'controller-lan', state: 'lan' },
  { name: 'controller-tunnel', state: 'tunnel' },
  { name: 'controller-offline', state: 'offline' },
  { name: 'merged-collapsed', state: 'lan', form: 'merged-collapsed' },
  { name: 'merged-expanded', state: 'lan', form: 'merged-expanded' },
  { name: 'device-panel', state: 'lan', panel: true },
] as const;
export const memberForms = [
  { name: 'member-upstreams-off', upstreams: false },
  { name: 'member-upstreams-on', upstreams: true },
];
export const accountMembers = [
  { brand: 'codex', quota: 'ok' }, { brand: 'codex', quota: 'low' }, { brand: 'codex', quota: 'ok' },
] as const;
export const profileMembers = [{ brand: 'claude-code' }, { brand: 'claude-code' }] as const;
export const sourceNodes = [
  { x: 104, y: 148, label: 'ChatGPT', brand: 'openai' },
  { x: 104, y: 292, label: 'Claude', brand: 'claude' },
] as const;
export const landscapePaths: ScenePath[] = [
  { d: 'M168 392H267', class: 'stroke-role-source/55', 'stroke-width': '2' },
  { d: 'M393 390H456Q480 390 480 366V220Q480 196 504 196H520', class: 'stroke-role-agent/55', 'stroke-width': '2' },
  { d: 'M480 306H520 M480 366V686Q480 710 504 710H520', class: 'stroke-role-agent/55', 'stroke-width': '2' },
  { d: 'M480 456H520', class: 'stroke-role-agent/55', 'stroke-width': '2' },
];
export const memberPaths: ScenePath[] = [
  { d: 'M414 266H464Q488 266 488 290V376Q488 400 512 400H556', class: 'stroke-role-source/55', 'stroke-width': '2' },
  { d: 'M724 400H792Q816 400 816 376V266H867 M816 376V476H867', class: 'stroke-role-agent/55', 'stroke-width': '2' },
];
export const portraitForms = [
  { name: 'controller-portrait', width: 640, height: 800, rootX: 384, pan: 24 },
  { name: 'controller-portrait-idle', width: 640, height: 800, rootX: 384, pan: 24, idle: true },
  { name: 'controller-portrait-offline', width: 640, height: 800, rootX: 384, pan: 24, state: 'offline' },
  { name: 'controller-portrait-accounts', width: 640, height: 800, rootX: 384, pan: 176 },
  { name: 'controller-mobile', width: 390, height: 844, rootX: 264, pan: 0 },
  { name: 'controller-mobile-idle', width: 390, height: 844, rootX: 264, pan: 0, idle: true },
  { name: 'controller-mobile-overflow', width: 390, height: 844, rootX: 264, pan: 0, overflow: true },
  { name: 'controller-mobile-offline', width: 390, height: 844, rootX: 264, pan: 152, state: 'offline' },
  { name: 'controller-mobile-branch', width: 390, height: 844, rootX: 264, pan: 152 },
  { name: 'controller-mobile-accounts', width: 390, height: 844, rootX: 264, pan: 304 },
] as const;
