import { Braces } from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge } from '../components/kit/badge';
import { IconButton } from '../components/kit/button';
import { cn } from '../components/kit/utils';
import { BoardStatusPill, type BoardTone } from './BoardRecordView';
import { RecordEventView } from './RecordView';

const eventDotTones: Record<BoardTone, string> = {
  neutral: 'border-border-strong bg-surface',
  accent: 'border-accent bg-surface',
  success: 'border-success bg-surface',
  warning: 'border-warning bg-surface',
  danger: 'border-danger bg-danger',
};

export function BoardEventRowView({
  eventId,
  tone,
  summary,
  timeNode,
  rawOpen,
  metadataLabel,
  onToggleRaw,
  statusLabel,
  statusTone,
  originLabel,
  resources,
  links,
  rawJson,
  nested = false,
}: {
  eventId: string;
  tone: BoardTone;
  summary: string;
  timeNode: ReactNode;
  rawOpen: boolean;
  metadataLabel: string;
  onToggleRaw: () => void;
  statusLabel?: string;
  statusTone?: BoardTone;
  originLabel: string;
  resources: readonly string[];
  links?: ReactNode;
  rawJson: string;
  nested?: boolean;
}) {
  return (
    <RecordEventView
      data-tone={tone}
      className={cn(
        nested
          ? 'border-t border-border pl-0'
          : 'before:absolute before:top-0 before:bottom-0 before:left-[5px] before:w-px before:bg-border first:before:top-4 last:before:bottom-[calc(100%-16px)] only:before:hidden',
      )}
    >
      {!nested && (
        <span
          aria-hidden="true"
          className={cn(
            'absolute top-3 left-px size-[9px] rounded-circle border-[length:var(--stroke-ring)]',
            eventDotTones[tone],
          )}
        />
      )}
      <div className="flex min-w-0 items-baseline gap-2">
        <strong className="min-w-0 flex-1 wrap-anywhere text-small font-semibold text-foreground">
          {summary}
        </strong>
        <span className="shrink-0 text-meta tabular-nums text-text-tertiary">{timeNode}</span>
        <IconButton
          icon={Braces}
          label={metadataLabel}
          iconSize={14}
          size="icon-sm"
          aria-expanded={rawOpen}
          aria-controls={`raw-${eventId}`}
          onClick={onToggleRaw}
          className={cn(
            '-my-1 -mr-1 size-6 shrink-0 self-center text-text-tertiary',
            rawOpen && 'bg-surface-subtle text-foreground',
          )}
        />
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-meta text-text-secondary">
        {statusLabel && statusTone && (
          <BoardStatusPill tone={statusTone}>{statusLabel}</BoardStatusPill>
        )}
        <span>{originLabel}</span>
        {resources.map((resource) => (
          <Badge key={resource} size="sm" tone="neutral">
            {resource}
          </Badge>
        ))}
      </div>
      {links && (
        <div className="flex flex-wrap gap-1.5 [&>.task-card]:basis-full">{links}</div>
      )}
      {rawOpen && (
        <pre
          id={`raw-${eventId}`}
          className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap wrap-anywhere rounded-tile border border-border bg-surface-subtle p-2.5 font-mono text-meta text-foreground"
        >
          {rawJson}
        </pre>
      )}
    </RecordEventView>
  );
}

export function BoardTimelineGroupView({
  tone,
  summary,
  count,
  timeNode,
  children,
}: {
  tone: BoardTone;
  summary: string;
  count: number;
  timeNode: ReactNode;
  children: ReactNode;
}) {
  return (
    <RecordEventView
      data-tone={tone}
      className="before:absolute before:top-0 before:bottom-0 before:left-[5px] before:w-px before:bg-border first:before:top-4 last:before:bottom-[calc(100%-16px)] only:before:hidden"
    >
      <span
        aria-hidden="true"
        className={cn(
          'absolute top-3 left-px size-[9px] rounded-circle border-[length:var(--stroke-ring)]',
          eventDotTones[tone],
        )}
      />
      <details className="center-group">
        <summary className="cursor-pointer list-none wrap-anywhere [&::-webkit-details-marker]:hidden">
          <span className="flex min-w-0 items-baseline gap-2">
            <strong className="min-w-0 flex-1 wrap-anywhere text-small font-semibold text-foreground">
              {summary}
            </strong>
            <Badge size="sm" tone="neutral">
              {count}
            </Badge>
            <span className="shrink-0 text-meta tabular-nums text-text-tertiary">
              {timeNode}
            </span>
          </span>
        </summary>
        <ol className="mt-1 grid list-none p-0">{children}</ol>
      </details>
    </RecordEventView>
  );
}
