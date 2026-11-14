import { Frame } from 'adg';
import { HomepageBar } from '../modules/homepage-mode';
import { TaskViewControls, TaskTiles, TaskStack, summaryOnly } from '../modules/tasks';
import { NavCapsule } from '../modules/nav-capsule';
import { switcherForms, tasks, tasksCopy as copy } from '../fixtures/tasks';

export default () => [...switcherForms.map(option => {
  const mobile = option.width < 500, portrait = option.width < 1000, pad = mobile ? 'px-4' : 'px-6';
  const stack = option.layout === 'stack';
  const running = tasks.filter(task => task.group === 'running' || task.group === 'needs-me');
  const previews = [...running, ...tasks.filter(task => task.group === 'unread')];
  const history = tasks.filter(summaryOnly);
  const columns = option.width >= 1500 ? 6 : option.width >= 1000 ? 5 : 2;
  const height = mobile ? 320 : 400;
  const form = mobile ? 'mobile' : portrait ? 'portrait' : 'landscape';
  return <Frame name={option.name} width={option.width} height={option.height} locale="en"
    fixture={`homepage-switcher-${option.layout}`}
    capture={{ page: true, origin: '0 0', viewport: `${option.width}x${option.height}` }}
    note={'User-approved and adopted. One-row bar; cards report status only. Stack is a depth deck that follows the pointer or finger ' +
      '1:1 and settles with release velocity. Opening zooms the snapshot into the centered task layer; closing zooms back.'}>
    <div class="relative flex flex-col bg-canvas text-text" style={{ width: option.width, height: option.height }}>
      <div class={`shrink-0 pt-6 pb-4 ${pad}`}>
        <HomepageBar mode="tasks" compact={portrait}><TaskViewControls layout={option.layout} /></HomepageBar>
      </div>
      <main aria-label={copy.tasks} class={`min-h-0 flex-1 overflow-y-auto pb-4 ${stack ? 'flex' : pad}`}>
        {stack ? <TaskStack items={[...previews, ...history]} form={form}
          spread={form === 'landscape' && option.width >= running.length * 376 + 148 ? Math.max(0, running.length - 1) : 0} />
          : <>
            <section aria-label="Active and unread" class="mb-6"><TaskTiles items={previews} columns={columns} height={height} narrow={mobile} /></section>
            <section aria-label="History"><TaskTiles items={history} columns={columns} height={height} narrow={mobile} /></section>
          </>}
      </main>
      <div data-free class="absolute bottom-6 left-6"><NavCapsule active="" /></div>
    </div>
  </Frame>;
})];
