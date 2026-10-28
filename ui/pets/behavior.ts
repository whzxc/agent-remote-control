import type { AgentPhase } from '../types.ts';
import type { TaskState } from '../state/taskProjection.ts';

export type PetGesture = 'still' | 'nod' | 'sway' | 'hop' | 'bounce' | 'wiggle' | 'spin' | 'stretch' | 'peek' | 'lean';
export interface PetPose { row: number; gesture: PetGesture; tempo: number }
export const reactions = [
  { id: 'hello', rows: [3, 0], gesture: 'sway' },
  { id: 'highFive', rows: [3, 4, 3], gesture: 'hop' },
  { id: 'dance', rows: [1, 2, 3], gesture: 'wiggle' },
  { id: 'spin', rows: [3, 0, 3], gesture: 'spin' },
  { id: 'stretch', rows: [0, 4, 0], gesture: 'stretch' },
  { id: 'peek', rows: [8, 6, 8], gesture: 'peek' },
  { id: 'cheer', rows: [4, 3, 4], gesture: 'bounce' },
  { id: 'think', rows: [8, 0, 8], gesture: 'lean' },
  { id: 'listen', rows: [6, 8, 6], gesture: 'nod' },
  { id: 'shy', rows: [0, 6, 3], gesture: 'sway' },
  { id: 'ready', rows: [7, 3, 7], gesture: 'nod' },
  { id: 'tiptoe', rows: [1, 0, 2], gesture: 'hop' },
  { id: 'balance', rows: [2, 0, 1], gesture: 'lean' },
  { id: 'sparkle', rows: [4, 0, 3], gesture: 'spin' },
  { id: 'rest', rows: [0, 6, 0], gesture: 'stretch' },
  { id: 'thanks', rows: [3, 6, 3], gesture: 'nod' },
] as const satisfies readonly { id: string; rows: readonly number[]; gesture: PetGesture }[];

// Refill a shuffled deck only after every response has appeared. Avoid a repeat
// across deck boundaries as well as during rapid consecutive clicks.
export function reactionDeck(previous?: number, random = Math.random) {
  const deck = reactions.map((_, index) => index);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1)); [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  if (deck[0] === previous) [deck[0], deck[1]] = [deck[1], deck[0]];
  return deck;
}

export function activityPose(phase: AgentPhase, state: TaskState, participant: boolean, random = Math.random): PetPose {
  const pick = <T,>(values: readonly T[]) => values[Math.floor(random() * values.length)];
  if (state === 'needsYou') return { row: 6, gesture: pick<PetGesture>(['peek', 'sway']), tempo: 1.1 + random() * .3 };
  if (state === 'failed' || state === 'interrupted') return { row: 5, gesture: 'still', tempo: 1.1 + random() * .4 };
  if (state === 'unknown') return { row: 8, gesture: 'lean', tempo: 1.1 + random() * .4 };
  if (state === 'done' || phase === 'idle') return { row: pick([0, 0, 3]), gesture: pick<PetGesture>(['still', 'sway', 'stretch']), tempo: 1.1 + random() * .7 };
  const rows = participant ? {
    thinking: [0, 8, 6], command: [8, 3, 0], file: [8, 0, 3], tool: [6, 8, 3], text: [3, 0, 4], interaction: [6], idle: [0],
  } : {
    thinking: [8, 8, 6], command: [7, 1, 7], file: [7, 8, 7], tool: [7, 2, 7], text: [3, 7, 3], interaction: [6], idle: [0],
  };
  const gestures: Record<AgentPhase, readonly PetGesture[]> = {
    thinking: ['lean', 'peek', 'nod'], command: ['bounce', 'nod', 'still'], file: ['nod', 'lean', 'still'],
    tool: ['wiggle', 'nod', 'still'], text: ['sway', 'nod', 'hop'], interaction: ['peek'], idle: ['still'],
  };
  return { row: pick(rows[phase]), gesture: pick(gestures[phase]), tempo: (participant ? 1.15 : .8) + random() * .55 };
}
