import type { TaskStep, TaskPlan, TaskChange } from '../modules/task-activity';

export const recentSteps: readonly TaskStep[] = [
  { kind: 'thinking', text: 'Check the queue ordering constraints', status: 'completed', elapsed: '12 s' },
  { kind: 'reading', text: 'Read src/queue.rs', status: 'completed', elapsed: '3 s' },
  { kind: 'editing', text: 'Update queue selection', status: 'completed', elapsed: '8 s' },
  { kind: 'command', text: 'cargo check --lib', status: 'completed', elapsed: '24 s' },
  { kind: 'reading', text: 'Review the updated queue diff', status: 'running' },
];
export const activitySamples: { steps: readonly TaskStep[]; plan: TaskPlan; change: TaskChange } = {
  steps: recentSteps,
  plan: { completed: 2, total: 4, current: 'Validate queue ordering' },
  change: { kind: 'diff', summary: 'src/queue.rs', added: 18, removed: 6, output: 'Preserve pending requests while selecting the next task.' },
};
export const activityCopy = { recent: 'Recent steps', plan: 'Plan' };
