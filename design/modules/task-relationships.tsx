import { Frame, Icon } from "adg";
import type { TileTone } from "../components/tile";
import { TaskCard, TaskCardHeader, type TaskSnapshotData } from "./tasks";
import { origins } from "../fixtures/tasks";
import { TopologyScene } from "./topology-scene";
import {
  parentTitle, family, positions, headers, familyExample, linkRows, branchRows, relationKinds,
} from "../fixtures/task-relationships";

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
          class={tone === "thinking" ? "text-phase-thinking" : "text-success"}
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
export function TaskFamily() {
  return (
    <TopologyScene
      width={1140}
      height={820}
      links={linkRows.map((y) => ({
        from: { x: 101, y: 230 },
        to: { x: 160, y: y + 30 },
        controls: [
          { x: 130, y: 230 },
          { x: 120, y: y + 30 },
        ],
      }))}
      items={[
        ...family.map((task, i) => ({
          ...positions[i],
          content: <RelationTaskCard {...task} />,
        })),
        {
          x: 43,
          y: 201,
          content: (
            <div class="flex flex-col items-center gap-2">
              <div
                class="grid size-[58px] place-items-center rounded-[29px] border-2 border-role-agent bg-surface text-role-agent"
              >
                <Icon name="terminal" size={24} />
              </div>
              <strong class="text-body text-text">{familyExample.agent}</strong>
            </div>
          ),
        },
        {
          x: 208,
          y: 346,
          content: (
            <div
              class="flex items-center gap-[10px] w-[194px] h-9 px-3 rounded-control bg-surface-subtle text-meta text-text-secondary"
            >
              <Icon name="chevron-down" size={14} />
              {familyExample.moreLabel}
            </div>
          ),
        },
        ...headers.flatMap(({ index, y, note }) => [
          {
            x: 676,
            y: y * 1.45 - 29,
            content: (
              <span class="font-mono text-caption leading-[14px] text-text-tertiary">
                {note}
              </span>
            ),
          },
          {
            x: 676,
            y: y * 1.45,
            content: (
              <TaskDetailHeader
                agent={familyExample.agent}
                {...family[index]}
                kind={family[index].kind!}
                parentTitle={parentTitle}
              />
            ),
          },
        ]),
      ]}
    >
      <svg
        class="absolute inset-0 pointer-events-none"
        width={1140}
        height={820}
        fill="none"
        stroke="var(--border-strong)"
        stroke-width="1.75"
        stroke-linecap="round"
      >
        <path d="M182 110V352Q182 364 194 364H208" />
        {branchRows.map((y) => (
          <path d={`M182 ${y}H208`} />
        ))}
      </svg>
    </TopologyScene>
  );
}

export default () => [
  <Frame name="task-family" width={1140} height={820}><TaskFamily /></Frame>,
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
