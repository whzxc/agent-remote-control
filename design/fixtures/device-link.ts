import type { PairState } from '../modules/device-link';

// Fictional identities and private addresses. The encoded secret is inert fixture data.
export const controller = {
  fingerprint: 'b10cb10cb10cb10cb10cb10cb10cb10cb10cb10cb10cb10cb10cb10cb10cb10c',
};
export const member = { name: 'Cedar Mac', latency: '4 ms', override: 'cedar.local:7143' };
export const pairingString =
  'arc-device:3:' +
  'eyJ2ZXJzaW9uIjozLCJkZXZpY2VJZCI6ImMzNGRjMzRkYzM0ZGMzNGRjMzRkYzM0ZGMzNGRjMzRkYzM0ZGMzNGRjMzRkYzM0ZGMz' +
  'NGRjMzRkYzM0ZGMzNGQiLCJhZGRyZXNzZXMiOlsiMTkyLjE2OC41MC4yMTo3MTQzIl0sInR1bm5lbFVybCI6Imh0dHBzOi8vY2Vk' +
  'YXIuZXhhbXBsZS5uZXQvYXJjLXBlZXIvMyIsInNlY3JldCI6ImZpY3Rpb25hbC1vZmZlci1zZWNyZXQifQ';
export const invalidPairingString = 'arc-device:3:fixture';
export const locales = ['en', 'zh-CN'] as const;
export type DeviceLocale = typeof locales[number];
export const pairStates: PairState[] = ['input', 'waiting', 'success', 'invalid', 'expired', 'protocol', 'declined', 'unreachable'];
const en = {
  deviceLink: 'Device link',
  add: 'Add device',
  online: 'Online', lan: 'LAN',
  pairing: 'Pairing string', paste: 'arc-device:3:…', pair: 'Connect', waiting: 'Waiting for approval',
  waitingHint: 'On Cedar Mac, approve Anchor Mac after checking its fingerprint.',
  deadline: 'Approval must finish before the offer expires.', paired: 'Cedar Mac added',
  done: 'Done', invalid: 'Invalid pairing string',
  invalidHint: 'Paste the complete pairing string from the member.', expired: 'Offer expired',
  expiredHint: 'Create a new offer on the member and paste it here.', protocol: 'Peer protocol mismatch',
  protocolHint: 'Update ARC so both devices use peer protocol 3, then create a new offer.',
  declined: 'Pairing declined', declinedHint: 'Create a new offer on the member to try again.',
  unreachable: 'Member unreachable', unreachableHint: 'Connect both devices to the same LAN and check port 7143.',
  lanOnly: 'Pair on the same LAN. The member must approve locally.',
  fingerprint: 'Identity fingerprint · SHA-256',
  override: 'LAN address override',
  clear: 'Clear override', save: 'Save',
  overrideHint: 'Use a private LAN host:port. This overrides discovery and saved addresses.',
  revoke: 'Revoke', revokeTitle: 'Revoke Cedar Mac?', revokeMemberTitle: 'Revoke Anchor Mac?',
  revokeEffect: 'This controller loses access to Cedar Mac immediately. Pair again to reconnect.',
  revokeMemberEffect: 'Anchor Mac loses access to this device immediately. Pair again to reconnect.',
  localWork: 'Work already running on the member keeps running.', cancel: 'Cancel',
  controllerFingerprint: 'Controller fingerprint · SHA-256',
};
const zh: typeof en = {
  deviceLink: '设备互联',
  add: '添加设备',
  online: '在线', lan: 'LAN',
  pairing: '配对口令', paste: 'arc-device:3:…', pair: '连接', waiting: '等待批准',
  waitingHint: '在 Cedar Mac 上核对 Anchor Mac 的指纹后批准。',
  deadline: '必须在口令到期前完成批准。', paired: '已添加 Cedar Mac',
  done: '完成', invalid: '配对口令无效', invalidHint: '请粘贴成员设备上的完整配对口令。',
  expired: '配对口令已过期', expiredHint: '请在成员设备上创建新口令，再粘贴到此处。',
  protocol: '设备协议版本不匹配', protocolHint: '更新 ARC，使两台设备均使用设备协议 3，然后创建新口令。',
  declined: '配对已拒绝', declinedHint: '如需重试，请在成员设备上创建新口令。',
  unreachable: '无法连接成员设备', unreachableHint: '请将两台设备连接到同一局域网，并检查端口 7143。',
  lanOnly: '请在同一局域网内配对，并在成员设备上批准。',
  fingerprint: '身份指纹 · SHA-256',
  override: '指定局域网地址',
  clear: '清除指定地址', save: '保存',
  overrideHint: '填写私有局域网主机:端口。此地址优先于自动发现和已保存的地址。',
  revoke: '撤销配对', revokeTitle: '撤销 Cedar Mac 的配对？', revokeMemberTitle: '撤销 Anchor Mac 的配对？',
  revokeEffect: '此控制端将立即失去对 Cedar Mac 的访问权限。重新配对后才能连接。',
  revokeMemberEffect: 'Anchor Mac 将立即失去对本机的访问权限。重新配对后才能连接。',
  localWork: '成员设备上已运行的任务会继续运行。', cancel: '取消',
  controllerFingerprint: '控制端指纹 · SHA-256',
};
export const deviceCopy = { en, 'zh-CN': zh };
export const errors = {
  invalid: { code: 'DEVICE_PAIRING_INVALID', title: 'invalid', detail: 'invalidHint' },
  expired: { code: 'DEVICE_OFFER_EXPIRED', title: 'expired', detail: 'expiredHint' },
  protocol: { code: 'DEVICE_PROTOCOL_MISMATCH', title: 'protocol', detail: 'protocolHint' },
  declined: { code: 'DEVICE_PAIRING_DECLINED', title: 'declined', detail: 'declinedHint' },
  unreachable: { code: 'DEVICE_LAN_UNAVAILABLE', title: 'unreachable', detail: 'unreachableHint' },
} as const;
