import { Frame } from 'adg';
import { HomepageBar } from '../modules/homepage-mode';
import { TaskGrid } from '../modules/tasks';
import { NavCapsule } from '../modules/nav-capsule';
import { taskListForms, tasks, tasksCopy as copy } from '../fixtures/tasks';

export default () => taskListForms.map(({ name, width, height }) => {
  const narrow = width < 500, pad = narrow ? 'px-4' : 'px-6';
  const dockInset = width <= 600 ? 16 : 24;
  const today = tasks.filter(task => task.group !== 'recent');
  const history = tasks.filter(task => task.group === 'recent');
  return <Frame name={name} width={width} height={height} locale="en" fixture="homepage-task-list"
    capture={{ page: true, origin: '0 0', viewport: `${width}x${height}` }}>
    <div class="relative flex flex-col bg-canvas text-text" style={{ width, height }}>
      <div class={`shrink-0 pt-6 pb-4 ${pad}`}>
        <HomepageBar mode="tasks" compact={width < 1000} />
      </div>
      <main aria-label={copy.tasks} class={`flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto ${pad}
        pb-[calc(${dockInset + 8}px_+_var(--dock-button-size)_+_2_*_var(--dock-padding-block))]`}>
        <section aria-label="Today" class="shrink-0">
          <h2 class="mb-2 text-small font-semibold text-text-secondary">Today</h2>
          <TaskGrid items={today} />
        </section>
        <section aria-label="Yesterday" class="shrink-0">
          <h2 class="mb-2 text-small font-semibold text-text-secondary">Yesterday</h2>
          <TaskGrid items={history} summary />
        </section>
      </main>
      <div data-free class="absolute" style={{ bottom: dockInset, left: dockInset }}><NavCapsule active="" /></div>
    </div>
  </Frame>;
});
