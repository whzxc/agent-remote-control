import { RecordDetail } from '../components/record-detail';
import { Frame, Icon } from "adg";
import { Panel } from "../components/panel";
import { SingleChoice } from "../components/single-choice";
import { SearchInput } from "../components/search";
import { IconButton } from "../components/icon-button";
import { Button } from "../components/button";
import { Card } from "../components/card";
import { Tag } from "../components/tag";
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
  return <Tag form="workflow-status" icon={item.icon} tone={status === 'open' ? 'warning' : status === 'triaged' ? 'command' : status === 'fixed' ? 'success' : undefined}>{axStatusLabels[status]}</Tag>;
}

export function AXEntryRow({ entry }: { entry: AXEntry }) {
  return <Card padded className="gap-0">
    <button className="flex w-full items-center gap-3 text-left">
      <Tile form="phase" icon="lightbulb" tone="neutral" />
      <span className="flex min-w-0 flex-1 flex-col gap-[6px]">
        <span className="flex items-baseline gap-3">
          <span className="shrink-0 font-mono text-meta leading-5 text-text-tertiary">{entry.id}</span>
          <strong className="text-small leading-5 font-semibold">{entry.title}</strong>
        </span>
        <span className="text-meta leading-4 text-text-secondary">{entry.meta}</span>
      </span>
      <AXStatusBadge status={entry.status} />
      <Icon name="chevron-right" size={16} className="shrink-0 text-text-tertiary" />
    </button>
  </Card>;
}

export function AXEntryDetail() {
  return <RecordDetail variant="issue" className="flex flex-col gap-6">
    <div className="flex items-center justify-between">
      <Button variant="ghost" icon="arrow-left">{axCopy.back}</Button>
      <IconButton icon="copy" label={axCopy.copyId} />
    </div>
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <span className="font-mono text-meta text-text-secondary">{axDetail.entry.id}</span>
        <AXStatusBadge status={axDetail.entry.status} />
        <span className="text-meta text-text-secondary">{axCopy.workaround}</span>
      </div>
      <h3 className="text-title leading-6 font-semibold">{axDetail.entry.title}</h3>
      <p className="text-meta leading-4 text-text-secondary">{axCopy.lastSeen}</p>
    </div>
    <div className="grid grid-cols-2 gap-8">
      {axDetail.facts.map(fact => <section className="flex flex-col gap-2">
        <h4 className="text-meta leading-4 font-semibold text-text-secondary">{fact.label}</h4>
        <p className="text-small leading-5">{fact.text}</p>
      </section>)}
    </div>
    <Card padded className="gap-3">
      <h4 className="text-small leading-4 font-semibold">{axCopy.result}</h4>
      <p className="text-small leading-5">{axDetail.resolution}</p>
      <div className="flex items-center gap-2 text-meta leading-4 text-text-secondary">
        <Icon name="git-commit-horizontal" size={14} />
        <span>{axCopy.fixingCommit}</span><code className="font-mono text-text">{axDetail.commit}</code>
        <IconButton icon="copy" label={axCopy.copyCommit} compact />
      </div>
    </Card>
    <section className="flex flex-col gap-3">
      <h4 className="text-meta leading-4 font-semibold text-text-secondary">{axCopy.evidence}</h4>
      <div className="flex flex-col gap-3">
        {axDetail.evidence.map(item => <div className="flex items-center gap-3 text-small leading-5">
          <Icon name={item.icon} size={15} className="text-text-secondary" />
          <span>{item.label}</span><code className="font-mono text-meta text-text-secondary">{item.value}</code>
          <span className="ml-auto text-meta text-text-secondary">{item.status}</span>
        </div>)}
      </div>
    </section>
    <section className="flex flex-col gap-3 border-t border-border pt-5">
      <h4 className="text-meta leading-4 font-semibold text-text-secondary">{axCopy.history}</h4>
      {axDetail.history.map(item => <div className="flex items-center gap-3 text-meta leading-4">
        <Icon name={item.icon} size={14} className="text-text-tertiary" />
        <span className="text-text-secondary">{item.time}</span><span>{item.text}</span>
      </div>)}
    </section>
  </RecordDetail>;
}

export function AXBoard({ form }: { form: AXForm }) {
  const closed = form === "closed";
  return <Panel viewportHeight={1000} retainedHeight={closed ? 602 : undefined} title={axCopy.region}
    headerNavigation={<SingleChoice value="ax" options={axTabs} label={axCopy.region} tabs />}
    actions={<IconButton icon="refresh-cw" label={axCopy.refresh} />}
    footer={form !== "detail" && <div className="flex w-full items-center justify-between">
      <span className="text-meta leading-4 text-text-tertiary">{closed ? axCopy.shown : axCopy.updated}</span>
      {closed && <Button variant="ghost" icon="chevron-down">{axCopy.more}</Button>}
    </div>}>
    {form === "detail" ? <div className="pb-[25px]"><AXEntryDetail /></div> : <>
      <div className="flex items-center justify-between gap-6">
        <SingleChoice value={closed ? "closed" : "open"} options={axFilters} label={axCopy.status} className="auto-cols-auto!" />
        <div className="w-[240px]"><SearchInput placeholder={axCopy.search} /></div>
      </div>
      <div className="mt-6 flex flex-col gap-2">
        {(closed ? axClosedEntries : axOpenEntries).map(entry => <AXEntryRow entry={entry} />)}
      </div>
    </>}
  </Panel>;
}

export default () => [
  <Frame name="ax-status-badge-open" width={70}>
    <div className="flex w-full bg-surface-subtle"><AXStatusBadge status="open" /></div>
  </Frame>,
  <Frame name="ax-entry-row-open" width={772}>
    <div className="w-full bg-surface-raised"><AXEntryRow entry={axOpenEntries[0]} /></div>
  </Frame>,
  <Frame name="ax-status-badge-triaged" width={70}>
    <div className="flex w-full bg-surface-subtle"><AXStatusBadge status="triaged" /></div>
  </Frame>,
  <Frame name="ax-entry-row-triaged" width={772}>
    <div className="w-full bg-surface-raised"><AXEntryRow entry={axOpenEntries[3]} /></div>
  </Frame>,
  <Frame name="ax-status-badge-fixed" width={70}>
    <div className="flex w-full bg-surface-subtle"><AXStatusBadge status="fixed" /></div>
  </Frame>,
  <Frame name="ax-entry-row-fixed" width={772}>
    <div className="w-full bg-surface-raised"><AXEntryRow entry={axClosedEntries[0]} /></div>
  </Frame>,
  <Frame name="ax-status-badge-wontfix" width={70}>
    <div className="flex w-full bg-surface-subtle"><AXStatusBadge status="wontfix" /></div>
  </Frame>,
  <Frame name="ax-entry-row-wontfix" width={772}>
    <div className="w-full bg-surface-raised"><AXEntryRow entry={axClosedEntries[3]} /></div>
  </Frame>,
  <Frame name="ax-entry-detail" width={772}>
    <div className="w-full bg-surface-raised"><AXEntryDetail /></div>
  </Frame>,
];
