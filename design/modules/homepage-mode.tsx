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
          rounded-full bg-warning px-1 text-caption font-semibold text-canvas">{attention}</span> : undefined },
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

export default () => [
  ...modeForms.map(({ name, ...props }) => <Frame name={name}><HomepageModeSwitch {...props} /></Frame>),
  ...modeForms.map(({ mode, attention }) => <Frame name={`homepage-header-${mode}`}>
    <HomepageHeader mode={mode} attention={attention} />
  </Frame>),
];
