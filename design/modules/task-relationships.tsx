import { Frame, Icon } from "sdg";
import { Tile, type TileTone } from "../components/tile";
import { TopologyScene } from "../components/topology-scene";
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
export function TaskParentLink({
  title,
  label = "所属主线程",
}: {
  title: string;
  label?: string;
}) {
  return (
    <div class="flex items-center gap-[14px] h-(--control-height) rounded-field bg-surface-subtle px-3">
      <span class="text-meta text-text-secondary">{label}</span>
      <strong class="flex-1 text-small font-medium text-text">{title}</strong>
      <Icon name="chevron-right" size={16} class="text-text-secondary" />
    </div>
  );
}
export function RelationTaskCard({
  title,
  duration,
  phase,
  headline,
  tone,
  icon,
  kind,
}: RelationTask) {
  const color =
    tone === "thinking"
      ? "text-phase-thinking"
      : tone === "success"
        ? "text-success"
        : "text-phase-command";
  return (
    <div class="flex w-[400px] items-center gap-3 rounded-card bg-surface px-3 py-3 shadow-md">
      <Tile form="phase" icon={icon} tone={tone} />
      <div class="flex min-w-0 flex-1 flex-col gap-[9px]">
        <div class="flex items-center justify-between text-small leading-[14px] text-text">
          <strong class="font-[650]">{title}</strong>
          <span class="text-caption text-text-tertiary">{duration}</span>
        </div>
        <div class="flex items-center gap-[10px] text-meta leading-[13px]">
          <TaskRelation kind={kind} />
          <span class={color}>{phase}</span>
          <span class="text-text-secondary">{headline}</span>
        </div>
      </div>
    </div>
  );
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
      <h2 class="mt-[14px] px-1 text-title leading-6 font-[650] text-text">
        {title}
      </h2>
      <div class="mt-[14px] px-1 flex items-center gap-5 text-meta leading-4">
        <TaskRelation kind={kind} />
        <span
          class={tone === "thinking" ? "text-phase-thinking" : "text-success"}
        >
          {phase}
        </span>
      </div>
      <div class="mt-4">
        <TaskParentLink title={parentTitle} />
      </div>
    </section>
  );
}
export function TaskFamily() {
  return (
    <TopologyScene
      width={1140}
      height={520}
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
            y: y - 29,
            content: (
              <span class="font-mono text-caption leading-[14px] text-text-tertiary">
                {note}
              </span>
            ),
          },
          {
            x: 676,
            y,
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
        height={520}
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
  ...relationKinds.map((kind, i) => (
    <Frame name={`task-relation-${kind}`} width={i === 0 ? 83 : 84}>
      <div class="flex w-full bg-surface-raised text-meta leading-4"><TaskRelation kind={kind} /></div>
    </Frame>
  )),
  <Frame name="task-parent-link" width={392}>
    <div class="w-full bg-surface-raised"><TaskParentLink title={parentTitle} /></div>
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
