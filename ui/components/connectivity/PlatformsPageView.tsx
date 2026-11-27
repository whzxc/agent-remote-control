import type { ReactElement, ReactNode } from "react";
import { Alert } from "../kit/alert";
import { Button } from "../kit/button";
import { Empty } from "../kit/empty";
import { Loading } from "../kit/spinner";
import { Tabs, TabsList, TabsTab } from "../kit/tabs";
import { cn } from "../kit/utils";

export interface PlatformNavItem {
  id: string;
  label: string;
  icon: ReactNode;
}

export interface PlatformsPageViewProps {
  platforms: readonly PlatformNavItem[];
  activePlatform: string;
  onSelectPlatform?: (platformId: string) => void;
  navLabel: string;
  title: string;
  addAction?: ReactNode;
  error?: string;
  retryLabel?: string;
  onRetry?: () => void;
  loading?: boolean;
  loadingLabel?: string;
  emptyMessage?: string;
  children?: ReactNode;
  renderSection?: (content: ReactNode) => ReactNode;
  className?: string;
}

export function PlatformsPageView({
  platforms,
  activePlatform,
  onSelectPlatform,
  navLabel,
  title,
  addAction,
  error,
  retryLabel,
  onRetry,
  loading = false,
  loadingLabel,
  emptyMessage,
  children,
  renderSection,
  className,
}: PlatformsPageViewProps): ReactElement {
  const hasEntries =
    Array.isArray(children) ? children.length > 0 : Boolean(children);

  const mainContent = (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-5">
      <header className="flex min-h-(--kit-control-height) flex-wrap items-center justify-between gap-3">
        <h2 className="m-0 text-title leading-6 font-semibold text-foreground">
          {title}
        </h2>
        {addAction && <div className="flex items-center gap-2">{addAction}</div>}
      </header>
      <div
        className="flex min-w-0 flex-1 flex-col gap-3"
        aria-busy={loading && !error ? true : undefined}
      >
        {error && (
          <Alert
            tone="danger"
            action={
              onRetry && retryLabel ? (
                <Button size="sm" onClick={onRetry}>
                  {retryLabel}
                </Button>
              ) : undefined
            }
          >
            {error}
          </Alert>
        )}
        {hasEntries
          ? children
          : !error &&
            (loading ? (
              <Loading label={loadingLabel} />
            ) : emptyMessage ? (
              <Empty className="flex-1">{emptyMessage}</Empty>
            ) : null)}
      </div>
    </div>
  );

  return (
    <Tabs
      orientation="vertical"
      value={activePlatform}
      onValueChange={(next) => {
        if (typeof next === "string") onSelectPlatform?.(next);
      }}
      className={cn(
        "grid min-h-0 flex-1 grid-cols-[216px_minmax(0,1fr)] gap-6 max-[600px]:grid-cols-[minmax(132px,1fr)_minmax(0,2fr)] max-[600px]:gap-4",
        className,
      )}
    >
      <nav
        aria-label={navLabel}
        className="min-h-0 self-start overflow-y-auto"
      >
        <TabsList
          aria-label={navLabel}
          className="w-full gap-0.5 rounded-kit-card! border border-border bg-surface-subtle p-1"
        >
          {platforms.map((item) => (
            <TabsTab
              key={item.id}
              value={item.id}
              className="h-9 gap-2.5 rounded-kit-field! px-2.5 text-small"
            >
              <span className="flex size-5 shrink-0 items-center justify-center [&_.source-icon]:size-5 [&_.source-icon>span]:size-5 [&_.source-icon_svg]:size-5">
                {item.icon}
              </span>
              <span className="truncate">{item.label}</span>
            </TabsTab>
          ))}
        </TabsList>
      </nav>
      {renderSection ? (
        renderSection(mainContent)
      ) : (
        <section
          aria-label={title}
          className="flex min-h-0 min-w-0 flex-col overflow-y-auto"
        >
          {mainContent}
        </section>
      )}
    </Tabs>
  );
}
