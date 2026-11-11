import { Frame, Icon } from "adg";
import { PanelShell, PanelHeader } from "../components/panel";
import { SingleChoice } from "../components/single-choice";
import { SearchInput } from "../components/search";
import { IconButton } from "../components/icon-button";
import { Button } from "../components/button";
import { Card } from "../components/card";
import { Tile } from "../components/tile";

import { axTabs, axFilters, axOpenEntries, axClosedEntries, axDetail, axStatusLabels, axCopy } from "../fixtures/ax";

export type AXStatus = "open" | "triaged" | "fixed" | "wontfix";
export type AXForm = "open" | "closed" | "detail";
export type AXEntry = { id: string; title: string; status: AXStatus; meta: string };
const statuses = {
  open: { icon: "circle-dot", tone: "text-warning bg-warning/10" },
  triaged: { icon: "list-checks", tone: "text-phase-command bg-phase-command/10" },
  fixed: { icon: "check", tone: "text-success bg-success/10" },
  wontfix: { icon: "minus", tone: "text-text-secondary bg-surface-sunken" },
};

export function AXStatusBadge({ status }: { status: AXStatus }) {
  const item = statuses[status];
  return <span
    class={`inline-flex shrink-0 items-center gap-[5px] rounded-field px-2 py-1 text-meta leading-4 font-medium ${item.tone}`}
  >
    <Icon name={item.icon} size={13} />{axStatusLabels[status]}
  </span>;
}

export function AXEntryRow({ entry }: { entry: AXEntry }) {
  return <Card padded class="gap-0">
    <button class="flex w-full items-center gap-3 text-left">
      <Tile form="phase" icon="lightbulb" tone="neutral" />
      <span class="flex min-w-0 flex-1 flex-col gap-[6px]">
        <span class="flex items-baseline gap-3">
          <span class="shrink-0 font-mono text-meta leading-5 text-text-tertiary">{entry.id}</span>
          <strong class="text-small leading-5 font-semibold">{entry.title}</strong>
        </span>
        <span class="text-meta leading-4 text-text-secondary">{entry.meta}</span>
      </span>
      <AXStatusBadge status={entry.status} />
      <Icon name="chevron-right" size={16} class="shrink-0 text-text-tertiary" />
    </button>
  </Card>;
}

export function AXEntryDetail() {
  return <div class="flex flex-col gap-6">
    <div class="flex items-center justify-between">
      <Button variant="ghost" icon="arrow-left">{axCopy.back}</Button>
      <IconButton icon="copy" label={axCopy.copyId} />
    </div>
    <div class="flex flex-col gap-3">
      <div class="flex items-center gap-3">
        <span class="font-mono text-meta text-text-secondary">{axDetail.entry.id}</span>
        <AXStatusBadge status={axDetail.entry.status} />
        <span class="text-meta text-text-secondary">{axCopy.workaround}</span>
      </div>
      <h3 class="text-title leading-6 font-semibold">{axDetail.entry.title}</h3>
      <p class="text-meta leading-4 text-text-secondary">{axCopy.lastSeen}</p>
    </div>
    <div class="grid grid-cols-2 gap-8">
      {axDetail.facts.map(fact => <section class="flex flex-col gap-2">
        <h4 class="text-meta leading-4 font-semibold text-text-secondary">{fact.label}</h4>
        <p class="text-small leading-5">{fact.text}</p>
      </section>)}
    </div>
    <Card padded class="gap-3">
      <h4 class="text-small leading-4 font-semibold">{axCopy.result}</h4>
      <p class="text-small leading-5">{axDetail.resolution}</p>
      <div class="flex items-center gap-2 text-meta leading-4 text-text-secondary">
        <Icon name="git-commit-horizontal" size={14} />
        <span>{axCopy.fixingCommit}</span><code class="font-mono text-text">{axDetail.commit}</code>
        <IconButton icon="copy" label={axCopy.copyCommit} compact />
      </div>
    </Card>
    <section class="flex flex-col gap-3">
      <h4 class="text-meta leading-4 font-semibold text-text-secondary">{axCopy.evidence}</h4>
      <div class="flex flex-col gap-3">
        {axDetail.evidence.map(item => <div class="flex items-center gap-3 text-small leading-5">
          <Icon name={item.icon} size={15} class="text-text-secondary" />
          <span>{item.label}</span><code class="font-mono text-meta text-text-secondary">{item.value}</code>
          <span class="ml-auto text-meta text-text-secondary">{item.status}</span>
        </div>)}
      </div>
    </section>
    <section class="flex flex-col gap-3 border-t border-border pt-5">
      <h4 class="text-meta leading-4 font-semibold text-text-secondary">{axCopy.history}</h4>
      {axDetail.history.map(item => <div class="flex items-center gap-3 text-meta leading-4">
        <Icon name={item.icon} size={14} class="text-text-tertiary" />
        <span class="text-text-secondary">{item.time}</span><span>{item.text}</span>
      </div>)}
    </section>
  </div>;
}

