import { Frame } from 'adg';
import { HomepageHeader } from '../modules/homepage-mode';
import { TasksList, TasksEmpty, TaskLayoutBar, TaskTiles, TaskStack } from '../modules/tasks';
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
  return <Frame name={option.name} width={option.width} height={option.height} locale="en"
    note={'Proposed. Portrait task snapshots in attention order. Tile is a grid; Stack is a one-sided deck with the first ' +
      'task in front, browsed with arrow keys, wheel or swipe. Opening a card uses the standard centered task layer.'}>
    <div class="relative flex flex-col bg-canvas text-text" style={{ width: option.width, height: option.height }}>
      <div class="flex shrink-0 justify-center pb-5 pt-[27px]"><HomepageHeader mode="tasks" /></div>
      <div class={`shrink-0 pb-4 ${pad}`}><TaskLayoutBar layout={option.layout} compact={portrait} /></div>
      <main aria-label={copy.tasks} class={`min-h-0 flex-1 overflow-y-auto pb-4 ${pad} ${option.layout === 'stack'
        ? 'flex flex-col' : ''}`}>
        {option.layout === 'tile'
          ? <TaskTiles columns={option.width >= 1500 ? 6 : option.width >= 1000 ? 5 : 2}
            height={mobile ? 290 : portrait ? 360 : 340} narrow={mobile} />
          : <TaskStack form={mobile ? 'mobile' : portrait ? 'portrait' : 'landscape'} />}
      </main>
      <div class="h-[68px] shrink-0" />
      <div data-free class="absolute bottom-6 left-6"><NavCapsule active="" /></div>
    </div>
  </Frame>;
})];
