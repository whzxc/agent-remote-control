import { Frame } from 'adg';
import { HomepageBar } from '../modules/homepage-mode';
import { TaskViewControls, TaskTiles, TaskStack } from '../modules/tasks';
import { NavCapsule } from '../modules/nav-capsule';
import { switcherForms, tasksCopy as copy } from '../fixtures/tasks';

export default () => [...switcherForms.map(option => {
  const mobile = option.width < 500, portrait = option.width < 1000, pad = mobile ? 'px-4' : 'px-6';
  const stack = option.layout === 'stack';
  return <Frame name={option.name} width={option.width} height={option.height} locale="en"
    fixture={`homepage-switcher-${option.layout}`}
    capture={{ page: true, origin: '0 0', viewport: `${option.width}x${option.height}` }}
    note={'User-approved and adopted. One-row bar; cards report status only. Stack is a depth deck that follows the pointer or finger ' +
      '1:1 and settles with release velocity. Opening zooms the snapshot into the centered task layer; closing zooms back.'}>
    <div class="relative flex flex-col bg-canvas text-text" style={{ width: option.width, height: option.height }}>
      <div class={`shrink-0 pt-4 pb-4 ${pad}`}>
        <HomepageBar mode="tasks" compact={portrait}><TaskViewControls layout={option.layout} filter={!mobile} /></HomepageBar>
      </div>
      <main aria-label={copy.tasks} class={`min-h-0 flex-1 overflow-y-auto pb-4 ${stack ? 'flex flex-col' : `pt-1 ${pad}`}`}>
        {stack ? <TaskStack form={mobile ? 'mobile' : portrait ? 'portrait' : 'landscape'} />
          : <TaskTiles columns={option.width >= 1500 ? 6 : option.width >= 1000 ? 5 : 2}
            height={mobile ? 280 : portrait ? 360 : 340} narrow={mobile} />}
      </main>
      <div class="h-[68px] shrink-0" />
      <div data-free class="absolute bottom-6 left-6"><NavCapsule active="" /></div>
    </div>
  </Frame>;
})];
