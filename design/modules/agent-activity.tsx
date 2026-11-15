import { Frame } from "adg";
import { TaskCard } from "./tasks";
import { origins } from "../fixtures/tasks";
import { taskDispatch } from "../fixtures/task-presentation";
import { agentHistory, agentRowExample } from "../fixtures/agent-activity";

export function AgentSectionHeading({ label, attention = false }: { label: string; attention?: boolean }) {
  return <h3 class={`text-meta leading-4 font-semibold ${attention ? "text-warning" : "text-text-secondary"}`}>{label}</h3>;
}

export function AgentTaskHistory({ groups }: { groups: typeof agentHistory }) {
  return groups.map((group) => (
    <section class="flex flex-col gap-2">
      <AgentSectionHeading label={group.heading} />
      {group.tasks.map((n) => (
        <TaskCard form={group.date === agentHistory[0].date ? "detail" : "summary"} task={{
          id: String(n), node: 'codex', title: `${agentRowExample.titlePrefix} ${n}`, group: 'recent',
          state: 'Completed', detail: '', icon: 'check', origin: origins.local, project: { name: agentRowExample.project },
          dispatch: taskDispatch, turns: 2,
        }} />
      ))}
    </section>
  ));
}
export default () => (
  <Frame name="history" width={380}>
    <div class="w-full bg-surface-raised"><AgentTaskHistory groups={[agentHistory[0]]} /></div>
  </Frame>
);
