import type { NodeTaskState } from '../modules/topology-task-state';

export const localRunning: NodeTaskState = { running: 1, unread: 1 };
export const localAttention: NodeTaskState = { attention: 1 };
export const remoteRunning: NodeTaskState = { running: 1, attention: 1 };
export const remoteUnread: NodeTaskState = { unread: 1 };
export const deviceAggregate: NodeTaskState = { attention: 1, running: 1, unread: 1 };
export const unconfirmed: NodeTaskState = { unconfirmed: true };
export const badgeForms = [
  { name: 'running', label: 'Codex', state: { running: 1 } },
  { name: 'attention', label: 'Claude Code', state: localAttention },
  { name: 'unread', label: 'Codex', state: remoteUnread },
  { name: 'aggregate', label: 'Cedar Mac', state: deviceAggregate },
  { name: 'unconfirmed', label: 'Cedar Mac', state: unconfirmed },
];
