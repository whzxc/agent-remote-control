import type { PetAction } from './behavior.ts';
import type { TaskState } from '../state/taskProjection.ts';
export const RELAY_MS = 6_000;
export const RELAY_READY_MS = 5_000;
export const RELAY_CUES = [0, 350, 1100, 1500, 2200, 2450, 3000, RELAY_MS] as const;
export const STALL_MS = 90_000;
export const IDLE_MS = 60_000;
export const RETURN_MS = 2_000;
export const SPEECH_MS = 30_000;
export interface RelayTask {
  key: string; taskId: string; agent: string; sourceId?: string; accountId?: string | null;
  turn: string; title?: string; dispatchId?: string; state: TaskState; phaseSince?: number; at: number;
  review?: { id: string; verdict: 'pass' | 'rework'; baseline?: boolean };
}
export type IntentKind = 'dispatch' | 'carry' | 'urge' | 'return' | 'praise' | 'rework';
export interface PetIntent { id: string; kind: IntentKind; task: RelayTask; at: number }
export function visiblePetIntent(event: PetIntent, sources: ReadonlySet<string>): PetIntent | undefined {
  if (event.task.sourceId && sources.has(event.task.sourceId)) return event;
  if (['urge', 'praise', 'rework'].includes(event.kind)) return undefined;
  // Presentation may omit an unavailable source, but recorded origin evidence
  // and the event identity remain unchanged.
  return { ...event, kind: event.kind === 'dispatch' ? 'carry' : event.kind, task: { ...event.task, sourceId: undefined } };
}
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
  if (before && ['done', 'failed', 'interrupted'].includes(task.state) && (newTurn || before.state !== task.state)) add('return', `${task.turn}:${task.state}`);
  if (task.sourceId && stalled(task, now)) add('urge', `${task.turn}:${task.phaseSince}`);
  if (before && task.review && !task.review.baseline && before.review?.id !== task.review.id && task.sourceId) add(task.review.verdict === 'pass' ? 'praise' : 'rework', task.review.id);
  return intents;
}
export interface RelayPose {
  sourceRow: number; agentRow: number; taskRow: number; taskAtAgent: boolean;
  sourceAction: PetAction; agentAction: PetAction; taskAction: PetAction;
  holding?: 'source' | 'agent' | 'task';
  card?: { from: 'source' | 'agent' | 'task'; to: 'source' | 'agent' | 'task'; progress: number; tone: 'neutral' | 'success' | 'danger' };
  speech?: 'hurry' | 'wellDone'; finished: boolean;
}
export function relayPose(intent: PetIntent, now: number): RelayPose {
  const elapsed = Math.max(0, now - intent.at);
  const pose: RelayPose = { sourceRow: 0, agentRow: 0, taskRow: taskPetRow(intent.task.state), taskAtAgent: false,
    sourceAction: 'idle', agentAction: 'idle', taskAction: 'work', finished: elapsed >= RELAY_MS };
  if (pose.finished) return pose;
  const flight = (from: 'source' | 'agent' | 'task', to: 'source' | 'agent' | 'task', start: number, end: number, tone: 'neutral' | 'success' | 'danger' = 'neutral') => {
    if (elapsed >= start && elapsed < end) pose.card = { from, to, progress: (elapsed - start) / (end - start), tone };
  };
  switch (intent.kind) {
    case 'dispatch': case 'rework':
      pose.sourceRow = elapsed < 1100 ? 3 : 0; pose.agentRow = elapsed < 2200 ? 3 : 0;
      pose.sourceAction = elapsed < 1100 ? 'give' : 'idle';
      pose.agentAction = elapsed < 1500 ? 'catch' : elapsed < 2200 ? 'give' : 'idle';
      pose.taskAction = elapsed < 2200 ? 'catch' : 'carry';
      pose.taskAtAgent = elapsed < 2200;
      pose.holding = elapsed < 350 ? 'source' : elapsed >= 1100 && elapsed < 1500 ? 'agent' : elapsed >= 2200 ? 'task' : undefined;
      flight('source', 'agent', 350, 1100);
      flight('agent', 'task', 1500, 2200);
      break;
    case 'carry': pose.taskAtAgent = elapsed < 350; pose.holding = 'task'; pose.taskAction = 'carry'; break;
    case 'urge': pose.sourceRow = 3; pose.sourceAction = 'give'; pose.holding = 'task'; if (elapsed >= 350 && elapsed < 2450) pose.speech = 'hurry'; break;
    case 'return': {
      const success = intent.task.state === 'done', tone = success ? 'success' : 'danger';
      pose.taskAction = elapsed < 1100 ? 'give' : success ? 'idle' : 'tired';
      pose.agentAction = elapsed < 1500 ? 'catch' : elapsed < 2450 ? 'give' : success ? 'celebrate' : 'tired';
      pose.sourceAction = elapsed < 2450 ? 'catch' : 'think';
      pose.agentRow = success ? elapsed < 2450 ? 3 : 4 : 5;
      pose.sourceRow = elapsed >= 2450 ? 8 : 3;
      pose.holding = elapsed < 350 ? 'task' : elapsed >= 1100 && elapsed < 1500 ? 'agent' : elapsed >= 2450 ? 'source' : undefined;
      flight('task', 'agent', 350, 1100, tone);
      // Native work has no invented source: its executor receives the result.
      if (intent.task.sourceId) flight('agent', 'source', 1500, 2450, tone);
      else if (elapsed >= 1100) { pose.holding = 'agent'; pose.agentAction = success ? 'celebrate' : 'tired'; }
      break;
    }
    case 'praise': pose.sourceRow = 4; pose.sourceAction = 'celebrate'; pose.agentAction = 'celebrate'; pose.holding = 'source'; pose.speech = 'wellDone'; break;
  }
  return pose;
}
// One choreography channel keeps each card attributable even when many tasks
// finish together. A quick result follows its dispatch instead of erasing it.
export function queuePetIntent(current: readonly PetIntent[], event: PetIntent, now: number): PetIntent[] {
  let queue = current.filter(item => item.at + RELAY_MS > now && (item.task.key !== event.task.key || item.task.turn === event.task.turn));
  if (queue.some(item => item.id === event.id)) return queue;
  if (event.kind === 'carry' && queue.some(item => item.task.key === event.task.key && ['dispatch', 'rework', 'carry'].includes(item.kind))) return queue;
  if (event.kind === 'urge' && queue.some(item => item.task.key === event.task.key)) return queue;
  if (event.kind === 'return') queue = queue.filter(item => item.task.key !== event.task.key || !['urge', 'carry'].includes(item.kind));
  const at = Math.max(now, ...queue.map(item => item.at + RELAY_MS));
  return [...queue, { ...event, at }];
}
export function retainPetIntents(current: readonly PetIntent[], visibleTurns: ReadonlyMap<string, string>, now: number): PetIntent[] {
  return current.filter(event => event.at + RELAY_MS > now && visibleTurns.get(event.task.key) === event.task.turn);
}
export interface RelayClock { head: string; at: number; waitingSince?: number }
export function stepRelayQueue(current: readonly PetIntent[], clock: RelayClock | undefined, now: number, ready: (event: PetIntent) => boolean): { events: PetIntent[]; clock?: RelayClock } {
  let events = [...current];
  const shift = (delay: number) => { if (delay) events = events.map(event => ({ ...event, at: event.at + delay })); };
  const previousHead = clock?.head;
  if (clock && !events.some(event => event.id === previousHead)) {
    shift(-Math.max(0, (events[0]?.at ?? now) - now)); clock = undefined;
  }
  if (clock?.waitingSince !== undefined) shift(Math.max(0, now - clock.at));
  events = events.filter(event => event.at + RELAY_MS > now);
  let head = events.find(event => event.at <= now);
  if (!head) return { events };
  if (head.id !== clock?.head) {
    // A newly visible episode starts when its actors can first be inspected,
    // rather than skipping its first poses during a delayed browser frame.
    shift(now - head.at); head = events[0]; clock = { head: head.id, at: now };
  }
  const canPlay = ready(head);
  if (!canPlay && clock?.waitingSince !== undefined && now - clock.waitingSince >= RELAY_READY_MS) {
    // A collapsed or crowded scene may never provide safe real anchors. Drop
    // this task's decoration and let another task use the channel.
    events = events.filter(event => event.task.key !== head.task.key || event.task.turn !== head.task.turn);
    shift(-Math.max(0, (events[0]?.at ?? now) - now));
    return stepRelayQueue(events, undefined, now, ready);
  }
  return { events, clock: { head: head.id, at: now, ...(!canPlay ? { waitingSince: clock?.waitingSince ?? now } : {}) } };
}
export function pendingRelayUntil(task: Pick<RelayTask, 'key' | 'turn'>, current: readonly PetIntent[]): number {
  return current.reduce((until, event) => event.task.key === task.key && event.task.turn === task.turn ? Math.max(until, event.at + RELAY_MS) : until, 0);
}
export function arcPoint(from: { x: number; y: number }, to: { x: number; y: number }, progress: number) {
  const p = Math.max(0, Math.min(1, progress));
  return { x: from.x + (to.x - from.x) * p, y: from.y + (to.y - from.y) * p - Math.min(100, Math.hypot(to.x - from.x, to.y - from.y) / 3) * 4 * p * (1 - p) };
}
export function presentPet(lastEngaged: number, resident: boolean, now: number, pendingUntil = 0) {
  return { present: resident || now < pendingUntil || now - lastEngaged < IDLE_MS + RETURN_MS,
    returning: !resident && now >= pendingUntil && now - lastEngaged >= IDLE_MS };
}
export function maySpeak(lastSpoken: number | undefined, now: number) { return lastSpoken === undefined || now - lastSpoken >= SPEECH_MS; }

