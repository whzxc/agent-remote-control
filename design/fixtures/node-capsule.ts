import type { NodeTaskState } from '../modules/node-capsule';
import type { AgentIconReading } from '../components/agent-icon';

export const quotaReadings: readonly AgentIconReading[] = [
  { id: 'quota', label: 'Session quota', value: 72, color: 'var(--success)', elapsed: 0.4 },
];
export const localRunning: NodeTaskState = { running: 1, unread: 1, steps: ['reading'] };
export const localAttention: NodeTaskState = { attention: 1 };
export const remoteRunning: NodeTaskState = { running: 1, attention: 1, steps: ['reading'] };
export const remoteUnread: NodeTaskState = { unread: 1 };
export const deviceAggregate: NodeTaskState = { attention: 1, running: 1, unread: 1, steps: ['reading'] };
export const unconfirmed: NodeTaskState = { unconfirmed: true };
export const overflow: NodeTaskState = {
  attention: 112, running: 125, unread: 3, steps: ['reading', 'editing', 'command', 'thinking', 'waiting'],
};
export const overflowAggregate: NodeTaskState = { ...overflow, attention: 224, running: 250, unread: 6 };
const thinkingWaiting: NodeTaskState = { running: 2, steps: ['thinking', 'waiting'], unread: 1 };
export const stepCopy = {
  reading: 'Reading', editing: 'Editing', command: 'Running a command', thinking: 'Thinking', waiting: 'Waiting',
  unconfirmed: 'Unconfirmed',
};
export const capsuleForms: { name: string; state: NodeTaskState; compact?: boolean; wing?: 'left' | 'right' }[] = [
  { name: 'idle', state: {} },
  { name: 'working', state: localRunning },
  { name: 'attention', state: localAttention },
  { name: 'unread', state: remoteUnread },
  { name: 'aggregate', state: deviceAggregate },
  { name: 'thinking-waiting', state: thinkingWaiting },
  { name: 'overflow', state: overflow },
  { name: 'left-idle', state: {}, wing: 'left' },
  { name: 'left-working', state: deviceAggregate, wing: 'left' },
  { name: 'compact', state: deviceAggregate, compact: true },
  { name: 'compact-overflow', state: overflow, compact: true },
  { name: 'unconfirmed', state: unconfirmed },
  { name: 'compact-unconfirmed', state: unconfirmed, compact: true },
];
export const accountContrast = {
  label: '3 accounts', members: [{ brand: 'codex', quota: 'ok' }, { brand: 'codex', quota: 'low' }, { brand: 'codex', quota: 'ok' }],
} as const;
