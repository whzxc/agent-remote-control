import { ChevronDown, ChevronRight, type LucideIcon } from 'lucide-react';
import type { ComponentType, HTMLAttributes, ReactNode } from 'react';
import { Notice } from '../components/kit/alert';
import { Badge } from '../components/kit/badge';
import { Button } from '../components/kit/button';
import { cn } from '../components/kit/utils';
import {
  RecordCardView,
  RecordDisclosureView,
  RecordHeadingView,
  RecordMetaView,
  RecordRowView,
} from './RecordView';

export type BoardTone = 'neutral' | 'success' | 'warning' | 'danger' | 'accent';

const glyphTones: Record<BoardTone, string> = {
  neutral: 'bg-surface-subtle text-text-tertiary border-border',
  accent: 'bg-accent/12 text-accent-text border-accent/20',
  success: 'bg-success/12 text-success border-success/20',
  warning: 'bg-warning/12 text-warning border-warning/20',
  danger: 'bg-danger/12 text-danger border-danger/20',
};

export function BoardRowGlyph({
  icon: IconComponent,
  tone,
}: {
  icon: LucideIcon;
  tone: BoardTone;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'grid size-8 shrink-0 place-items-center rounded-tile border',
        glyphTones[tone],
      )}
    >
      <IconComponent size={16} strokeWidth={1.75} absoluteStrokeWidth />
    </span>
  );
}

export function BoardStatusPill({
  tone,
  children,
}: {
  tone: BoardTone;
  children: ReactNode;
}) {
  return (
    <Badge
      size="sm"
      tone={tone === 'neutral' || tone === 'accent' ? 'neutral' : tone}
    >
      {children}
    </Badge>
  );
}

export function BoardMetaParts({
  parts,
  as = 'span',
  className,
}: {
  parts: readonly ReactNode[];
  as?: 'span' | 'div';
  className?: string;
}) {
  const visible = parts.filter((part) => part != null && part !== false && part !== '');
  if (!visible.length) return null;
  return (
    <RecordMetaView as={as} className={className}>
      {visible.map((part, index) => (
        <span key={index} className="inline-flex min-w-0 items-center gap-1">
          {index > 0 && (
            <span aria-hidden="true" className="text-text-tertiary">
              ·
            </span>
          )}
          {part}
        </span>
      ))}
    </RecordMetaView>
  );
}

export function BoardRowView({
  id,
  icon,
  tone,
  title,
  meta,
  muted = false,
  interactive = true,
  expanded,
  controlsId,
  onClick,
}: {
  id?: string;
  icon: LucideIcon;
  tone: BoardTone;
  title: ReactNode;
  meta?: readonly ReactNode[];
  muted?: boolean;
  interactive?: boolean;
  expanded?: boolean;
  controlsId?: string;
  onClick?: () => void;
}) {
  const body = (
    <>
      <BoardRowGlyph icon={icon} tone={tone} />
      <span className="record-row-body grid min-w-0 flex-1 gap-0.5">
        <strong
          className={cn(
            'whitespace-pre-line wrap-anywhere text-small leading-5',
            muted ? 'font-medium text-text-secondary' : 'font-semibold text-foreground',
          )}
        >
          {title}
        </strong>
        {meta && meta.length > 0 && <BoardMetaParts parts={meta} />}
      </span>
      {interactive && (
        <ChevronRight
          size={16}
          strokeWidth={1.75}
          absoluteStrokeWidth
          aria-hidden="true"
          className="center-row-go shrink-0 text-text-tertiary"
        />
      )}
    </>
  );

  if (!interactive) {
    return <RecordCardView className={muted ? 'muted' : undefined}>{body}</RecordCardView>;
  }
  return (
    <RecordRowView
      id={id}
      className={muted ? 'muted' : undefined}
      aria-expanded={expanded}
      aria-controls={controlsId}
      onClick={onClick}
    >
      {body}
    </RecordRowView>
  );
}

export function BoardSectionView({
  label,
  count,
  note,
  attention = false,
  children,
}: {
  label: string;
  count?: number;
  note?: ReactNode;
  attention?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      className="center-section flex flex-col gap-2"
      data-attention={attention || undefined}
      aria-label={label}
    >
      <RecordHeadingView count={count} attention={attention} note={note}>
        {label}
      </RecordHeadingView>
      <div className="center-rows grid gap-2">{children}</div>
    </section>
  );
}

export interface BoardDetailFact {
  label: string;
  value: ReactNode;
}

