import { Frame } from 'adg';
import { HomepageBar, NavCapsule } from '../modules/homepage-scene';
import { ChildTaskList, TaskGrid } from '../modules/tasks';
import { examples, taskListClock } from '../fixtures/task-list';

function HomepageTaskList({ childrenOpen = false }: { childrenOpen?: boolean }) {
  return <div class="relative h-[720px] w-full overflow-hidden bg-canvas px-6 pt-6 text-text">
    <HomepageBar mode="tasks" language="zh-CN" {...taskListClock} />
    <main class="mt-5">
      <h2 class="mb-2 text-small font-semibold text-text-secondary">今天</h2>
      <TaskGrid items={examples} />
    </main>
    <div data-free class="absolute bottom-4 left-6"><NavCapsule active="" /></div>
    {childrenOpen && <div data-free class="absolute inset-0 flex items-center justify-center bg-canvas/80">
      <ChildTaskList task={examples[0]} />
    </div>}
  </div>;
}

export default () => [
  <Frame name="grouped-task-list" width={1040} height={720} locale="zh-CN" fixture="homepage-task-family" capture={{ page: true, viewport: '1040x720', origin: '0 0' }}><HomepageTaskList /></Frame>,
  <Frame name="grouped-task-children" width={1040} height={720} locale="zh-CN" fixture="grouped-task-children" capture={{ page: true, viewport: '1040x720', origin: '0 0' }}><HomepageTaskList childrenOpen /></Frame>,
];
