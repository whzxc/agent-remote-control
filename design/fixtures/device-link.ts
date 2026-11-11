import type { DeviceMember, PairState, WorkspaceState } from '../modules/device-link';

// Fictional identities and private addresses. The encoded secret is inert fixture data.
export const controller = {
  name: 'Anchor Mac',
  fingerprint: 'b10cb10cb10cb10cb10cb10cb10cb10cb10cb10cb10cb10cb10cb10cb10cb10c',
};
export const members: DeviceMember[] = [
  {
    name: 'Cedar Mac', icon: 'laptop', platform: 'macOS', arch: 'arm64', version: '1.8.0',
    fingerprint: 'c34dc34dc34dc34dc34dc34dc34dc34dc34dc34dc34dc34dc34dc34dc34dc34d',
    state: 'online', path: 'lan', latency: '4 ms', seen: 'now', screen: true,
    addresses: ['192.168.50.21:7143', '[fd12:3456:789a::21]:7143'],
    tunnel: 'https://cedar.example.net/arc-peer/3', override: 'cedar.local:7143',
  },
  {
    name: 'Quartz PC', icon: 'monitor', platform: 'Windows', arch: 'x86_64', version: '1.7.2',
    fingerprint: 'd45ed45ed45ed45ed45ed45ed45ed45ed45ed45ed45ed45ed45ed45ed45ed45e',
    state: 'online', path: 'tunnel', latency: '82 ms', seen: 'now', screen: false,
    addresses: ['192.168.50.32:7143'], tunnel: 'https://quartz.example.net/arc-peer/3',
  },
  {
    name: 'Moss Server', icon: 'server', platform: 'Linux', arch: 'aarch64', version: '1.8.0',
    fingerprint: 'e56fe56fe56fe56fe56fe56fe56fe56fe56fe56fe56fe56fe56fe56fe56fe56f',
    state: 'offline', path: 'lan', latency: null, seen: 'ago', screen: false,
    addresses: ['192.168.50.43:7143'], tunnel: null,
  },
];
export const pairingString =
  'arc-device:3:' +
  'eyJ2ZXJzaW9uIjozLCJkZXZpY2VJZCI6ImMzNGRjMzRkYzM0ZGMzNGRjMzRkYzM0ZGMzNGRjMzRkYzM0ZGMzNGRjMzRkYzM0ZGMz' +
  'NGRjMzRkYzM0ZGMzNGQiLCJhZGRyZXNzZXMiOlsiMTkyLjE2OC41MC4yMTo3MTQzIl0sInR1bm5lbFVybCI6Imh0dHBzOi8vY2Vk' +
  'YXIuZXhhbXBsZS5uZXQvYXJjLXBlZXIvMyIsInNlY3JldCI6ImZpY3Rpb25hbC1vZmZlci1zZWNyZXQifQ';
