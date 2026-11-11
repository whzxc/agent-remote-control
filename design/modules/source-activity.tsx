import { Frame, Icon } from "adg";
import { Tile, type TileTone } from "../components/tile";
import { TaskRow } from "./task-presentation";
import { sourceDispatches, sourceHistory, attentionGroupTitles } from "../fixtures/source-activity";

const metaPaint = {
  warning: "text-warning", thinking: "text-phase-thinking", file: "text-phase-file",
  success: "text-success", danger: "text-danger", neutral: "text-text-tertiary",
};
export function SourceTaskGroups({ history = false }: { history?: boolean }) {
  return (
    <div class="flex flex-col gap-4">
      {(history ? sourceHistory : sourceDispatches).map((group, groupIndex) => {
        const headingPaint = attentionGroupTitles.includes(group.title) ? "text-warning" : "text-text-secondary";
        return (
          <section class="flex flex-col gap-2">
            <h3 class={`flex gap-[10px] text-meta leading-4 font-semibold ${headingPaint}`}>
              {group.title}<span class="text-text-tertiary">{group.rows.length}</span>
            </h3>
            {group.rows.map(([title, meta, tone, icon]) => (
              <TaskRow
                title={title}
                compact
                attention={groupIndex === 0}
                tile={<Tile form="phase" tone={tone as TileTone} icon={icon} />}
                trailing={(!history || !title.startsWith("Submission"))
                  ? <Icon name="chevron-right" size={16} class="self-center text-text-tertiary" /> : null}
              >
                <div class="flex flex-1 flex-col gap-[3px]">
                  <strong class="text-small leading-4 font-[650]">{title}</strong>
                  <span class={`text-meta leading-4 font-medium ${metaPaint[tone as keyof typeof metaPaint]}`}>{meta}</span>
                </div>
              </TaskRow>
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
