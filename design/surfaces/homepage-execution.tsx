import { Frame } from 'adg';
import { HomepageHeader } from '../modules/homepage-mode';
import { ExecutionList, ExecutionEmpty } from '../modules/execution';
import { NavCapsule } from '../modules/nav-capsule';
import { tasks, memberTasks, screenForms, executionCopy as copy } from '../fixtures/execution';

export default () => screenForms.map(option => {
  const focused = 'focused' in option && option.focused;
  const member = 'member' in option && option.member;
  const empty = 'empty' in option && option.empty;
  const items = empty ? [] : member ? memberTasks : focused ? tasks.filter(t => t.node === 'cedar-codex') : tasks;
  return <Frame name={option.name} width={option.width} height={option.height} locale="en"
    note="Proposed. Manual persisted mode; task detail and mark-as-read are separate actions. List scrolls without compaction.">
    <div class="relative flex flex-col bg-canvas text-text" style={{ width: option.width, height: option.height }}>
      <div class="flex shrink-0 justify-center pb-5 pt-[27px]"><HomepageHeader mode="execution" /></div>
      <main aria-label={copy.tasks} tabindex={focused ? -1 : undefined}
        class="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {empty ? <ExecutionEmpty /> : <ExecutionList columns={option.width >= 1000 ? 2 : 1} focused={focused}
          items={items} />}
      </main>
      <div class="h-[68px] shrink-0" />
      <div data-free class="absolute bottom-6 left-6"><NavCapsule active="" /></div>
    </div>
  </Frame>;
});
