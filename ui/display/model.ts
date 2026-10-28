export type StudioPhase = 'auto' | 'day' | 'night';
export type StudioTone = Exclude<StudioPhase, 'auto'>;
export function studioToneAt(time: number, phase: StudioPhase): StudioTone {
  if (phase !== 'auto') return phase;
  const hour = new Date(time).getHours();
  return hour >= 7 && hour < 19 ? 'day' : 'night';
}
export function nextClockTick(time: number) {
  return 60_000 - ((time % 60_000 + 60_000) % 60_000);
}
export function parseStudioPhase(value: string): StudioPhase {
  return value === 'day' || value === 'night' ? value : 'auto';
}