export interface LoopPair { sourceId: string; agent: string }
// A pair is established only by observed task attribution. Activity on an
// unrelated source or Agent cannot silently change one half of a relay.
export function selectLoopPair(tasks: readonly RelayTask[], previous: LoopPair | undefined, sources: ReadonlySet<string>, agents: ReadonlySet<string>): LoopPair | undefined {
  const valid = (pair: LoopPair) => sources.has(pair.sourceId) && agents.has(pair.agent);
  const rank = (task: RelayTask) => task.state === 'needsYou' ? 3 : task.state === 'running' ? 2 : task.state === 'unknown' ? 1 : 0;
  const candidates = tasks.filter(task => task.sourceId && valid({ sourceId: task.sourceId, agent: task.agent }))
    .sort((a, b) => rank(b) - rank(a) || b.at - a.at || a.key.localeCompare(b.key));
  const first = candidates[0];
  if (!first) return previous && valid(previous) ? previous : undefined;
  const retained = previous && candidates.find(task => task.sourceId === previous.sourceId && task.agent === previous.agent && rank(task) === rank(first));
  const chosen = retained ?? first;
  return { sourceId: chosen.sourceId!, agent: chosen.agent };
}
export function taskColor(key: string): string {
  let hash = 0;
  for (const letter of key) hash = (hash * 31 + letter.charCodeAt(0)) >>> 0;
  return `hsl(${hash % 360} 58% 48%)`;
}

// A quiet companion pair is presentation only; it never supplies task attribution.
export function selectCompanions(participants: readonly { id: string; kind: 'source' | 'agent'; brand: string }[], previous: readonly string[] = []): string[] {
  return (['source', 'agent'] as const).flatMap(kind => {
    const available = participants.filter(p => p.kind === kind);
    const chosen = available.find(p => previous.includes(p.id)) ?? available.find(p => p.brand === (kind === 'source' ? 'claude' : 'codex')) ?? available[0];
    return chosen ? [chosen.id] : [];
  });
}
