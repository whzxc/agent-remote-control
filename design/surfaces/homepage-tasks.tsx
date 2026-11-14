import { Frame } from 'adg';
import { HomepageHeader, HomepageBar } from '../modules/homepage-mode';
import { TasksList, TasksEmpty, TaskViewControls, TaskTiles, TaskStack } from '../modules/tasks';
import { NavCapsule } from '../modules/nav-capsule';
import { tasks, memberTasks, screenForms, switcherForms, tasksCopy as copy } from '../fixtures/tasks';

export default () => [...screenForms.map(option => {
  const focused = 'focused' in option && option.focused;
  const member = 'member' in option && option.member;
  const empty = 'empty' in option && option.empty;
  const expanded = 'expanded' in option && option.expanded;
  const items = empty ? [] : member ? memberTasks : expanded ? tasks.filter(t => t.node === 'local-codex')
    : focused ? tasks.filter(t => t.node === 'cedar-codex') : tasks;
  return <Frame name={option.name} width={option.width} height={option.height} locale="en"
    note="Proposed. Full-width responsive task cards; compact cards expand in place. Header stays visible while groups scroll.">
    <div class="relative flex flex-col bg-canvas text-text" style={{ width: option.width, height: option.height }}>
      <div class="flex shrink-0 justify-center pb-5 pt-[27px]"><HomepageHeader mode="tasks" /></div>
      <main aria-label={copy.tasks} tabindex={focused || expanded ? -1 : undefined}
        class={`min-h-0 flex-1 overflow-y-auto pb-4 ${option.width < 500 ? 'px-4' : 'px-6'}`}>
        {empty ? <TasksEmpty /> : <TasksList density={option.density}
          columns={option.width >= 1500 ? 3 : option.width >= 1000 ? 2 : 1} focused={focused || expanded}
          expandedId={expanded ? 'queue' : undefined} filterLabel={expanded ? 'Codex · Studio' : undefined} items={items} />}
      </main>
      <div class="h-[68px] shrink-0" />
      <div data-free class="absolute bottom-6 left-6"><NavCapsule active="" /></div>
    </div>
  </Frame>;
}), ...switcherForms.map(option => {
  const mobile = option.width < 500, portrait = option.width < 1000, pad = mobile ? 'px-4' : 'px-6';
  const stack = option.layout === 'stack';
  return <Frame name={option.name} width={option.width} height={option.height} locale="en"
    note={'Proposed. One-row bar; cards report status only. Stack is a depth deck that follows the pointer or finger ' +
      '1:1 and settles with release velocity. Opening zooms the snapshot into the centered task layer; closing zooms back.'}>
    <div class="relative flex flex-col bg-canvas text-text" style={{ width: option.width, height: option.height }}>
      <div class={`shrink-0 pt-4 pb-4 ${pad}`}>
        <HomepageBar mode="tasks" compact={mobile}><TaskViewControls layout={option.layout} filter={!mobile} /></HomepageBar>
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