export function BoardRecordDetailView({
  Container,
  id = 'center-record-detail',
  headingId = 'center-record-heading',
  ariaLabel,
  kindLabel,
  title,
  backLabel,
  onBack,
  statusLabel,
  statusTone,
  ownerLabel,
  resources,
  error,
  retryLabel,
  retryBusy,
  retryDisabled,
  onRetry,
  conflicts,
  facts,
  linkedHeading,
  linkedTasks,
  conflictsUnknownNote,
  metadataLabel,
  metadataJson,
}: {
  Container?: ComponentType<HTMLAttributes<HTMLElement>>;
  id?: string;
  headingId?: string;
  ariaLabel: string;
  kindLabel: string;
  title: string;
  backLabel: string;
  onBack?: () => void;
  statusLabel: string;
  statusTone: BoardTone;
  ownerLabel: string;
  resources: readonly string[];
  error?: string;
  retryLabel?: string;
  retryBusy?: boolean;
  retryDisabled?: boolean;
  onRetry?: () => void;
  conflicts?: readonly { key: string; message: string }[];
  facts: readonly BoardDetailFact[];
  linkedHeading?: string;
  linkedTasks?: ReactNode;
  conflictsUnknownNote?: string;
  metadataLabel: string;
  metadataJson: string;
}) {
  const DetailTag = Container ?? 'section';
  return (
    <DetailTag
      id={id}
      className="center-detail grid content-start gap-3 @[680px]:col-start-2 @[680px]:row-start-1 @[680px]:min-h-0 @[680px]:overflow-auto @[680px]:border-l @[680px]:border-border @[680px]:pl-5"
      aria-label={ariaLabel}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="grid min-w-0 gap-0.5">
          <span className="text-meta font-medium text-text-tertiary">{kindLabel}</span>
          <h2
            id={headingId}
            tabIndex={-1}
            className="m-0 min-w-0 wrap-anywhere text-body font-semibold leading-5 text-foreground outline-none focus-visible:rounded-progress focus-visible:ring-2 focus-visible:ring-ring"
          >
            {title}
          </h2>
        </div>
        <Button size="sm" variant="outline" onClick={onBack} className="shrink-0">
          {backLabel}
        </Button>
      </header>

      <div className="flex flex-wrap items-center gap-1.5 text-meta text-text-secondary">
        <BoardStatusPill tone={statusTone}>{statusLabel}</BoardStatusPill>
        <span>{ownerLabel}</span>
        {resources.map((resource) => (
          <Badge key={resource} size="sm" tone="neutral">
            {resource}
          </Badge>
        ))}
      </div>

      {error && (
        <Notice
          tone="danger"
          action={
            onRetry && retryLabel ? (
              <Button size="sm" busy={retryBusy} disabled={retryDisabled} onClick={onRetry}>
                {retryLabel}
              </Button>
            ) : undefined
          }
        >
          {error}
        </Notice>
      )}

      {conflicts?.map((conflict) => (
        <Notice key={conflict.key} tone="warning">
          {conflict.message}
        </Notice>
      ))}

      <dl className="my-1 grid grid-cols-[minmax(0,0.42fr)_minmax(0,1fr)] gap-x-3 gap-y-2.5 text-small">
        {facts.map((fact) => (
          <div key={fact.label} className="contents">
            <dt className="wrap-anywhere text-text-secondary">{fact.label}</dt>
            <dd className="m-0 min-w-0 wrap-anywhere text-foreground">{fact.value}</dd>
          </div>
        ))}
      </dl>

      {linkedTasks && (
        <div className="grid gap-1.5">
          {linkedHeading && (
            <h3 className="m-0 text-meta font-semibold text-text-secondary">{linkedHeading}</h3>
          )}
          {linkedTasks}
        </div>
      )}

      {conflictsUnknownNote && (
        <p className="m-0 text-meta text-text-secondary">{conflictsUnknownNote}</p>
      )}

      <RecordDisclosureView className="mt-1">
        <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-disclosure text-text-tertiary hover:text-text-secondary [&::-webkit-details-marker]:hidden">
          <ChevronDown
            size={14}
            strokeWidth={1.75}
            absoluteStrokeWidth
            aria-hidden="true"
            className="icon"
          />
          {metadataLabel}
        </summary>
        <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap wrap-anywhere rounded-tile border border-border bg-surface-subtle p-2.5 font-mono text-meta text-foreground">
          {metadataJson}
        </pre>
      </RecordDisclosureView>
    </DetailTag>
  );
}
