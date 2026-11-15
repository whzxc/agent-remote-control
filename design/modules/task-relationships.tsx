import { Frame, Icon } from "adg";
import type { TileTone } from "../components/tile";
import { TaskCard, TaskCardHeader, type TaskSnapshotData } from '../components/task-card';
import { origins } from "../fixtures/tasks";
import { parentTitle, family, headers, familyExample, relationKinds } from '../fixtures/task-relationships';

export type RelationKind = "side-chat" | "subagent";
export type RelationTask = {
  title: string;
  duration: string;
  phase: string;
  headline: string;
  tone: TileTone;
  icon: string;
  kind?: RelationKind;
};
export function TaskRelation({ kind }: { kind?: RelationKind }) {
  return kind ? (
    <span class="inline-flex items-center gap-[6px] text-meta text-text-secondary">
      <Icon name={kind === "side-chat" ? "message-circle" : "bot"} size={14} />
      <span>{kind === "side-chat" ? "Side chat" : "Subagent"}</span>
      <span class="text-text-tertiary">·</span>
    </span>
  ) : null;
}
function relatedTask(title: string, elapsed?: string): TaskSnapshotData {
  return { id: title, node: 'codex', title, group: 'recent', state: '', detail: '',
    icon: 'circle', origin: origins.local, elapsed };
}

export function RelationTaskCard({ title, duration }: RelationTask) {
  return <div class="w-[400px]"><TaskCard task={relatedTask(title, duration)} form="summary" /></div>;
}
export function TaskDetailHeader({
  agent,
  title,
  kind,
  phase,
  tone,
  parentTitle,
}: {
  agent: string;
  title: string;
  kind: RelationKind;
  phase: string;
  tone: TileTone;
  parentTitle: string;
}) {
  return (
    <section class="flex w-[424px] flex-col rounded-panel bg-surface-raised px-4 py-4 shadow-lg">
      <div class="flex items-center gap-3 px-1 h-6 text-text text-small font-semibold">
        <Icon name="arrow-left" size={16} />
        {agent}
      </div>
      <TaskCardHeader task={relatedTask(title)} heading />
      <div class="mt-[14px] px-1 flex items-center gap-5 text-meta leading-4">
        <TaskRelation kind={kind} />
        <span
          class={tone === "thinking" ? "text-role-agent" : "text-success"}
        >
          {phase}
        </span>
      </div>
      <div class="mt-4">
        <TaskCard task={relatedTask(parentTitle)} form="summary" />
      </div>
    </section>
  );
}
export default () => [
  ...relationKinds.map((kind, i) => (
    <Frame name={`task-relation-${kind}`} width={i === 0 ? 83 : 84}>
      <div class="flex w-full bg-surface-raised text-meta leading-4"><TaskRelation kind={kind} /></div>
    </Frame>
  )),
  <Frame name="task-parent-link" width={392}>
    <div class="w-full bg-surface-raised"><TaskCard task={relatedTask(parentTitle)} form="summary" /></div>
  </Frame>,
  <Frame name="relation-task-card" width={400}>
    <RelationTaskCard {...family[0]} />
  </Frame>,
  ...headers.map(({ index }) => (
    <Frame name={`task-detail-header-${family[index].kind}`} width={424}>
      <TaskDetailHeader
        agent={familyExample.agent}
        {...family[index]}
        kind={family[index].kind!}
        parentTitle={parentTitle}
      />
    </Frame>
  )),
];
