import { Frame } from "adg";
import {
  Activity,
  BellOff,
  CircleArrowDown,
  CirclePause,
  Lightbulb,
  Megaphone,
  MessageCircleQuestion,
  OctagonAlert,
  Unplug,
  type LucideIcon,
} from "lucide-react";
import { LocaleProvider } from "@/i18n/react";
import {
  BoardRowView,
  BoardSectionView,
  type BoardTone,
} from "@/coordination/BoardRecordView";
import {
  BoardFeedbackView,
  BoardFiltersView,
  BoardFooterView,
  BoardViewNavigation,
  CoordinationBoardView,
} from "@/coordination/CoordinationBoardView";
import { Panel } from "../components/panel";
import { IconButton } from "../components/icon-button";
import type { TileTone } from "../components/tile";
import { TaskCard, type TaskSnapshotData } from "../components/task-card";
import { boardTabs, boardFilters, boardGroups, boardCopy } from "../fixtures/board";

export type BoardForm = "current" | "empty" | "gap" | "unavailable";
export type BoardRowData = {
  title: string;
  meta: readonly string[];
  icon: string;
  tone: TileTone;
  task?: TaskSnapshotData;
};
export type BoardGroupData = { title: string; rows: BoardRowData[] };

const rowIcons: Record<string, LucideIcon> = {
  activity: Activity,
  "bell-off": BellOff,
  "circle-arrow-down": CircleArrowDown,
  "circle-pause": CirclePause,
  lightbulb: Lightbulb,
  megaphone: Megaphone,
  "message-circle-question-mark": MessageCircleQuestion,
  "shield-alert": OctagonAlert,
  unplug: Unplug,
};

function toBoardTone(tone: TileTone): BoardTone {
  if (
    tone === "neutral" ||
    tone === "success" ||
    tone === "warning" ||
    tone === "danger" ||
    tone === "accent"
  ) {
    return tone;
  }
  return "neutral";
}

export function BoardRow({ row }: { row: BoardRowData }) {
  if (row.task) {
    return (
      <TaskCard
        task={row.task}
        form={row.task.group === "recent" ? "summary" : "detail"}
      />
    );
  }
  return (
    <BoardRowView
      icon={rowIcons[row.icon] ?? OctagonAlert}
      tone={toBoardTone(row.tone)}
      title={row.title}
      meta={row.meta}
      interactive={row.tone !== "neutral"}
    />
  );
}

export function BoardSection({
  group,
  attention = false,
  partial = false,
}: {
  group: BoardGroupData;
  attention?: boolean;
  partial?: boolean;
}) {
  return (
    <BoardSectionView
      label={group.title}
      count={group.rows.length}
      attention={attention}
      note={partial ? boardCopy.partial : undefined}
    >
      {group.rows.map((row, index) => (
        <BoardRow key={`${group.title}-${index}`} row={row} />
      ))}
    </BoardSectionView>
  );
}

export function BoardFeedback({ gap = false }: { gap?: boolean }) {
  const copy = gap ? boardCopy.gap : boardCopy.unavailable;
  return (
    <BoardFeedbackView
      tone="danger"
      title={copy.title}
      detail={copy.detail}
      actionLabel={copy.action}
    />
  );
}

export function BoardFilters({ activity = false }: { activity?: boolean }) {
  return (
    <BoardFiltersView
      showFilter={!activity}
      filterLabel={boardCopy.filter}
      filterValue={boardCopy.all}
      filterOptions={boardFilters}
      resourceLabel={boardCopy.resource}
      resourceValue="all"
      resourceOptions={boardCopy.resources}
    />
  );
}

export function CoordinationBoard({
  form,
  viewportHeight,
}: {
  form: BoardForm;
  viewportHeight: number;
}) {
  const gap = form === "gap";
  const unavailable = form === "unavailable";
  const shown = unavailable
    ? [{ ...boardGroups[0], rows: boardGroups[0].rows.slice(0, 2) }]
    : boardGroups;

  return (
    <LocaleProvider locale="en">
      <Panel
        viewportHeight={viewportHeight}
        title={boardCopy.title}
        actions={<IconButton icon="refresh-cw" label={boardCopy.refresh} />}
        headerNavigation={
          <BoardViewNavigation
            label={boardCopy.title}
            value={gap ? "activity" : "current"}
            options={boardTabs}
          />
        }
        footer={
          (form === "current" || form === "empty") && (
            <BoardFooterView observedLabel={boardCopy.observed} />
          )
        }
      >
        <CoordinationBoardView
          filters={<BoardFilters activity={gap} />}
          notice={gap || unavailable ? <BoardFeedback gap={gap} /> : undefined}
          empty={form === "empty"}
          emptyMessage={boardCopy.empty}
        >
          {!gap &&
            form !== "empty" &&
            shown.map((group, index) => (
              <BoardSection
                key={group.title}
                group={group}
                attention={index === 0}
                partial={unavailable && index === 0}
              />
            ))}
        </CoordinationBoardView>
      </Panel>
    </LocaleProvider>
  );
}

export default () => [
  <Frame key="board-row-attention" name="board-row-attention" width={772}>
    <LocaleProvider locale="en">
      <div className="w-full bg-surface-raised">
        <BoardRow row={boardGroups[0].rows[0]} />
      </div>
    </LocaleProvider>
  </Frame>,
  <Frame key="board-row-passive" name="board-row-passive" width={772}>
    <LocaleProvider locale="en">
      <div className="w-full bg-surface-raised">
        <BoardRow row={boardGroups[0].rows[5]} />
      </div>
    </LocaleProvider>
  </Frame>,
  <Frame key="board-row-long" name="board-row-long" width={772}>
    <LocaleProvider locale="en">
      <div className="w-full bg-surface-raised">
        <BoardRow row={boardGroups[1].rows[2]} />
      </div>
    </LocaleProvider>
  </Frame>,
  <Frame key="board-section-attention" name="board-section-attention" width={772}>
    <LocaleProvider locale="en">
      <div className="w-full bg-surface-raised">
        <BoardSection group={boardGroups[0]} attention />
      </div>
    </LocaleProvider>
  </Frame>,
  <Frame key="board-section-partial" name="board-section-partial" width={772}>
    <LocaleProvider locale="en">
      <div className="w-full bg-surface-raised">
        <BoardSection
          group={{ ...boardGroups[0], rows: boardGroups[0].rows.slice(0, 2) }}
          attention
          partial
        />
      </div>
    </LocaleProvider>
  </Frame>,
  <Frame key="board-feedback-gap" name="board-feedback-gap" width={772}>
    <LocaleProvider locale="en">
      <div className="w-full bg-surface-raised">
        <BoardFeedback gap />
      </div>
    </LocaleProvider>
  </Frame>,
  <Frame key="board-filters-current" name="board-filters-current" width={772}>
    <LocaleProvider locale="en">
      <div className="w-full bg-surface-raised">
        <BoardFilters />
      </div>
    </LocaleProvider>
  </Frame>,
  <Frame key="board-filters-activity" name="board-filters-activity" width={772}>
    <LocaleProvider locale="en">
      <div className="w-full bg-surface-raised">
        <BoardFilters activity />
      </div>
    </LocaleProvider>
  </Frame>,
];
