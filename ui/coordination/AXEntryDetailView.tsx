import {
  ArrowLeft, Check, CircleDot, Copy, FileText, GitCommitHorizontal,
  Lightbulb, ListChecks, MessageSquare, Minus, ReceiptText, X, type LucideIcon,
} from 'lucide-react';
import type { ComponentType, HTMLAttributes, ReactNode, Ref } from 'react';
import { Badge } from '../components/kit/badge';
import { Button, IconButton } from '../components/kit/button';
import { Card } from '../components/kit/card';
import { HintTooltip } from '../components/kit/tooltip';

const statusIcons: Record<string, LucideIcon> = {
  open: CircleDot, triaged: ListChecks, candidate: Lightbulb, fix: Check,
  fixed: Check, document: Check, wontfix: Minus, merged: Minus, rejected: X, closed: Check,
};

function statusTone(status: string): 'warning' | 'command' | 'success' | 'neutral' {
  if (status === 'open' || status === 'candidate') return 'warning';
  if (status === 'triaged') return 'command';
  if (status === 'fix' || status === 'fixed' || status === 'document' || status === 'closed') return 'success';
  return 'neutral';
}

export function AXStatusBadgeView({ status, label }: { status: string; label: string }) {
  const IconComponent = statusIcons[status] ?? CircleDot;
  return (
    <Badge size="sm" tone={statusTone(status)}>
      <IconComponent size={12} strokeWidth={1.75} absoluteStrokeWidth aria-hidden="true" />
      {label}
    </Badge>
  );
}

export interface AXEvidenceItem {
  key: string;
  kind: 'receipt' | 'thread' | 'file';
  kindLabel: string;
  value: string;
  status?: string;
}

export interface AXHistoryItem {
  key: string;
  resolved: boolean;
  timeLabel: string;
  dateTime?: string;
  summary: string;
  reason?: string;
}

export interface AXResolutionData {
  heading: string;
  body: string;
  commitLabel?: string;
  commit?: string;
  copyCommitLabel?: string;
  copyCommitAction?: ReactNode;
  document?: string;
  mergedIntoLabel?: string;
  mergedInto?: string;
}

