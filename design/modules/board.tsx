import { Frame, Icon } from "adg";
import { PanelShell, PanelHeader } from "../components/panel";
import { SingleChoice } from "../components/single-choice";
import { Button } from "../components/button";
import { IconButton } from "../components/icon-button";
import { Tile, type TileTone } from "../components/tile";
import { boardTabs, boardFilters, boardGroups, boardCopy } from "../fixtures/board";

export type BoardForm = "current" | "empty" | "gap" | "unavailable";
export type BoardRowData = { title: string; meta: string; icon: string; tone: TileTone };
export type BoardGroupData = { title: string; rows: BoardRowData[] };

export function BoardRow({ row }: { row: BoardRowData }) {
  return (
    <article class="flex items-start gap-4 rounded-card bg-surface-subtle p-4">
      <Tile form="phase" icon={row.icon} tone={row.tone} />
      <div class="flex min-w-0 flex-1 flex-col">
        <strong class="whitespace-pre-line text-small leading-[19px] font-semibold">{row.title}</strong>
        <span class="text-meta leading-[13px] text-text-secondary">{row.meta}</span>
      </div>
      {row.tone !== "neutral" && <Icon name="chevron-right" class="self-center text-text-secondary" />}
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
    <section class="flex flex-col gap-2">
      <h3 class={`flex items-center gap-2 text-meta leading-4 font-semibold ${tone}`}>
        {group.title}
        <span class="font-normal text-text-tertiary">{group.rows.length}</span>
        {partial && <span class="ml-1 font-normal text-text-secondary">{boardCopy.partial}</span>}
      </h3>
      {group.rows.map(row => <BoardRow row={row} />)}
    </section>
  );
}

export function BoardFeedback({ gap = false }: { gap?: boolean }) {
  const copy = gap ? boardCopy.gap : boardCopy.unavailable;
  return (
    <div class="flex flex-col gap-1 rounded-card bg-danger/10 p-4">
      <strong class="text-small leading-4 font-semibold text-danger">{copy.title}</strong>
      <p class="text-meta leading-4 text-text-secondary">{copy.detail}</p>
      <div class="mt-[10px]"><Button>{copy.action}</Button></div>
    </div>
  );
}

export function BoardFilters({ activity = false }: { activity?: boolean }) {
  return (
    <div class="flex items-center gap-3">
      {!activity && (
        <SingleChoice value={boardCopy.all} options={boardFilters} label={boardCopy.filter} class="auto-cols-auto!" />
      )}
      <SingleChoice value="all" options={boardCopy.resources} label={boardCopy.resource} dropdown />
    </div>
  );
}

export function CoordinationBoard({ form, height }: { form: BoardForm; height: number }) {
  const gap = form === "gap", unavailable = form === "unavailable";
  const shown = unavailable
    ? boardGroups.slice(0, 2).map((g, i) => ({ ...g, rows: g.rows.slice(0, i === 0 ? 2 : 1) }))
    : boardGroups;
  return (
    <PanelShell width={820} height={height} class="px-6 pt-[21px] pb-6">
      <PanelHeader title={boardCopy.title} actions={<IconButton icon="refresh-cw" label={boardCopy.refresh} />}>
        <div class="ml-2">
          <SingleChoice value={gap ? "activity" : "current"} options={boardTabs} label={boardCopy.title} tabs />
        </div>
      </PanelHeader>
      <div class="mt-[29px]"><BoardFilters activity={gap} /></div>
      {(gap || unavailable) && <div class="mt-5"><BoardFeedback gap={gap} /></div>}
      {form === "empty" ? (
        <div class="flex flex-1 flex-col items-center justify-center gap-4 pt-4 text-small text-text-tertiary">
          <Tile icon="inbox" tone="neutral" />
          <span>{boardCopy.empty}</span>
        </div>
      ) : (
        !gap && (
          <div class={`flex flex-col ${unavailable ? "mt-6 gap-[22px]" : "mt-[26px] gap-6"}`}>
            {shown.map((group, i) => <BoardSection group={group} attention={i === 0} partial={unavailable && i === 0} />)}
          </div>
        )
      )}
      {(form === "current" || form === "empty") && (
        <p class="mt-auto pt-6 text-meta leading-4 text-text-tertiary">{boardCopy.observed}</p>
      )}
    </PanelShell>
  );
}

export default () => [
  <Frame name="board-row-attention" width={772}>
    <div class="w-full bg-surface-raised"><BoardRow row={boardGroups[0].rows[0]} /></div>
  </Frame>,
  <Frame name="board-row-passive" width={772}>
    <div class="w-full bg-surface-raised"><BoardRow row={boardGroups[0].rows[5]} /></div>
  </Frame>,
  <Frame name="board-row-long" width={772}>
    <div class="w-full bg-surface-raised"><BoardRow row={boardGroups[1].rows[2]} /></div>
  </Frame>,
  <Frame name="board-section-attention" width={772}>
    <div class="w-full bg-surface-raised"><BoardSection group={boardGroups[0]} attention /></div>
  </Frame>,
  <Frame name="board-section-partial" width={772}>
    <div class="w-full bg-surface-raised">
      <BoardSection group={{ ...boardGroups[0], rows: boardGroups[0].rows.slice(0, 2) }} attention partial />
    </div>
  </Frame>,
  <Frame name="board-feedback-gap" width={772}>
    <div class="w-full bg-surface-raised"><BoardFeedback gap /></div>
  </Frame>,
  <Frame name="board-feedback-unavailable" width={772}>
    <div class="w-full bg-surface-raised"><BoardFeedback /></div>
  </Frame>,
  <Frame name="board-filters-current" width={772}>
    <div class="w-full bg-surface-raised"><BoardFilters /></div>
  </Frame>,
  <Frame name="board-filters-activity" width={772}>
    <div class="w-full bg-surface-raised"><BoardFilters activity /></div>
  </Frame>,
];
