import { ChevronDown, Inbox } from 'lucide-react';
import type { ComponentType, HTMLAttributes, ReactNode } from 'react';
import { Notice } from '../components/kit/alert';
import { Button } from '../components/kit/button';
import { SegmentedControl, type SegmentedOption } from '../components/kit/segmented-control';
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '../components/kit/select';
import { cn } from '../components/kit/utils';
import { RecordDisclosureView, RecordFooterView } from './RecordView';

export interface BoardResourceOption {
  value: string;
  label: string;
}

export function BoardViewNavigation<Value extends string>({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: Value;
  options: readonly SegmentedOption<Value>[];
  disabled?: boolean;
  onChange?: (value: Value) => void;
}) {
  return (
    <div className="min-w-0 flex-1">
      <SegmentedControl
        aria-label={label}
        value={value}
        options={options}
        disabled={disabled}
        onValueChange={onChange}
      />
    </div>
  );
}

export function BoardFiltersView<FilterValue extends string>({
  showFilter = true,
  filterLabel,
  filterValue,
  filterOptions,
  onFilterChange,
  resourceLabel,
  resourceValue,
  resourceOptions,
  onResourceChange,
  disabled,
}: {
  showFilter?: boolean;
  filterLabel?: string;
  filterValue?: FilterValue;
  filterOptions?: readonly SegmentedOption<FilterValue>[];
  onFilterChange?: (value: FilterValue) => void;
  resourceLabel: string;
  resourceValue: string;
  resourceOptions: readonly BoardResourceOption[];
  onResourceChange?: (value: string) => void;
  disabled?: boolean;
}) {
  const selectedResource =
    resourceOptions.find((option) => option.value === resourceValue)?.label ??
    resourceOptions[0]?.label ??
    resourceValue;

  return (
    <div className="flex flex-none flex-wrap items-center gap-2.5 @[0px]:max-[480px]:flex-nowrap">
      {showFilter && filterOptions && filterValue !== undefined && (
        <SegmentedControl
          size="sm"
          aria-label={filterLabel}
          value={filterValue}
          options={filterOptions}
          disabled={disabled}
          onValueChange={onFilterChange}
          className="max-w-full"
        />
      )}
      <div className="flex min-w-0 max-w-full">
        <Select
          value={resourceValue}
          onValueChange={(next) => {
            if (typeof next === 'string') onResourceChange?.(next);
          }}
          disabled={disabled}
        >
          <SelectTrigger size="sm" aria-label={resourceLabel} className="max-w-full">
            <SelectValue>{selectedResource}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {resourceOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
    </div>
  );
}

export function BoardFeedbackView({
  tone = 'danger',
  title,
  detail,
  actionLabel,
  actionBusy,
  actionDisabled,
  onAction,
}: {
  tone?: 'danger' | 'warning';
  title?: string;
  detail: string;
  actionLabel?: string;
  actionBusy?: boolean;
  actionDisabled?: boolean;
  onAction?: () => void;
}) {
  return (
    <Notice
      tone={tone}
      title={title}
      actionBelow={Boolean(title)}
      action={
        actionLabel ? (
          <Button size="sm" busy={actionBusy} disabled={actionDisabled} onClick={onAction}>
            {actionLabel}
          </Button>
        ) : undefined
      }
    >
      <p className="m-0">{detail}</p>
    </Notice>
  );
}

export function BoardFooterView({
  observedLabel,
  coverageLabel,
  coverageWarning,
  coverageSummaryLabel,
  coverageJson,
}: {
  observedLabel: string;
  coverageLabel?: string;
  coverageWarning?: boolean;
  coverageSummaryLabel?: string;
  coverageJson?: string;
}) {
  return (
    <RecordFooterView>
      <span>{observedLabel}</span>
      {coverageLabel && (
        <span
          data-tone={coverageWarning ? 'warning' : undefined}
          className={coverageWarning ? 'text-warning' : undefined}
        >
          {coverageLabel}
        </span>
      )}
      {coverageSummaryLabel && coverageJson && (
        <RecordDisclosureView className="m-0 open:basis-full">
          <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-disclosure text-text-tertiary hover:text-text-secondary [&::-webkit-details-marker]:hidden">
            <ChevronDown
              size={14}
              strokeWidth={1.75}
              absoluteStrokeWidth
              aria-hidden="true"
              className="icon"
            />
            {coverageSummaryLabel}
          </summary>
          <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap wrap-anywhere rounded-tile border border-border bg-surface-subtle p-2.5 font-mono text-meta text-foreground">
            {coverageJson}
          </pre>
        </RecordDisclosureView>
      )}
    </RecordFooterView>
  );
}

export function BoardEmptyView({
  EmptyContainer,
  message,
}: {
  EmptyContainer?: ComponentType<HTMLAttributes<HTMLElement>>;
  message: string;
}) {
  const Container = EmptyContainer ?? 'div';
  return (
    <Container
      role="status"
      className="center-empty grid min-h-0 place-content-center justify-items-center gap-3 pt-6 text-center text-text-tertiary"
    >
      <span
        aria-hidden="true"
        className="grid size-10 place-items-center rounded-tile border border-border bg-surface-subtle text-text-secondary"
      >
        <Inbox size={20} strokeWidth={1.75} absoluteStrokeWidth />
      </span>
      <p className="m-0 text-small leading-5 text-text-secondary">{message}</p>
    </Container>
  );
}

export function CoordinationBoardView({
  Surface,
  EmptyContainer,
  busy = false,
  filters,
  resourceError,
  notice,
  detail,
  empty = false,
  emptyMessage,
  moreActions,
  children,
}: {
  Surface?: ComponentType<HTMLAttributes<HTMLElement>>;
  EmptyContainer?: ComponentType<HTMLAttributes<HTMLElement>>;
  busy?: boolean;
  filters?: ReactNode;
  resourceError?: string;
  notice?: ReactNode;
  detail?: ReactNode;
  empty?: boolean;
  emptyMessage?: string;
  moreActions?: ReactNode;
  children?: ReactNode;
}) {
  const hasDetail = Boolean(detail);
  const SurfaceTag = Surface ?? 'div';
  return (
    <SurfaceTag
      className="coordination-center @container flex min-h-0 min-w-0 w-full flex-col gap-4"
      aria-busy={busy || undefined}
    >
      {filters}
      {resourceError && (
        <p role="status" className="m-0 text-meta text-text-secondary">
          {resourceError}
        </p>
      )}
      {notice}
      <div
        className={cn(
          'min-h-0 flex-1 overflow-auto overscroll-contain',
          hasDetail &&
            '@[680px]:grid @[680px]:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] @[680px]:gap-5 @[680px]:overflow-hidden',
        )}
      >
        {detail}
        <div
          data-empty={empty || undefined}
          className={cn(
            'flex flex-col gap-5',
            empty && 'grid h-full',
            hasDetail &&
              'hidden @[680px]:col-start-1 @[680px]:row-start-1 @[680px]:flex @[680px]:min-h-0 @[680px]:overflow-auto',
          )}
        >
          {children}
          {empty && emptyMessage && (
            <BoardEmptyView EmptyContainer={EmptyContainer} message={emptyMessage} />
          )}
          {moreActions && (
            <div className="my-2 flex flex-wrap justify-center gap-2 empty:hidden">
              {moreActions}
            </div>
          )}
        </div>
      </div>
    </SurfaceTag>
  );
}
