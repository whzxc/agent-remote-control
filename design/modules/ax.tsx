import { Frame } from "adg";
import { LocaleProvider } from "@/i18n/react";
import {
  AXBoardFooterContent,
  AXBoardView,
  AXEntryRowView,
} from "@/coordination/AXBoardView";
import {
  AXEntryDetailView,
  AXStatusBadgeView,
} from "@/coordination/AXEntryDetailView";
import { BoardViewNavigation } from "@/coordination/CoordinationBoardView";
import { Panel } from "../components/panel";
import { IconButton } from "../components/icon-button";
import {
  axTabs,
  axFilters,
  axOpenEntries,
  axClosedEntries,
  axDetail,
  axStatusLabels,
  axCopy,
} from "../fixtures/ax";

export type AXStatus = "open" | "triaged" | "fixed" | "wontfix";
export type AXForm = "open" | "closed" | "detail";
export type AXEntry = { id: string; title: string; status: AXStatus; meta: string };

export function AXStatusBadge({ status }: { status: AXStatus }) {
  return <AXStatusBadgeView status={status} label={axStatusLabels[status]} />;
}

export function AXEntryRow({ entry }: { entry: AXEntry }) {
  return (
    <AXEntryRowView
      id={`ax-row-${entry.id}`}
      shortId={entry.id}
      title={entry.title}
      meta={entry.meta}
      status={entry.status}
      statusLabel={axStatusLabels[entry.status]}
    />
  );
}

export function AXEntryDetail() {
  return (
    <AXEntryDetailView
      ariaLabel={axCopy.region}
      id={axDetail.entry.id}
      status={axDetail.entry.status}
      statusLabel={axStatusLabels[axDetail.entry.status]}
      severityLabel={axCopy.workaround}
      symptom={axDetail.entry.title}
      metaLine={axCopy.lastSeen}
      backLabel={axCopy.back}
      copyIdLabel={axCopy.copyId}
      symptomHeading={axDetail.facts[0].label}
      expectedHeading={axDetail.facts[1].label}
      expected={axDetail.facts[1].text}
      resolution={{
        heading: axCopy.result,
        body: axDetail.resolution,
        commitLabel: axCopy.fixingCommit,
        commit: axDetail.commit,
        copyCommitLabel: axCopy.copyCommit,
      }}
      evidenceHeading={axCopy.evidence}
      evidence={axDetail.evidence.map((item, index) => ({
        key: `${index}-${item.value}`,
        kind:
          item.icon === "receipt-text"
            ? "receipt"
            : item.icon === "message-square"
              ? "thread"
              : "file",
        kindLabel: item.label,
        value: item.value,
        status: item.status,
      }))}
      historyHeading={axCopy.history}
      history={axDetail.history.map((item, index) => ({
        key: `${index}-${item.time}`,
        resolved: item.icon === "check",
        timeLabel: item.time,
        summary: item.text,
      }))}
    />
  );
}

export function AXBoard({ form }: { form: AXForm }) {
  const closed = form === "closed";
  const entries = closed ? axClosedEntries : axOpenEntries;
  return (
    <LocaleProvider locale="zh-CN">
      <Panel
        viewportHeight={1000}
        retainedHeight={closed ? 602 : undefined}
        title={axCopy.region}
        headerNavigation={
          <BoardViewNavigation
            label={axCopy.region}
            value="ax"
            options={axTabs}
          />
        }
        actions={<IconButton icon="refresh-cw" label={axCopy.refresh} />}
        footer={
          form !== "detail" && (
            <AXBoardFooterContent
              label={closed ? axCopy.shown : axCopy.updated}
              moreLabel={closed ? axCopy.more : undefined}
            />
          )
        }
      >
        <AXBoardView
          observed
          selectedContent={
            form === "detail" ? (
              <div className="pb-6">
                <AXEntryDetail />
              </div>
            ) : undefined
          }
          filterLabel={axCopy.status}
          filterValue={closed ? "closed" : "open"}
          filterOptions={axFilters.map((option) => ({
            value: option.value as "open" | "closed",
            label: option.label,
          }))}
          searchPlaceholder={axCopy.search}
        >
          {entries.map((entry) => (
            <AXEntryRow key={entry.id} entry={entry} />
          ))}
        </AXBoardView>
      </Panel>
    </LocaleProvider>
  );
}

export default () => [
  <Frame key="ax-status-badge-open" name="ax-status-badge-open" width={70}>
    <LocaleProvider locale="zh-CN">
      <div className="flex w-full bg-surface-subtle">
        <AXStatusBadge status="open" />
      </div>
    </LocaleProvider>
  </Frame>,
  <Frame key="ax-entry-row-open" name="ax-entry-row-open" width={772}>
    <LocaleProvider locale="zh-CN">
      <div className="w-full bg-surface-raised">
        <AXEntryRow entry={axOpenEntries[0]} />
      </div>
    </LocaleProvider>
  </Frame>,
  <Frame key="ax-status-badge-triaged" name="ax-status-badge-triaged" width={70}>
    <LocaleProvider locale="zh-CN">
      <div className="flex w-full bg-surface-subtle">
        <AXStatusBadge status="triaged" />
      </div>
    </LocaleProvider>
  </Frame>,
  <Frame key="ax-entry-row-triaged" name="ax-entry-row-triaged" width={772}>
    <LocaleProvider locale="zh-CN">
      <div className="w-full bg-surface-raised">
        <AXEntryRow entry={axOpenEntries[3]} />
      </div>
    </LocaleProvider>
  </Frame>,
  <Frame key="ax-status-badge-fixed" name="ax-status-badge-fixed" width={70}>
    <LocaleProvider locale="zh-CN">
      <div className="flex w-full bg-surface-subtle">
        <AXStatusBadge status="fixed" />
      </div>
    </LocaleProvider>
  </Frame>,
  <Frame key="ax-entry-row-fixed" name="ax-entry-row-fixed" width={772}>
    <LocaleProvider locale="zh-CN">
      <div className="w-full bg-surface-raised">
        <AXEntryRow entry={axClosedEntries[0]} />
      </div>
    </LocaleProvider>
  </Frame>,
  <Frame key="ax-status-badge-wontfix" name="ax-status-badge-wontfix" width={70}>
    <LocaleProvider locale="zh-CN">
      <div className="flex w-full bg-surface-subtle">
        <AXStatusBadge status="wontfix" />
      </div>
    </LocaleProvider>
  </Frame>,
  <Frame key="ax-entry-row-wontfix" name="ax-entry-row-wontfix" width={772}>
    <LocaleProvider locale="zh-CN">
      <div className="w-full bg-surface-raised">
        <AXEntryRow entry={axClosedEntries[3]} />
      </div>
    </LocaleProvider>
  </Frame>,
  <Frame key="ax-entry-detail" name="ax-entry-detail" width={772}>
    <LocaleProvider locale="zh-CN">
      <div className="w-full bg-surface-raised">
        <AXEntryDetail />
      </div>
    </LocaleProvider>
  </Frame>,
];
