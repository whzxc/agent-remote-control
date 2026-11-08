import { Frame, Icon } from "sdg";
import { PanelShell, PanelHeader } from "../components/panel";
import { SingleChoice } from "../components/single-choice";
import { Button } from "../components/button";
import { IconButton } from "../components/icon-button";
import { Tile, type TileTone } from "../components/tile";
const tabs = [
  { value: "current", label: "Current" },
  { value: "activity", label: "Activity" },
  { value: "ax", label: "AX" },
];
const filters = ["All", "Needs attention", "Task input", "History"].map(
  (label) => ({ value: label, label }),
);
const groups = [
  {
    title: "Needs attention",
    rows: [
      {
        title: "Choose the verification scope",
        meta: "Codex · Waiting for user input",
        icon: "message-circle-question-mark",
        tone: "warning",
      },
      {
        title: "Interrupted registered task",
        meta: "Codex · Interrupted",
        icon: "circle-pause",
        tone: "warning",
      },
      {
        title: "Claude",
        meta: "Connection problem",
        icon: "unplug",
        tone: "danger",
      },
      {
        title: "Claude",
        meta: "Notification problem",
        icon: "bell-off",
        tone: "warning",
      },
      {
        title: "ARC",
        meta: "Update problem",
        icon: "circle-arrow-down",
        tone: "warning",
      },
      {
        title: "Task detail reopens the previous turn after resume",
        meta: "AX candidate · awaiting Claude",
        icon: "lightbulb",
        tone: "neutral",
      },
    ],
  },
  {
    title: "Current work",
    rows: [
      {
        title: "Parallel registered work",
        meta: "Codex · Running",
        icon: "activity",
        tone: "accent",
      },
      {
        title: "Review the shared renderer and registered worktree",
        meta: "Claude · 2 min. ago · Sample project · Review lane",
        icon: "megaphone",
        tone: "accent",
      },
      {
        title:
          "Coordinate the release candidate across registered resources. Preserve linked task ownership,\nkeep interrupted work visible, and record evidence before clearing resource conditions.\n并行任务、资源所有者与活动覆盖情况均需保留，长内容可完整查看。",
        meta: "Local authority · 25 min. ago · ARC",
        icon: "megaphone",
        tone: "accent",
      },
    ],
  },
  {
    title: "Resource blockers",
    rows: [
      {
        title: "Registered build lane needs an explicit recovery decision",
        meta: "Stale · uncleared · Claude · 7 hr. ago · Task observation incomplete · Sample project · Review lane",
        icon: "shield-alert",
        tone: "warning",
      },
      {
        title:
          "Owner activity is uncertain; keep this resource condition uncleared",
        meta: "Uncertain · uncleared · Claude · just now · Activity time uncertain · ARC",
        icon: "shield-alert",
        tone: "warning",
      },
    ],
  },
];
const forms = [
  {
    name: "current",
    fixture: "coordination-problems",
    viewport: "1280x1400",
    clicks: ["Open board"],
    height: 1144,
  },
  {
    name: "empty",
    fixture: "coordination-empty",
    viewport: "1280x800",
    clicks: ["Open board"],
    height: 680,
  },
  {
    name: "gap",
    fixture: "coordination-gap",
    viewport: "1280x800",
    clicks: ["Open board", "Activity"],
    height: 680,
  },
  {
    name: "unavailable",
    fixture: "board-unavailable",
    viewport: "1280x800",
    height: 760,
  },
];
function Board({ form, height }: { form: string; height: number }) {
  const gap = form === "gap",
    unavailable = form === "unavailable";
  const shown = unavailable
    ? groups
        .slice(0, 2)
        .map((g, i) => ({ ...g, rows: g.rows.slice(0, i === 0 ? 2 : 1) }))
    : groups;
  return (
    <PanelShell width={820} height={height} class="px-6 pt-[21px] pb-6">
      <PanelHeader
        title="Board"
        actions={<IconButton icon="refresh-cw" label="Refresh" />}
      >
        <div class="ml-2">
          <SingleChoice
            value={gap ? "activity" : "current"}
            options={tabs}
            label="Board"
            tabs
          />
        </div>
      </PanelHeader>
      <div class="mt-[29px] flex items-center gap-3">
        {!gap && (
          <SingleChoice
            value="All"
            options={filters}
            label="Filter"
            class="auto-cols-auto!"
          />
        )}
        <SingleChoice
          value="all"
          options={[{ value: "all", label: "All resources" }]}
          label="Resource"
          dropdown
        />
      </div>
      {(gap || unavailable) && (
        <div class="mt-5 flex flex-col gap-1 rounded-card bg-danger/10 p-4">
          <strong class="text-small leading-4 font-semibold text-danger">
            {gap
              ? "History interval missing; reset the cursor to continue"
              : "Refresh unavailable; retained data may be stale"}
          </strong>
          <p class="text-meta leading-4 text-text-secondary">
            {gap
              ? "CURSOR_EXPIRED: Refresh the current owner record and retry."
              : "Error: SCENARIO_BOARD_UNAVAILABLE"}
          </p>
          <div class="mt-[10px]">
            <Button>{gap ? "Reset cursor" : "Retry"}</Button>
          </div>
        </div>
      )}
      {form === "empty" ? (
        <div class="flex flex-1 flex-col items-center justify-center gap-4 pt-4 text-small text-text-tertiary">
          <Tile icon="inbox" tone="neutral" />
          <span>No matching records</span>
        </div>
      ) : (
        !gap && (
          <div
            class={`flex flex-col ${unavailable ? "mt-6 gap-[22px]" : "mt-[26px] gap-6"}`}
          >
            {shown.map((group, i) => (
              <section class="flex flex-col gap-2">
                <h3
                  class={`flex items-center gap-2 text-meta leading-4 font-semibold ${i === 0 ? "text-warning" : "text-text-secondary"}`}
                >
                  {group.title}
                  <span class="font-normal text-text-tertiary">
                    {group.rows.length}
                  </span>
                  {unavailable && i === 0 && (
                    <span class="ml-1 font-normal text-text-secondary">
                      · Observation incomplete; attention count unavailable
                    </span>
                  )}
                </h3>
                {group.rows.map((row) => (
                  <article class="flex items-start gap-4 rounded-card bg-surface-subtle p-4">
                    <Tile
                      form="phase"
                      icon={row.icon}
                      tone={row.tone as TileTone}
                    />
                    <div class="flex min-w-0 flex-1 flex-col">
                      <strong class="whitespace-pre-line text-small leading-[19px] font-semibold">
                        {row.title}
                      </strong>
                      <span class="text-meta leading-[13px] text-text-secondary">
                        {row.meta}
                      </span>
                    </div>
                    {row.tone !== "neutral" && (
                      <Icon
                        name="chevron-right"
                        class="self-center text-text-secondary"
                      />
                    )}
                  </article>
                ))}
              </section>
            ))}
          </div>
        )
      )}
      {(form === "current" || form === "empty") && (
        <p class="mt-auto pt-6 text-meta leading-4 text-text-tertiary">
          Observed just now
        </p>
      )}
    </PanelShell>
  );
}
export default () =>
  forms.map(({ name, fixture, viewport, clicks, height }) => (
    <Frame
      name={name}
      fixture={fixture}
      capture={{ region: "Board", viewport, ...(clicks ? { clicks } : {}) }}
      note={
        name === "current"
          ? "Full-content drawing exceeds the scroll viewport; inspect remaining scroll content during browser acceptance."
          : name === "unavailable"
            ? "Prepared in the adapter: wait for SCENARIO_BOARD_UNAVAILABLE without retrying before capture."
            : undefined
      }
    >
      <Board form={name} height={height} />
    </Frame>
  ));