export const invalidPairingString = 'arc-device:3:fixture';
export const locales = ['en', 'zh-CN'] as const;
export type DeviceLocale = typeof locales[number];
export const pairStates: PairState[] = ['input', 'waiting', 'success', 'invalid', 'expired', 'protocol', 'declined', 'unreachable'];
export const workspaceStates: WorkspaceState[] = [
  'controller', 'empty', 'detail-mac', 'detail-windows', 'detail-linux',
  'member-idle', 'member-offer', 'member-pending', 'member-controlled', 'member-expired', 'member-declined',
];
const en = {
  devices: 'Devices', deviceLink: 'Device link', experimental: 'Settings / Experimental',
  settings: 'Settings', agents: 'Agents', permissions: 'Permissions', expand: 'Expand', back: 'Back',
  add: 'Add device', members: 'Members', thisDevice: 'This device', view: 'Device view',
  online: 'Online', offline: 'Offline', lan: 'LAN', tunnelPath: 'Tunnel', now: 'just now', ago: '18 min ago', lastSeen: 'Last seen',
  lastPath: 'Last path', empty: 'No members yet', emptyHint: 'Create an offer on the member, then add it here.',
  pairing: 'Pairing string', paste: 'arc-device:3:…', pair: 'Connect', waiting: 'Waiting for approval',
  waitingHint: 'On Cedar Mac, approve Anchor Mac after checking its fingerprint.',
  deadline: 'Approval must finish before the offer expires.', paired: 'Cedar Mac added',
  done: 'Done', open: 'Open device', invalid: 'Invalid pairing string',
  invalidHint: 'Paste the complete pairing string from the member.', expired: 'Offer expired',
  expiredHint: 'Create a new offer on the member and paste it here.', protocol: 'Peer protocol mismatch',
  protocolHint: 'Update ARC so both devices use peer protocol 3, then create a new offer.',
  declined: 'Pairing declined', declinedHint: 'Create a new offer on the member to try again.',
  unreachable: 'Member unreachable', unreachableHint: 'Connect both devices to the same LAN and check port 7143.',
  lanOnly: 'Pair on the same LAN. The member must approve locally.',
  fingerprint: 'Identity fingerprint · SHA-256', platform: 'Platform', version: 'ARC version',
  addresses: 'LAN addresses', tunnel: 'Tunnel URL', none: 'Unavailable', override: 'LAN address override',
  automatic: 'Automatic discovery', edit: 'Edit', clear: 'Clear override', save: 'Save',
  overrideHint: 'Use a private LAN host:port. This overrides discovery and saved addresses.',
  overrideInvalid: 'Enter a private LAN host and port, such as cedar.local:7143.',
  capabilities: 'Capabilities', command: 'Command', files: 'Files', tasks: 'Agents & tasks', screen: 'Screen',
  noScreen: 'Screen unavailable', tunnelNotice: 'The tunnel provider can read request and response content.',
  offlineHint: 'Offline. Existing work keeps running; new requests are unavailable until this device returns.',
  revoke: 'Revoke', revokeTitle: 'Revoke Cedar Mac?', revokeMemberTitle: 'Revoke Anchor Mac?',
  revokeEffect: 'This controller loses access to Cedar Mac immediately. Pair again to reconnect.',
  revokeMemberEffect: 'Anchor Mac loses access to this device immediately. Pair again to reconnect.',
  localWork: 'Work already running on the member keeps running.', cancel: 'Cancel',
  controlledBy: 'Controlled by', unpaired: 'No controller', createOffer: 'Create offer',
  oneController: 'This device accepts one controller.', offerExpiry: 'Expires in 08:42 · one use',
  offerExpired: 'This offer expired. Create a new offer to pair.', offerDeclined: 'Request declined. Create a new offer to pair.',
  offerHint: 'Paste this string into Add device on the controller. It contains a one-time secret.',
  copy: 'Copy pairing string', pending: 'Approve controller?', approve: 'Approve', decline: 'Decline',
  fullAuthority: 'Approval grants full host authority, including commands and files.',
  compare: 'Compare this fingerprint with Anchor Mac before approving.',
  controllerFingerprint: 'Controller fingerprint · SHA-256', offerDeadline: 'Offer expires in 08:12',
  currentAuthority: 'This controller has full host authority on this device.',
  topologySummary: '3 devices · 2 online', topologyTitle: 'Members', board: 'Board', date: 'January 1 · Thu',
  addConnection: 'Add connection',
};
const zh: typeof en = {
  devices: '设备', deviceLink: '设备互联', experimental: '设置 / 实验性功能',
  settings: '设置', agents: 'Agent', permissions: '权限', expand: '展开', back: '返回',
  add: '添加设备', members: '成员设备', thisDevice: '本机', view: '设备视图',
  online: '在线', offline: '离线', lan: 'LAN', tunnelPath: '隧道', now: '刚刚', ago: '18 分钟前', lastSeen: '最后在线',
  lastPath: '上次路径', empty: '还没有成员设备', emptyHint: '先在成员设备上创建配对口令，再到此处添加。',
  pairing: '配对口令', paste: 'arc-device:3:…', pair: '连接', waiting: '等待批准',
  waitingHint: '在 Cedar Mac 上核对 Anchor Mac 的指纹后批准。',
  deadline: '必须在口令到期前完成批准。', paired: '已添加 Cedar Mac',
  done: '完成', open: '打开设备', invalid: '配对口令无效', invalidHint: '请粘贴成员设备上的完整配对口令。',
  expired: '配对口令已过期', expiredHint: '请在成员设备上创建新口令，再粘贴到此处。',
  protocol: '设备协议版本不匹配', protocolHint: '更新 ARC，使两台设备均使用设备协议 3，然后创建新口令。',
  declined: '配对已拒绝', declinedHint: '如需重试，请在成员设备上创建新口令。',
  unreachable: '无法连接成员设备', unreachableHint: '请将两台设备连接到同一局域网，并检查端口 7143。',
  lanOnly: '请在同一局域网内配对，并在成员设备上批准。',
  fingerprint: '身份指纹 · SHA-256', platform: '平台', version: 'ARC 版本', addresses: '局域网地址',
  tunnel: '隧道 URL', none: '不可用', override: '指定局域网地址', automatic: '自动发现',
  edit: '编辑', clear: '清除指定地址', save: '保存',
  overrideHint: '填写私有局域网主机:端口。此地址优先于自动发现和已保存的地址。',
  overrideInvalid: '请填写私有局域网主机和端口，例如 cedar.local:7143。',
  capabilities: '能力', command: '命令', files: '文件', tasks: 'Agent 与任务', screen: '屏幕',
  noScreen: '不支持屏幕', tunnelNotice: '隧道提供方可以读取请求和响应内容。',
  offlineHint: '设备离线。已有任务继续运行；设备恢复在线后才能发送新请求。',
  revoke: '撤销配对', revokeTitle: '撤销 Cedar Mac 的配对？', revokeMemberTitle: '撤销 Anchor Mac 的配对？',
  revokeEffect: '此控制端将立即失去对 Cedar Mac 的访问权限。重新配对后才能连接。',
  revokeMemberEffect: 'Anchor Mac 将立即失去对本机的访问权限。重新配对后才能连接。',
  localWork: '成员设备上已运行的任务会继续运行。', cancel: '取消',
  controlledBy: '受控于', unpaired: '尚未配对控制端', createOffer: '创建配对口令',
  oneController: '本机最多接受一个控制端。', offerExpiry: '08:42 后过期 · 仅限一次',
  offerExpired: '口令已过期。请创建新口令以配对。', offerDeclined: '已拒绝请求。请创建新口令以配对。',
  offerHint: '将口令粘贴到控制端的“添加设备”。口令包含一次性密钥。', copy: '复制配对口令',
  pending: '批准控制端？', approve: '批准', decline: '拒绝',
  fullAuthority: '批准后将授予完整主机权限，包括执行命令和访问文件。',
  compare: '批准前，请与 Anchor Mac 上的指纹进行核对。',
  controllerFingerprint: '控制端指纹 · SHA-256', offerDeadline: '口令将在 08:12 后过期',
  currentAuthority: '此控制端拥有本机的完整主机权限。',
  topologySummary: '3 台设备 · 2 台在线', topologyTitle: '成员设备', board: '看板', date: '1 月 1 日 · 周四',
  addConnection: '添加连接',
};
export const deviceCopy = { en, 'zh-CN': zh };
export const errors = {
  invalid: { code: 'DEVICE_PAIRING_INVALID', title: 'invalid', detail: 'invalidHint' },
  expired: { code: 'DEVICE_OFFER_EXPIRED', title: 'expired', detail: 'expiredHint' },
  protocol: { code: 'DEVICE_PROTOCOL_MISMATCH', title: 'protocol', detail: 'protocolHint' },
  declined: { code: 'DEVICE_PAIRING_DECLINED', title: 'declined', detail: 'declinedHint' },
  unreachable: { code: 'DEVICE_LAN_UNAVAILABLE', title: 'unreachable', detail: 'unreachableHint' },
} as const;
export const topologyOptions = ['summary'] as const;
export const topologyPlacement = { summary: { x: 520, y: 540 } };
