import { Frame, Icon } from 'adg';
import { recentSteps } from '../fixtures/task-activity';

export type TaskStepKind = 'reading' | 'editing' | 'command' | 'thinking' | 'waiting';
export type TaskStep = { kind: TaskStepKind; text: string; status: 'completed' | 'running' | 'pending'; elapsed?: string };
export type TaskPlan = { completed: number; total: number; current: string };
export type TaskChange = { kind: 'file' | 'diff' | 'command'; summary: string; added?: number; removed?: number; output?: string };
const icons: Record<TaskStepKind, string> = {
  reading: 'file-search', editing: 'file-pen-line', command: 'terminal', thinking: 'brain', waiting: 'clock-3',
};
export function TaskActivityIcon({ kind, size = 14 }: { kind: TaskStepKind; size?: number }) {
  return <Icon name={icons[kind]} size={size} />;
}
export default () => (
  <Frame name="task-activity-icons">
    <div class="flex items-center gap-3">
      {[...new Set(recentSteps.map(step => step.kind)), 'waiting' as const].map(kind => <TaskActivityIcon kind={kind} />)}
    </div>
  </Frame>
);
