import { Frame } from "adg";
import { TaskCard } from '../components/task-card';
import { origins } from "../fixtures/tasks";
import { sourceDispatches, sourceHistory, attentionGroupTitles } from "../fixtures/source-activity";

export function SourceTaskGroups({ history = false }: { history?: boolean }) {
  return (
    <div class="flex flex-col gap-4">
      {(history ? sourceHistory : sourceDispatches).map(group => {
        const headingPaint = attentionGroupTitles.includes(group.title) ? "text-warning" : "text-text-secondary";
        return (
          <section class="flex flex-col gap-2">
            <h3 class={`flex gap-[6px] text-meta leading-4 font-semibold ${headingPaint}`}>
              {group.title}<span class="text-text-tertiary">{group.rows.length}</span>
            </h3>
            {group.rows.map(([title, meta, tone, icon]) => (
              <TaskCard form={group.title === 'Yesterday' ? 'summary' : 'detail'} task={{
                id: title, title, node: 'codex', group: tone === 'thinking' || tone === 'file' ? 'running' : tone === 'warning' ? 'needs-me' : 'recent',
                state: meta, icon, origin: meta.startsWith('claude') ? origins.localClaude : origins.local,
                detail: title.startsWith('Submission') ? '' : meta.split(' · ')[1],
                activity: title.startsWith('Submission') ? meta.split(' · ')[1] : undefined,
                phase: tone === 'thinking' ? 'thinking' : tone === 'file' ? 'file' : undefined,
              }} />
            ))}
          </section>
        );
      })}
    </div>
  );
}
export default () => [false, true].map((history) => (
  <Frame name={history ? "history" : "dispatches"} width={440}>
    <div class="w-full bg-surface-raised"><SourceTaskGroups history={history} /></div>
  </Frame>
));
