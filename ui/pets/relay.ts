import type { TaskState } from '../state/taskProjection.ts';
export const STALL_MS = 90_000;
export const IDLE_MS = 60_000;
export const RETURN_MS = 2_000;
export const SPEECH_MS = 30_000;
export interface RelayTask {
  key: string; taskId: string; agent: string; sourceId?: string; accountId?: string | null;
  turn: string; dispatchId?: string; state: TaskState; phaseSince?: number; at: number;
  review?: { id: string; verdict: 'pass' | 'rework' };
}
export type IntentKind = 'dispatch' | 'carry' | 'urge' | 'return' | 'praise' | 'rework';
export interface PetIntent { id: string; kind: IntentKind; task: RelayTask; at: number }
export function taskPetRow(state: TaskState): number {
  return { running: 7, needsYou: 6, done: 0, failed: 5, interrupted: 5, unknown: 8 }[state];
}
export function stalled(task: RelayTask, now: number) {
  return task.state === 'running' && Number.isFinite(task.phaseSince) && now - task.phaseSince! >= STALL_MS;
}
export function petIntents(task: RelayTask, before: RelayTask | undefined, now: number): PetIntent[] {
  const intents: PetIntent[] = [];
  const add = (kind: IntentKind, identity: string) => intents.push({ id: JSON.stringify([task.key, kind, identity]), kind, task, at: now });
  const newTurn = !before || before.turn !== task.turn;
  const dispatched = !!task.dispatchId && before?.dispatchId !== task.dispatchId;
  if (dispatched && task.sourceId && !['done', 'failed', 'interrupted'].includes(task.state)) add('dispatch', task.dispatchId!);
  else if (task.state === 'running' && (newTurn || before?.state !== 'running')) add('carry', task.turn);
  if (['done', 'failed', 'interrupted'].includes(task.state) && (newTurn || before?.state !== task.state)) add('return', `${task.turn}:${task.state}`);
  if (stalled(task, now)) add('urge', `${task.turn}:${task.phaseSince}`);
  if (task.review && before?.review?.id !== task.review.id && task.sourceId) add(task.review.verdict === 'pass' ? 'praise' : 'rework', task.review.id);
  return intents;
}
export interface RelayPose {
  sourceRow: number; agentRow: number; taskRow: number; sourceAtAgent: boolean; taskAtAgent: boolean;
  card?: { from: 'source' | 'agent' | 'task'; to: 'source' | 'agent'; progress: number; tone: 'neutral' | 'success' | 'danger' };
  speech?: 'hurry' | 'wellDone'; finished: boolean;
}
export function relayPose(intent: PetIntent, now: number): RelayPose {
  const elapsed = Math.max(0, now - intent.at);
  const pose: RelayPose = { sourceRow: 0, agentRow: 0, taskRow: taskPetRow(intent.task.state), sourceAtAgent: false, taskAtAgent: false, finished: elapsed >= 4000 };
  if (pose.finished) return pose;
  switch (intent.kind) {
    case 'dispatch': case 'rework':
      pose.sourceRow = elapsed < 900 ? 3 : 0; pose.agentRow = elapsed >= 650 && elapsed < 1300 ? 4 : 0;
      pose.taskAtAgent = elapsed < 1300;
      if (elapsed < 900) pose.card = { from: 'source', to: 'agent', progress: elapsed / 900, tone: 'neutral' };
      break;
    case 'carry': pose.taskAtAgent = elapsed < 150; break;
    case 'urge': pose.sourceAtAgent = elapsed < 2500; pose.sourceRow = elapsed < 1000 ? 1 : 3; if (elapsed >= 1000 && elapsed < 2500) pose.speech = 'hurry'; break;
    case 'return':
      pose.taskAtAgent = elapsed < 2100;
      pose.agentRow = intent.task.state === 'done' ? elapsed < 800 ? 0 : 3 : 5;
      pose.sourceRow = elapsed >= 1700 ? intent.task.state === 'done' ? 4 : 5 : 0;
      if (elapsed < 800) pose.card = { from: 'task', to: 'agent', progress: elapsed / 800, tone: intent.task.state === 'done' ? 'success' : 'danger' };
      else if (elapsed < 1700) pose.card = { from: 'agent', to: 'source', progress: (elapsed - 800) / 900, tone: intent.task.state === 'done' ? 'success' : 'danger' };
      break;
    case 'praise': pose.sourceRow = 4; pose.speech = 'wellDone'; break;
  }
  return pose;
}
export function arcPoint(from: { x: number; y: number }, to: { x: number; y: number }, progress: number) {
  const p = Math.max(0, Math.min(1, progress));
  return { x: from.x + (to.x - from.x) * p, y: from.y + (to.y - from.y) * p - Math.min(100, Math.hypot(to.x - from.x, to.y - from.y) / 3) * 4 * p * (1 - p) };
}
export function presentPet(lastEngaged: number, resident: boolean, now: number) {
  return { present: resident || now - lastEngaged < IDLE_MS + RETURN_MS, returning: !resident && now - lastEngaged >= IDLE_MS };
}
export function maySpeak(lastSpoken: number | undefined, now: number) { return lastSpoken === undefined || now - lastSpoken >= SPEECH_MS; }