export function AXBoard({ form }: { form: AXForm }) {
  const closed = form === "closed";
  return <PanelShell width={820} height={form === "detail" ? undefined : 680} class="px-6 pt-[21px] pb-6">
    <PanelHeader title={axCopy.region} actions={<IconButton icon="refresh-cw" label={axCopy.refresh} />}>
      <div class="ml-2"><SingleChoice value="ax" options={axTabs} label={axCopy.region} tabs /></div>
    </PanelHeader>
    {form === "detail" ? <div class="mt-6"><AXEntryDetail /></div> : <>
      <div class="mt-[29px] flex items-center justify-between gap-6">
        <SingleChoice value={closed ? "closed" : "open"} options={axFilters} label={axCopy.status} class="auto-cols-auto!" />
        <div class="w-[240px]"><SearchInput placeholder={axCopy.search} /></div>
      </div>
      <div class="mt-6 flex flex-col gap-2">
        {(closed ? axClosedEntries : axOpenEntries).map(entry => <AXEntryRow entry={entry} />)}
      </div>
      <div class="mt-auto flex items-center justify-between pt-6">
        <span class="text-meta leading-4 text-text-tertiary">{closed ? axCopy.shown : axCopy.updated}</span>
        {closed && <Button variant="ghost" icon="chevron-down">{axCopy.more}</Button>}
      </div>
    </>}
  </PanelShell>;
}

export default () => [
  <Frame name="ax-status-badge-open" width={70}>
    <div class="flex w-full bg-surface-subtle"><AXStatusBadge status="open" /></div>
  </Frame>,
  <Frame name="ax-entry-row-open" width={772}>
    <div class="w-full bg-surface-raised"><AXEntryRow entry={axOpenEntries[0]} /></div>
  </Frame>,
  <Frame name="ax-status-badge-triaged" width={70}>
    <div class="flex w-full bg-surface-subtle"><AXStatusBadge status="triaged" /></div>
  </Frame>,
  <Frame name="ax-entry-row-triaged" width={772}>
    <div class="w-full bg-surface-raised"><AXEntryRow entry={axOpenEntries[3]} /></div>
  </Frame>,
  <Frame name="ax-status-badge-fixed" width={70}>
    <div class="flex w-full bg-surface-subtle"><AXStatusBadge status="fixed" /></div>
  </Frame>,
  <Frame name="ax-entry-row-fixed" width={772}>
    <div class="w-full bg-surface-raised"><AXEntryRow entry={axClosedEntries[0]} /></div>
  </Frame>,
  <Frame name="ax-status-badge-wontfix" width={70}>
    <div class="flex w-full bg-surface-subtle"><AXStatusBadge status="wontfix" /></div>
  </Frame>,
  <Frame name="ax-entry-row-wontfix" width={772}>
    <div class="w-full bg-surface-raised"><AXEntryRow entry={axClosedEntries[3]} /></div>
  </Frame>,
  <Frame name="ax-entry-detail" width={772}>
    <div class="w-full bg-surface-raised"><AXEntryDetail /></div>
  </Frame>,
];
