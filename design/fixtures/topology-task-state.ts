import type { NodeTaskState } from '../modules/topology-task-state';

export const localRunning: NodeTaskState = { running: 1, unread: 1, steps: ['reading'] };
export const localAttention: NodeTaskState = { attention: 1 };
export const remoteRunning: NodeTaskState = { running: 1, attention: 1, steps: ['reading'] };
export const remoteUnread: NodeTaskState = { unread: 1 };
export const deviceAggregate: NodeTaskState = { attention: 1, running: 1, unread: 1, steps: ['reading'] };
export const unconfirmed: NodeTaskState = { unconfirmed: true };
const overflow: NodeTaskState = {
  attention: 2, running: 5, unread: 3, steps: ['reading', 'editing', 'command', 'thinking', 'waiting'],
};
export const stepCopy = {
  reading: 'Reading', editing: 'Editing', command: 'Running a command', thinking: 'Thinking', waiting: 'Waiting',
  unconfirmed: 'Unconfirmed',
};
export const pillForms = [
  { name: 'running', label: 'Codex', state: localRunning },
  { name: 'attention', label: 'Claude Code', state: localAttention },
  { name: 'unread', label: 'Codex', state: remoteUnread },
  { name: 'aggregate', label: 'Cedar Mac', state: deviceAggregate },
  { name: 'overflow', label: 'Cedar Mac', state: overflow },
  { name: 'compact-overflow', label: 'Cedar Mac', state: overflow, compact: true },
  { name: 'unconfirmed', label: 'Cedar Mac', state: unconfirmed },
  { name: 'compact-unconfirmed', label: 'Cedar Mac', state: unconfirmed, compact: true },
];
