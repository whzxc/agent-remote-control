import { Plus, RefreshCw, Settings } from 'lucide-react';
import type { ComponentType, HTMLAttributes, ReactNode } from 'react';
import { Notice } from './kit/alert';
import { Button, IconButton } from './kit/button';
import { Card } from './kit/card';
import { Loading } from './kit/spinner';

type SectionWrapperProps = HTMLAttributes<HTMLElement> & {
  as?: 'div' | 'section' | 'article' | 'li';
};

export function AgentPlatformHeaderView({
  brandSlot, title, addAccountLabel, onAddAccount, widthControl, closeAction,
}: {
  brandSlot: ReactNode; title: string; addAccountLabel?: string;
  onAddAccount?: () => void; widthControl?: ReactNode; closeAction?: ReactNode;
}) {
  return (
    <header className="dialog-header agent-panel-header flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-5 py-3.5">
      {brandSlot}
      <div className="agent-panel-heading min-w-0 flex-1">
        <h2 className="m-0 truncate text-[15px] font-semibold leading-5 tracking-[-0.01em] text-foreground">
          {title}
        </h2>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        {addAccountLabel && (
          <Button size="sm" variant="outline" data-add-agent-account onClick={onAddAccount}>
            <Plus size={14} strokeWidth={1.75} absoluteStrokeWidth aria-hidden="true" />
            {addAccountLabel}
          </Button>
        )}
        {widthControl}
        {closeAction}
      </div>
    </header>
  );
}

export function AgentPlatformContentView({
  SectionWrapper, NativeCardWrapper, header, loading = false, loadingLabel,
  error, retryLabel, onRetry, hasAccounts = false, canLogin = false,
  emptyMessage, nativeStatusMessage, refreshAgentsLabel, settingsLabel,
  refreshingNative = false, onRefreshNative, onSettings, children,
}: {
  SectionWrapper?: ComponentType<SectionWrapperProps>;
  NativeCardWrapper?: ComponentType<HTMLAttributes<HTMLElement>>;
  header: ReactNode; loading?: boolean; loadingLabel?: string;
  error?: string; retryLabel?: string; onRetry?: () => void;
  hasAccounts?: boolean; canLogin?: boolean; emptyMessage?: string;
  nativeStatusMessage?: string; refreshAgentsLabel?: string; settingsLabel?: string;
  refreshingNative?: boolean; onRefreshNative?: () => void; onSettings?: () => void;
  children?: ReactNode;
}) {
  const NativeCard = NativeCardWrapper ?? Card;
  const body = (
    <>
      {header}
      <div className="agent-view-scroll flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto" aria-busy={loading || undefined}>
        {error && (
          <Notice
            tone="danger"
            action={retryLabel ? <Button size="sm" onClick={onRetry}>{retryLabel}</Button> : undefined}
          >
            {error}
          </Notice>
        )}
        {loading && !hasAccounts && <Loading label={loadingLabel} />}
        {children}
        {!hasAccounts && !error && !loading && (
          canLogin ? (
            <p className="m-0 py-8 text-center text-small text-text-secondary">
              {emptyMessage}
            </p>
          ) : (
            <NativeCard className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-4 rounded-kit-card border border-border bg-surface p-4">
              <p className="m-0 text-small leading-5 text-text-secondary">{nativeStatusMessage}</p>
              <div className="flex shrink-0 items-center gap-1">
                {refreshAgentsLabel && (
                  <IconButton compact icon={RefreshCw} label={refreshAgentsLabel} busy={refreshingNative} onClick={onRefreshNative} />
                )}
                {settingsLabel && (
                  <IconButton compact icon={Settings} label={settingsLabel} disabled={refreshingNative} onClick={onSettings} />
                )}
              </div>
            </NativeCard>
          )
        )}
      </div>
    </>
  );

  const sectionClass = 'agent-panel-layer agent-platform-view flex min-h-0 flex-1 flex-col';
  if (SectionWrapper) {
    return <SectionWrapper as="section" className={sectionClass}>{body}</SectionWrapper>;
  }
  return <section className={sectionClass}>{body}</section>;
}
