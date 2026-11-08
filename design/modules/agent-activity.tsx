import { Frame } from "sdg";
import { Tile } from "../components/tile";
import { Tag } from "../components/tag";
import { TaskRow } from "./task-presentation";
import { agentHistory, agentRowExample } from "../fixtures/agent-activity";

export function AgentTaskHistory({ groups }: { groups: typeof agentHistory }) {
  return groups.map((group) => (
    <section class="flex flex-col gap-2">
      <h3 class="text-meta leading-4 font-semibold text-text-secondary">{group.heading}</h3>
      {group.tasks.map((n) => (
        <TaskRow
          title={`${agentRowExample.titlePrefix} ${n}`}
          compact
          tile={<Tile icon="circle" form="phase" tone="neutral" />}
          trailing={null}
        >
          <div class="flex min-w-0 flex-1 flex-col gap-[2px]">
            <strong class="text-small leading-[18px] font-[650]">{agentRowExample.titlePrefix} {n}</strong>
            <div class="flex items-center justify-between">
              <Tag>{agentRowExample.project}</Tag>
              <span class="text-caption text-text-tertiary">{group.date}</span>
            </div>
          </div>
        </TaskRow>
      ))}
    </section>
  ));
}
export default () => (
  <Frame name="history" width={380}>
    <div class="w-full bg-surface-raised"><AgentTaskHistory groups={[agentHistory[0]]} /></div>
  </Frame>
);
