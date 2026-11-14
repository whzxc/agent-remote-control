import { Frame } from 'adg';
import { HomepageBar } from '../modules/homepage-mode';
import { TaskViewControls, TaskTiles, TaskStack } from '../modules/tasks';
import { NavCapsule } from '../modules/nav-capsule';
import { switcherForms, tasks, tasksCopy as copy } from '../fixtures/tasks';

export default () => [...switcherForms.map(option => {
  const mobile = option.width < 500, portrait = option.width < 1000, pad = mobile ? 'px-4' : 'px-6';
  const stack = option.layout === 'stack';
  const running = tasks.filter(task => task.group === 'running' || task.group === 'needs-me');
  const completed = tasks.filter(task => task.group !== 'running' && task.group !== 'needs-me');
  const columns = option.width >= 1500 ? 6 : option.width >= 1000 ? 5 : 2;
  const height = mobile ? 280 : portrait ? 360 : 340;
  const form = mobile ? 'mobile' : portrait ? 'portrait' : 'landscape';
  const deckHeight = option.height - 110;
  return <Frame name={option.name} width={option.width} height={option.height} locale="en"
    fixture={`homepage-switcher-${option.layout}`}
    capture={{ page: true, origin: '0 0', viewport: `${option.width}x${option.height}` }}
    note={'User-approved and adopted. One-row bar; cards report status only. Stack is a depth deck that follows the pointer or finger ' +
      '1:1 and settles with release velocity. Opening zooms the snapshot into the centered task layer; closing zooms back.'}>
    <div class="relative flex flex-col bg-canvas text-text" style={{ width: option.width, height: option.height }}>
      <div class={`shrink-0 pt-6 pb-4 ${pad}`}>
        <HomepageBar mode="tasks" compact={portrait}><TaskViewControls layout={option.layout} /></HomepageBar>
      </div>
      <main aria-label={copy.tasks} class="min-h-0 flex-1 overflow-y-auto pb-4">
        <section aria-label="Running" class={`mb-6 ${pad}`}>
          <h2 class="mb-[10px] text-small font-semibold">Running</h2>
          {stack && running.length > columns ? <div class="flex" style={{ height: deckHeight }}><TaskStack items={running} form={form} /></div>
            : <TaskTiles items={running} columns={columns} height={height} narrow={mobile} />}
        </section>
        <section aria-label="Completed" class={pad}>
          <h2 class="mb-[10px] text-small font-semibold">Completed</h2>
          {stack ? <div class="flex" style={{ height: deckHeight }}><TaskStack items={completed} form={form} /></div>
            : <TaskTiles items={completed} columns={columns} height={height} narrow={mobile} />}
        </section>
      </main>
      <div data-free class="absolute bottom-6 left-6"><NavCapsule active="" /></div>
    </div>
  </Frame>;
})];
