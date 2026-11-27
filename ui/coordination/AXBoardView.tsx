import { ChevronDown, ChevronRight, Inbox, Lightbulb } from 'lucide-react';
import type { ComponentType, HTMLAttributes, ReactNode, Ref } from 'react';
import { Notice } from '../components/kit/alert';
import { Button } from '../components/kit/button';
import { Card } from '../components/kit/card';
import { SearchInput as KitSearchInput } from '../components/kit/input';
import { SegmentedControl, type SegmentedOption } from '../components/kit/segmented-control';
import { HintTooltip } from '../components/kit/tooltip';
import { AXStatusBadgeView } from './AXEntryDetailView';
import { RecordListRowView } from './RecordView';

export function AXEntryRowView({
  id, shortId, fullId, title, meta, status, statusLabel, statusNode, onClick,
}: {
  id: string; shortId: string; fullId?: string; title: string; meta: string;
  status: string; statusLabel: string; statusNode?: ReactNode; onClick?: () => void;
}) {
  const codeNode = (
    <code className="shrink-0 font-mono text-meta leading-5 text-text-tertiary">
      {shortId}
    </code>
  );

  return (
    <Card
      padded
      render={
        <button
          type="button"
          id={id}
          onClick={onClick}
          aria-labelledby={`${id}-title`}
          aria-describedby={`${id}-meta ${id}-status`}
        />
      }
      className="flex-row items-center gap-3 w-full flex-none cursor-pointer rounded-kit-card border border-border bg-surface px-4 py-3 text-left outline-none hover:border-border-strong hover:bg-surface-subtle focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span
        aria-hidden="true"
        className="hidden size-8 shrink-0 place-items-center rounded-tile border border-border bg-surface-subtle text-text-tertiary @[480px]:grid"
      >
        <Lightbulb size={16} strokeWidth={1.75} absoluteStrokeWidth />
      </span>
      <RecordListRowView as="span" className="gap-1">
        <span className="flex flex-col items-baseline gap-0.5 @[480px]:flex-row @[480px]:gap-3">
          {fullId && fullId !== shortId ? (
            <HintTooltip text={fullId}>{codeNode}</HintTooltip>
          ) : (
            codeNode
          )}
          <strong id={`${id}-title`} className="wrap-anywhere text-small leading-5 font-semibold text-foreground">
            {title}
          </strong>
        </span>
        <span id={`${id}-meta`} className="wrap-anywhere text-meta leading-4 text-text-secondary">
          {meta}
        </span>
      </RecordListRowView>
      <span id={`${id}-status`} className="shrink-0">
        {statusNode ?? <AXStatusBadgeView status={status} label={statusLabel} />}
      </span>
      <ChevronRight
        size={16}
        strokeWidth={1.75}
        absoluteStrokeWidth
        aria-hidden="true"
        className="hidden shrink-0 text-text-tertiary @[480px]:block"
      />
    </Card>
  );
}

export function AXBoardFooterContent({
  label, moreLabel, onMore,
}: {
  label: string; moreLabel?: string; onMore?: () => void;
}) {
  return (
    <div className="flex w-full flex-none items-center justify-between gap-3 text-meta leading-4 text-text-tertiary">
      <span>{label}</span>
      {moreLabel && (
        <Button variant="ghost" size="sm" onClick={onMore}>
          <ChevronDown size={14} strokeWidth={1.75} absoluteStrokeWidth aria-hidden="true" />
          {moreLabel}
        </Button>
      )}
    </div>
  );
}

export function AXBoardView({
  Surface, EmptyContainer, loading = false, observed = false, loadingSlot,
  error, errorTitle, retryLabel, onRetry, selectedContent, notFound = false,
  notFoundMessage, backLabel, onBack, filterLabel, filterValue, filterOptions,
  onFilterChange, searchPlaceholder, searchValue, onSearchChange, searchSlot,
  listRef, empty = false, emptyMessage, children, footer,
}: {
  Surface?: ComponentType<HTMLAttributes<HTMLElement> & { variant?: 'record' | 'issue' }>;
  EmptyContainer?: ComponentType<HTMLAttributes<HTMLElement>>;
  loading?: boolean; observed?: boolean; loadingSlot?: ReactNode;
  error?: string; errorTitle?: string; retryLabel?: string; onRetry?: () => void;
  selectedContent?: ReactNode; notFound?: boolean; notFoundMessage?: string;
  backLabel?: string; onBack?: () => void;
  filterLabel: string; filterValue: 'open' | 'closed';
  filterOptions: readonly SegmentedOption<'open' | 'closed'>[];
  onFilterChange?: (value: 'open' | 'closed') => void;
  searchPlaceholder: string; searchValue?: string; onSearchChange?: (value: string) => void;
  searchSlot?: ReactNode; listRef?: Ref<HTMLDivElement>;
  empty?: boolean; emptyMessage?: string; children?: ReactNode; footer?: ReactNode;
}) {
  const EmptyTag = EmptyContainer ?? 'div';
  const body = (
    <>
      {error && (
        <Notice
          tone="danger"
          title={errorTitle}
          action={retryLabel ? <Button size="sm" busy={loading} onClick={onRetry}>{retryLabel}</Button> : undefined}
        >
          {error}
        </Notice>
      )}

      {loading && !observed && loadingSlot}

      {selectedContent ? selectedContent : notFound ? (
        <EmptyTag className="center-empty grid place-content-center justify-items-center gap-3 pt-6 text-center">
          {backLabel && <Button size="sm" onClick={onBack}>{backLabel}</Button>}
          {notFoundMessage && <p role="status" className="m-0 text-small text-text-secondary">{notFoundMessage}</p>}
        </EmptyTag>
      ) : (
        <>
          <div className="flex flex-none flex-wrap items-center justify-between gap-3 @[480px]:flex-nowrap @[480px]:gap-6">
            <SegmentedControl
              size="sm"
              aria-label={filterLabel}
              disabled={loading && !observed}
              value={filterValue}
              options={filterOptions}
              onValueChange={onFilterChange}
              className="shrink-0"
            />
            {searchSlot ?? (
              <KitSearchInput
                placeholder={searchPlaceholder}
                value={searchValue}
                readOnly={!onSearchChange}
                onChange={onSearchChange ? (event) => onSearchChange(event.target.value) : undefined}
                className="w-full @[480px]:w-[240px] @[480px]:max-w-[45%]"
              />
            )}
          </div>

          <div ref={listRef} tabIndex={-1} className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto overscroll-contain outline-none">
            <div className="flex flex-none flex-col gap-2">
              {children}
              {empty && emptyMessage && (
                <EmptyTag role="status" className="center-empty grid place-content-center justify-items-center gap-3 pt-6 text-center text-text-tertiary">
                  <span aria-hidden="true" className="grid size-10 place-items-center rounded-tile border border-border bg-surface-subtle text-text-secondary">
                    <Inbox size={20} strokeWidth={1.75} absoluteStrokeWidth />
                  </span>
                  <p className="m-0 text-small leading-5 text-text-secondary">{emptyMessage}</p>
                </EmptyTag>
              )}
            </div>
          </div>

          {footer}
        </>
      )}
    </>
  );

  const surfaceClass = 'ax-panel @container flex min-h-0 min-w-0 flex-1 flex-col gap-5';
  if (Surface) {
    return <Surface variant="issue" className={surfaceClass} aria-busy={loading || undefined}>{body}</Surface>;
  }
  return <div className={surfaceClass} aria-busy={loading || undefined}>{body}</div>;
}
