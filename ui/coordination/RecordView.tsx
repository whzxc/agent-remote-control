import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';
import { Card } from '../components/kit/card';
import { cn } from '../components/kit/utils';

type BlockProps = HTMLAttributes<HTMLElement> & {
  as?: 'div' | 'span' | 'section' | 'footer' | 'details' | 'li';
  variant?: 'record' | 'issue';
};

export function RecordCardView({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card
      className={cn(
        'record-row flex-row items-center gap-3.5 min-h-[58px] w-full rounded-kit-card border border-border bg-surface px-4 py-3 text-left font-normal whitespace-normal',
        className,
      )}
    >
      {children}
    </Card>
  );
}

export function RecordRowView({
  children,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <Card
      render={<button type="button" {...props} />}
      className={cn(
        'record-row flex-row items-center gap-3.5 min-h-[58px] w-full cursor-pointer rounded-kit-card border border-border bg-surface px-4 py-3 text-left font-normal whitespace-normal outline-none hover:border-border-strong hover:bg-surface-subtle focus-visible:ring-2 focus-visible:ring-ring aria-expanded:border-border-strong aria-expanded:bg-surface-subtle',
        className,
      )}
    >
      {children}
    </Card>
  );
}

export function RecordMetaView({
  as: Element = 'span',
  className,
  ...props
}: HTMLAttributes<HTMLElement> & { as?: 'span' | 'div' }) {
  return (
    <Element
      {...props}
      className={cn(
        'record-row-meta flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5 text-meta leading-4 text-text-secondary [&_time]:whitespace-nowrap',
        className,
      )}
    />
  );
}

export function RecordHeadingView({
  count,
  children,
  attention,
  note,
  className,
}: {
  count?: number;
  children: ReactNode;
  attention?: boolean;
  note?: ReactNode;
  className?: string;
}) {
  return (
    <h2
      className={cn(
        'record-heading my-1 flex flex-wrap items-center gap-1.5 text-meta leading-4 font-semibold',
        attention ? 'text-warning' : 'text-text-secondary',
        className,
      )}
      data-attention={attention || undefined}
    >
      {children}
      {count !== undefined && count > 0 && (
        <span className="record-count font-normal tabular-nums text-text-tertiary">
          {count}
        </span>
      )}
      {note && (
        <span role="status" className="record-note ml-1 font-normal text-text-secondary">
          · {note}
        </span>
      )}
    </h2>
  );
}

export function RecordListRowView({
  as: Element = 'div',
  className,
  ...props
}: BlockProps) {
  return (
    <Element
      {...props}
      className={cn('ax-row-body flex min-w-0 flex-1 flex-col gap-1', className)}
    />
  );
}

export function RecordFooterView({
  as: Element = 'footer',
  variant = 'record',
  className,
  ...props
}: BlockProps) {
  return (
    <Element
      {...props}
      className={cn(
        variant === 'issue'
          ? 'ax-footer flex flex-none items-center justify-between text-meta leading-4 text-text-tertiary'
          : 'center-footer flex w-full flex-none flex-wrap items-baseline gap-x-3 gap-y-1 text-meta leading-4 text-text-tertiary',
        className,
      )}
    />
  );
}

export function RecordDisclosureView({
  className,
  ...props
}: HTMLAttributes<HTMLDetailsElement>) {
  return (
    <details
      {...props}
      className={cn('center-technical text-meta', className)}
    />
  );
}

export function RecordEventView({
  className,
  ...props
}: HTMLAttributes<HTMLLIElement>) {
  return (
    <li
      {...props}
      className={cn(
        'center-event relative grid gap-1 py-2.5 pl-[22px] text-small leading-5',
        className,
      )}
    />
  );
}
