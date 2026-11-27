import { RecordSurface } from '../components/record-detail';
import { Frame, Icon } from "adg";
import { Panel } from "../components/panel";
import { SingleChoice } from "../components/single-choice";
import { Button } from "../components/button";
import { Notice } from "../components/notice";
import { IconButton } from "../components/icon-button";
import { Tile, type TileTone } from "../components/tile";
import { TaskCard, type TaskSnapshotData } from '../components/task-card';
import { boardTabs, boardFilters, boardGroups, boardCopy } from "../fixtures/board";

export type BoardForm = "current" | "empty" | "gap" | "unavailable";
export type BoardRowData = { title: string; meta: readonly string[]; icon: string; tone: TileTone; task?: TaskSnapshotData };
export type BoardGroupData = { title: string; rows: BoardRowData[] };

export function BoardRow({ row }: { row: BoardRowData }) {
  if (row.task) return <TaskCard task={row.task} form={row.task.group === 'recent' ? 'summary' : 'detail'} />;
  return (
    <article className="flex min-h-16 items-center gap-4 rounded-card bg-surface-subtle p-4">
      <Tile form="phase" icon={row.icon} tone={row.tone} />
      <div className="flex min-w-0 flex-1 flex-col">
        <strong className="whitespace-pre-line text-small leading-(--line-small) font-semibold">{row.title}</strong>
        <span className="flex flex-wrap gap-x-1 text-meta leading-[13px] text-text-secondary">
          {row.meta.map((part, index) => <span>{index > 0 && <span aria-hidden="true" className="mr-1 text-text-tertiary">·</span>}{part}</span>)}
        </span>
      </div>
      {row.tone !== "neutral" && <Icon name="chevron-right" size={16} className="shrink-0 text-text-secondary" />}
    </article>
  );
}

export function BoardSection({ group, attention = false, partial = false }: {
  group: BoardGroupData;
  attention?: boolean;
  partial?: boolean;
}) {
  const tone = attention ? "text-warning" : "text-text-secondary";
  return (
    <section className="flex flex-col gap-2">
      <h3 className={`flex items-center gap-[6px] text-meta leading-4 font-semibold ${tone}`}>
        {group.title}
        <span className="font-normal text-text-tertiary">{group.rows.length}</span>
        {partial && <span className="ml-1 font-normal text-text-secondary">· {boardCopy.partial}</span>}
      </h3>
      {group.rows.map(row => <BoardRow row={row} />)}
    </section>
  );
}

export function BoardFeedback({ gap = false }: { gap?: boolean }) {
  const copy = gap ? boardCopy.gap : boardCopy.unavailable;
  return (
    <Notice title={copy.title} actionBelow action={<Button>{copy.action}</Button>}>
      <p>{copy.detail}</p>
    </Notice>
  );
}

export function BoardFilters({ activity = false }: { activity?: boolean }) {
  return (
    <div className="flex items-center gap-3">
      {!activity && (
        <SingleChoice value={boardCopy.all} options={boardFilters} label={boardCopy.filter} form="content-pills" />
      )}
      <SingleChoice value="all" options={boardCopy.resources} label={boardCopy.resource} dropdown />
    </div>
  );
}

export function CoordinationBoard({ form, viewportHeight }: { form: BoardForm; viewportHeight: number }) {
  const gap = form === "gap", unavailable = form === "unavailable";
  const shown = unavailable ? [{ ...boardGroups[0], rows: boardGroups[0].rows.slice(0, 2) }] : boardGroups;
  return (
    <Panel viewportHeight={viewportHeight} title={boardCopy.title}
      actions={<IconButton icon="refresh-cw" label={boardCopy.refresh} />}
      headerNavigation={<SingleChoice value={gap ? "activity" : "current"} options={boardTabs} label={boardCopy.title} tabs />}
      footer={(form === "current" || form === "empty") && <p className="text-meta leading-4 text-text-tertiary">{boardCopy.observed}</p>}>
      <RecordSurface className="flex flex-col gap-5">
      <div><BoardFilters activity={gap} /></div>
      {(gap || unavailable) && <div className="mt-5"><BoardFeedback gap={gap} /></div>}
      {form === "empty" ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 pt-4 text-small text-text-tertiary">
          <Tile icon="inbox" tone="neutral" />
          <span>{boardCopy.empty}</span>
        </div>
      ) : (
        !gap && (
          <div className={`flex flex-col ${unavailable ? "mt-[22px]" : "mt-[26px] gap-6"}`}>
            {shown.map((group, i) => <BoardSection group={group} attention={i === 0} partial={unavailable && i === 0} />)}
          </div>
        )
      )}
      </RecordSurface>
    </Panel>
  );
}

export default () => [
  <Frame name="board-row-attention" width={772}>
    <div className="w-full bg-surface-raised"><BoardRow row={boardGroups[0].rows[0]} /></div>
  </Frame>,
  <Frame name="board-row-passive" width={772}>
    <div className="w-full bg-surface-raised"><BoardRow row={boardGroups[0].rows[5]} /></div>
  </Frame>,
  <Frame name="board-row-long" width={772}>
    <div className="w-full bg-surface-raised"><BoardRow row={boardGroups[1].rows[2]} /></div>
  </Frame>,
  <Frame name="board-section-attention" width={772}>
    <div className="w-full bg-surface-raised"><BoardSection group={boardGroups[0]} attention /></div>
  </Frame>,
  <Frame name="board-section-partial" width={772}>
    <div className="w-full bg-surface-raised">
      <BoardSection group={{ ...boardGroups[0], rows: boardGroups[0].rows.slice(0, 2) }} attention partial />
    </div>
  </Frame>,
  <Frame name="board-feedback-gap" width={772}>
    <div className="w-full bg-surface-raised"><BoardFeedback gap /></div>
  </Frame>,
  <Frame name="board-filters-current" width={772}>
    <div className="w-full bg-surface-raised"><BoardFilters /></div>
  </Frame>,
  <Frame name="board-filters-activity" width={772}>
    <div className="w-full bg-surface-raised"><BoardFilters activity /></div>
  </Frame>,
];
