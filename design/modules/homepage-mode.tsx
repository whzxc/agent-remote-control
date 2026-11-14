import { Frame } from 'adg';
import { SingleChoice } from '../components/single-choice';
import { modeCopy as copy, modeForms } from '../fixtures/homepage-mode';

export type HomepageMode = 'topology' | 'tasks';

export function HomepageModeSwitch({ mode }: { mode: HomepageMode }) {
  return <SingleChoice label={copy.label} value={mode} options={[
    { value: 'topology', label: copy.topology }, { value: 'tasks', label: copy.tasks },
  ]} />;
}

/** One-row homepage bar: Board clock on the left, mode switch centered, view controls on the right. */
export function HomepageBar({ mode, compact = false, date = copy.date, time = copy.time, title = copy.board, children }: {
  mode: HomepageMode; compact?: boolean; date?: string; time?: string; title?: string; children?: unknown;
}) {
  return <div class="grid w-full grid-cols-[1fr_auto_1fr] items-center gap-3">
    <button aria-label={copy.openBoard} class="flex min-w-0 items-baseline gap-2 justify-self-start text-left text-text">
      <time class="text-title leading-6 font-[650] tabular-nums">{time}</time>
      <span class="truncate text-meta text-text-secondary">{title}{!compact && ` · ${date}`}</span>
    </button>
    <HomepageModeSwitch mode={mode} />
    <div class="flex min-w-0 items-center justify-end gap-2">{children}</div>
  </div>;
}

export default () => [
  ...modeForms.map(({ name, ...props }) => <Frame name={name}><HomepageModeSwitch {...props} /></Frame>),
  <Frame name="homepage-bar-topology" width={760}><HomepageBar mode="topology" /></Frame>,
  <Frame name="homepage-bar-tasks" width={760}><HomepageBar mode="tasks" /></Frame>,
  <Frame name="homepage-bar-tasks-compact" width={358}><HomepageBar mode="tasks" compact /></Frame>,
];
