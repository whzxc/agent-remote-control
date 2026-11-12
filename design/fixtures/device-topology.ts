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
export const branchForms: { name: string; state: DeviceTopologyState; form?: DeviceBranchForm }[] = [
  ...states.map(({ name }) => ({ name: `device-branch-${name}`, state: name })),
  { name: 'device-branch-merged-collapsed', state: 'lan', form: 'merged-collapsed' },
  { name: 'device-branch-merged-expanded', state: 'lan', form: 'merged-expanded' },
];
export const controllerForms = [
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
export const tasks = [
  { title: 'Inspect the queue', phase: 'Reading', headline: 'Queue state', sourceBrand: 'openai' },
  { title: 'Review the change', phase: 'Thinking', headline: 'Reviewing diff', sourceBrand: 'claude' },
] as const;
export const accountMembers = [
  { brand: 'codex', quota: 'ok' }, { brand: 'codex', quota: 'low' }, { brand: 'codex', quota: 'ok' },
] as const;
export const profileMembers = [{ brand: 'claude-code' }, { brand: 'claude-code' }] as const;
export const sourceNodes = [
  { x: 104, y: 148, label: 'ChatGPT', brand: 'openai' },
  { x: 104, y: 292, label: 'Claude', brand: 'claude' },
] as const;
export const landscapePaths: ScenePath[] = [
  { d: 'M187 390H359', class: 'stroke-role-source/55', 'stroke-width': '2' },
  { d: 'M485 390H604Q628 390 628 366V194H691', class: 'stroke-role-agent/55', 'stroke-width': '2' },
  { d: 'M628 304H691 M628 366V686Q628 710 604 710H592', class: 'stroke-role-agent/55', 'stroke-width': '2' },
  { d: 'M628 464H691', class: 'stroke-role-agent/55', 'stroke-width': '2' },
];
export const memberPaths: ScenePath[] = [
  { d: 'M414 264H464Q488 264 488 288V376Q488 400 512 400H556', class: 'stroke-role-source/55', 'stroke-width': '2' },
  { d: 'M414 264H430V428H384', class: 'stroke-role-source/55', 'stroke-width': '2' },
  { d: 'M724 400H792Q816 400 816 376V264H860 M816 376V474H860', class: 'stroke-role-agent/55', 'stroke-width': '2' },
];
export const upstreamPaths: ScenePath[] = [
  { d: 'M183 172H260Q284 172 284 196V240Q284 264 308 264H366', class: 'stroke-role-source/55', 'stroke-width': '2' },
  { d: 'M183 316H260Q284 316 284 292V264', class: 'stroke-role-source/55', 'stroke-width': '2' },
];
export const portraitForms = [
  { name: 'controller-portrait', width: 640, height: 800, narrow: false },
  { name: 'controller-mobile', width: 390, height: 844, narrow: true },
];
