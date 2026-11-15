import { Frame, Icon } from 'adg';
export function TimelineRailStep({ children }: { children: unknown }) {
  return <li class="relative flex gap-[10px] min-w-0"><span class="grid size-5 shrink-0 place-items-center rounded-full bg-surface-raised text-phase-command"><Icon name="terminal" size={13}/></span><div class="flex-1 min-w-0">{children}</div></li>;
}
export function TurnProgress() {
  return <div class="flex gap-1"><div class="h-[3px] flex-1 rounded bg-success"/><div class="h-[3px] flex-1 rounded bg-accent-text"/></div>;
}
export default () => <Frame name="rail" width={512}><div class="flex w-full flex-col gap-3"><TurnProgress/><ol><TimelineRailStep>Run checks</TimelineRailStep></ol></div></Frame>;