export function AXEntryDetailView({
  DetailContainer, ariaLabel, id, status, statusLabel, severityLabel, symptom, metaLine,
  backLabel, onBack, copyIdLabel, copyIdAction, headingRef, symptomHeading, expectedHeading,
  expected, reproductionHeading, reproductionHints, resolution, evidenceHeading, evidence,
  historyHeading, history,
}: {
  DetailContainer?: ComponentType<HTMLAttributes<HTMLElement> & { variant?: 'record' | 'issue' }>;
  ariaLabel: string; id: string; status: string; statusLabel: string; severityLabel?: string;
  symptom: string; metaLine: string; backLabel: string; onBack?: () => void;
  copyIdLabel?: string; copyIdAction?: ReactNode; headingRef?: Ref<HTMLHeadingElement>;
  symptomHeading: string; expectedHeading: string; expected: string;
  reproductionHeading?: string; reproductionHints?: string;
  resolution?: AXResolutionData; evidenceHeading?: string; evidence?: readonly AXEvidenceItem[];
  historyHeading: string; history: readonly AXHistoryItem[];
}) {
  const Container = DetailContainer;
  const content = (
    <div className="flex flex-none flex-col gap-5">
      <div className="flex flex-none items-center justify-between gap-2">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft size={14} strokeWidth={1.75} absoluteStrokeWidth aria-hidden="true" />
          {backLabel}
        </Button>
        {copyIdAction ?? (copyIdLabel ? <IconButton icon={Copy} label={copyIdLabel} compact /> : null)}
      </div>

      <header className="flex flex-col gap-2.5">
        <div className="flex flex-wrap items-center gap-2.5 text-meta text-text-secondary">
          <code className="font-mono text-meta leading-5 wrap-anywhere text-text-secondary">{id}</code>
          <AXStatusBadgeView status={status} label={statusLabel} />
          {severityLabel && <span>{severityLabel}</span>}
        </div>
        <h3 ref={headingRef} tabIndex={-1} className="m-0 wrap-anywhere text-title leading-6 font-semibold text-foreground outline-none focus-visible:rounded-progress focus-visible:ring-2 focus-visible:ring-ring">
          {symptom}
        </h3>
        <div className="text-meta leading-4 text-text-secondary">{metaLine}</div>
      </header>

      <div className="grid grid-cols-1 gap-5 @[480px]:grid-cols-2 @[480px]:gap-8">
        <section className="flex flex-col gap-1.5">
          <h4 className="m-0 text-meta leading-4 font-semibold text-text-secondary">{symptomHeading}</h4>
          <p className="m-0 whitespace-pre-wrap wrap-anywhere text-small leading-5 text-foreground">{symptom}</p>
        </section>
        <section className="flex flex-col gap-1.5">
          <h4 className="m-0 text-meta leading-4 font-semibold text-text-secondary">{expectedHeading}</h4>
          <p className="m-0 whitespace-pre-wrap wrap-anywhere text-small leading-5 text-foreground">{expected}</p>
        </section>
      </div>

      {reproductionHints && reproductionHeading && (
        <section className="flex flex-col gap-1.5">
          <h4 className="m-0 text-meta leading-4 font-semibold text-text-secondary">{reproductionHeading}</h4>
          <p className="m-0 whitespace-pre-wrap wrap-anywhere text-small leading-5 text-foreground">{reproductionHints}</p>
        </section>
      )}

      {resolution && (
        <Card padded render={<section />} className="gap-3 bg-surface-subtle/60">
          <h4 className="m-0 text-small! leading-4 font-semibold text-foreground!">{resolution.heading}</h4>
          <p className="m-0 whitespace-pre-wrap wrap-anywhere text-small leading-5 text-foreground">{resolution.body}</p>
          {resolution.commit && (
            <div className="flex flex-wrap items-center gap-2 text-meta leading-4 text-text-secondary">
              <GitCommitHorizontal size={14} strokeWidth={1.75} absoluteStrokeWidth aria-hidden="true" />
              {resolution.commitLabel && <span>{resolution.commitLabel}</span>}
              <code className="font-mono text-meta text-foreground wrap-anywhere">{resolution.commit}</code>
              {resolution.copyCommitAction ?? (resolution.copyCommitLabel ? <IconButton icon={Copy} label={resolution.copyCommitLabel} compact /> : null)}
            </div>
          )}
          {resolution.document && (
            <div className="flex flex-wrap items-center gap-2 text-meta leading-4 text-text-secondary">
              <FileText size={14} strokeWidth={1.75} absoluteStrokeWidth aria-hidden="true" />
              {resolution.document}
            </div>
          )}
          {resolution.mergedInto && (
            <p className="m-0 text-small leading-5 text-foreground">
              <span className="text-text-secondary">{resolution.mergedIntoLabel}</span>{' '}
              <code className="font-mono text-meta">{resolution.mergedInto}</code>
            </p>
          )}
        </Card>
      )}

      {evidence && evidence.length > 0 && evidenceHeading && (
        <section className="flex flex-col gap-2">
          <h4 className="m-0 text-meta leading-4 font-semibold text-text-secondary">{evidenceHeading}</h4>
          <div className="flex flex-col gap-2.5 pt-1">
            {evidence.map((item) => {
              const EvidenceIcon = item.kind === 'receipt' ? ReceiptText : item.kind === 'thread' ? MessageSquare : FileText;
              return (
                <div key={item.key} className="flex flex-wrap items-center gap-2.5 text-small leading-5 @[480px]:flex-nowrap">
                  <EvidenceIcon size={14} strokeWidth={1.75} absoluteStrokeWidth aria-hidden="true" className="shrink-0 text-text-secondary" />
                  <span className="text-foreground">{item.kindLabel}</span>
                  <HintTooltip text={item.value}>
                    <code className="min-w-0 font-mono text-meta wrap-anywhere text-text-secondary">{item.value}</code>
                  </HintTooltip>
                  {item.status && <span className="ml-auto shrink-0 text-meta text-text-secondary">{item.status}</span>}
                </div>
              );
            })}
          </div>
        </section>
      )}

      <section className="flex flex-col gap-2.5 border-t border-border pt-4">
        <h4 className="m-0 text-meta leading-4 font-semibold text-text-secondary">{historyHeading}</h4>
        {history.map((item) => {
          const HistoryIcon = item.resolved ? Check : CircleDot;
          return (
            <div key={item.key} className="flex flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2.5 text-meta leading-4 @[480px]:flex-nowrap">
                <HistoryIcon size={14} strokeWidth={1.75} absoluteStrokeWidth aria-hidden="true" className="shrink-0 text-text-secondary" />
                <time dateTime={item.dateTime} className="shrink-0 tabular-nums text-text-secondary">{item.timeLabel}</time>
                <span className="text-foreground">{item.summary}</span>
              </div>
              {item.reason && (
                <p className="m-0 pl-[26px] whitespace-pre-wrap wrap-anywhere text-small leading-5 text-text-secondary">{item.reason}</p>
              )}
            </div>
          );
        })}
      </section>
    </div>
  );

  const detailClass = 'ax-detail @container flex min-h-0 flex-col gap-5 overflow-auto overscroll-contain';
  if (Container) {
    return <Container variant="issue" className={detailClass} aria-label={ariaLabel}>{content}</Container>;
  }
  return <section className={detailClass} aria-label={ariaLabel}>{content}</section>;
}
