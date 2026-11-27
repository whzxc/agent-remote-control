import { Frame } from 'adg';
import { HomepageBar, NavCapsule } from '../modules/homepage-scene';
import { ChildTaskList, TaskGrid } from '../modules/tasks';
import { dayGridExample, examples, taskListClock } from '../fixtures/task-list';

function HomepageTaskList() {
  return <div className="relative h-[720px] w-full overflow-hidden bg-canvas px-6 pt-6 text-text">
    <HomepageBar mode="tasks" language="zh-CN" {...taskListClock} />
    <main className="mt-5">
      <h2 className="mb-2 text-small font-semibold text-text-secondary">今天</h2>
      <TaskGrid items={examples} day={{ columns: 3, form: 'detail' }} />
    </main>
    <div data-free className="absolute bottom-4 left-6"><NavCapsule active="" /></div>
  </div>;
}

function HomepageTaskDayGroups({ expanded = false }: { expanded?: boolean }) {
  const columns = 4;
  return <div className="relative w-full bg-canvas px-6 pt-6 pb-20 text-text">
    <HomepageBar mode="tasks" language="zh-CN" {...taskListClock} />
    <main className="mt-4 flex flex-col gap-6">
      <section aria-label="今天">
        <h2 className="mb-2 text-small font-semibold text-text-secondary">今天</h2>
        <TaskGrid items={dayGridExample.today} day={{ columns, form: 'detail' }} />
      </section>
      <section aria-label="昨天">
        <h2 className="mb-2 text-small font-semibold text-text-secondary">昨天</h2>
        <TaskGrid items={dayGridExample.yesterday} day={{ columns, form: 'summary', expanded }} />
      </section>
    </main>
    <div data-free className="absolute bottom-6 left-6"><NavCapsule active="" /></div>
  </div>;
}

export default () => [
  <Frame name="grouped-task-list" width={1040} height={720} locale="zh-CN" fixture="homepage-task-family" capture={{ page: true, viewport: '1040x720', origin: '0 0' }}><HomepageTaskList /></Frame>,
  <Frame name="grouped-task-children" width={560} locale="zh-CN" fixture="grouped-task-children" capture={{ selector: '.dialog.task-family-panel', viewport: '1040x720' }}><ChildTaskList task={examples[0]} /></Frame>,
  <Frame name="daily-task-groups-collapsed" width={1240} locale="zh-CN" fixture="homepage-task-daily-overflow" capture={{ page: true, viewport: '1240x695', origin: '0 0' }}
    note="When a day exceeds two rows, the last cell in the second row shows the stack and the hidden task count."><HomepageTaskDayGroups /></Frame>,
  <Frame name="daily-task-groups-expanded" width={1240} locale="zh-CN" fixture="daily-task-groups-expanded" capture={{ page: true, viewport: '1240x825', origin: '0 0' }}
    note="A single-layer collapse card follows the final task of the day."><HomepageTaskDayGroups expanded /></Frame>,
];
