import type { TrackedActivity, ApprovalSubmission } from '../state/activityModel.ts';
import { activityState, type TaskExecution } from '../state/taskExecutionModel.ts';
import { pendingSessions } from '../state/taskInteractions.ts';

export function nextClockTick(time: number) {
  return 60_000 - ((time % 60_000 + 60_000) % 60_000);
}
export function studioActivitySummary(activity: Record<string, readonly TrackedActivity[]>, executions: Record<string, TaskExecution>, submissions: Record<string, ApprovalSubmission>) {
  const summary = { running: 0, needsYou: 0 };
  for (const [agent, sessions] of Object.entries(activity)) for (const session of sessions) {
    const execution = executions[JSON.stringify([agent, session.id])];
    const state = activityState(session, execution, pendingSessions(agent, session, execution?.interactions ?? [], submissions).length > 0);
    if (state === 'running' || state === 'needsYou') summary[state]++;
  }
  return summary;
}
