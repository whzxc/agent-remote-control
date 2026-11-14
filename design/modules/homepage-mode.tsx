import { Frame } from 'adg';
import { SingleChoice } from '../components/single-choice';
import { BoardHeader } from './board-header';
import { modeCopy as copy, modeForms } from '../fixtures/homepage-mode';

export type HomepageMode = 'topology' | 'tasks';

export function HomepageModeSwitch({ mode, attention = 0 }: { mode: HomepageMode; attention?: number }) {
  return <SingleChoice label={copy.label} value={mode} options={[
    { value: 'topology', label: copy.topology },
    { value: 'tasks', label: copy.tasks, graphic: mode === 'topology' && attention > 0
      ? <span aria-label={`${attention} need me`} class="mr-1 flex h-[18px] min-w-[18px] items-center justify-center
          rounded-full bg-warning px-1 text-caption font-semibold tabular-nums text-canvas">{attention > 99 ? '99+' : attention}</span> : undefined },
  ]} />;
}

export function HomepageHeader({ mode, attention = 0, date = copy.date, time = copy.time, title = copy.board }: {
  mode: HomepageMode; attention?: number; date?: string; time?: string; title?: string;
}) {
  return <div class="flex w-60 flex-col items-center gap-2">
    <BoardHeader date={date} time={time} title={title} />
    <HomepageModeSwitch mode={mode} attention={attention} />
  </div>;
}

/** One-row homepage bar: Board clock on the left, mode switch centered, view controls on the right. */
export function HomepageBar({ mode, attention = 0, compact = false, children }: {
  mode: HomepageMode; attention?: number; compact?: boolean; children?: unknown;
}) {
  return <div class="grid w-full grid-cols-[1fr_auto_1fr] items-center gap-3">
    <button aria-label={copy.openBoard} class="flex min-w-0 items-baseline gap-2 justify-self-start text-left text-text">
      <time class="text-title leading-6 font-[650] tabular-nums">{copy.time}</time>
      {!compact && <span class="truncate text-meta text-text-secondary">{copy.board} · {copy.date}</span>}
    </button>
    <HomepageModeSwitch mode={mode} attention={attention} />
    <div class="flex min-w-0 items-center justify-end gap-2">{children}</div>
  </div>;
}

export default () => [
  ...modeForms.map(({ name, ...props }) => <Frame name={name}><HomepageModeSwitch {...props} /></Frame>),
  ...modeForms.map(({ mode, attention }) => <Frame name={`homepage-header-${mode}`}>
    <HomepageHeader mode={mode} attention={attention} />
  </Frame>),
  <Frame name="homepage-bar-tasks" width={760}><HomepageBar mode="tasks" /></Frame>,
  <Frame name="homepage-bar-tasks-compact" width={358}><HomepageBar mode="tasks" compact /></Frame>,
];
