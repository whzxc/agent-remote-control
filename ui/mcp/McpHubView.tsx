import { Plug, Plus, RotateCw } from "lucide-react";
import type { ReactNode } from "react";
import { Notice } from "../components/kit/alert";
import { Button, IconButton } from "../components/kit/button";
import { SearchInput } from "../components/kit/input";
import { Spinner } from "../components/kit/spinner";
import { useI18n } from "../i18n/react";
import { McpImportPromptView } from "./McpImportDialogView";

export interface McpHubSummary {
  total: number;
  available: number;
  failed: number;
  tools: number;
}

export function McpHubStatsView({ summary }: { summary: McpHubSummary }) {
  const { t } = useI18n();
  if (summary.total <= 0) return null;

  return (
    <p className="m-0 ml-4 flex-1 truncate text-meta leading-4 text-text-secondary">
      {`${t("mcp.serverCount", { count: summary.total })} · ${t("mcp.availableCount", { count: summary.available })}`}
      {summary.failed > 0 && (
        <>
          {" · "}
          <span className="font-medium text-danger">
            {t("mcp.failedCount", { count: summary.failed })}
          </span>
        </>
      )}
      {` · ${t("mcp.toolTotal", { count: summary.tools })}`}
    </p>
  );
}

export function McpHubActionsView({
  reading = false,
  busy = false,
  onAdd,
  onRefresh,
}: {
  reading?: boolean;
  busy?: boolean;
  onAdd?: () => void;
  onRefresh?: () => void;
}) {
  const { t } = useI18n();
  return (
    <>
      <Button
        variant="primary"
        size="sm"
        disabled={reading || busy}
        onClick={onAdd}
      >
        <Plus size={14} strokeWidth={1.75} absoluteStrokeWidth aria-hidden="true" />
        <span>{t("mcp.add")}</span>
      </Button>
      <IconButton
        compact
        icon={RotateCw}
        label={t("refresh")}
        busy={reading && !busy}
        disabled={busy}
        onClick={onRefresh}
      />
    </>
  );
}

export interface McpHubViewProps {
  loaded: boolean;
  hasServers: boolean;
  visibleCount: number;
  query: string;
  busy?: boolean;
  reading?: boolean;
  error?: string;
  searchSlot?: ReactNode;
  importCopied?: boolean;
  importCopyError?: string;
  onCopyImportPrompt?: (text: string) => void;
  onQueryChange?: (query: string) => void;
  onRetry?: () => void;
  children?: ReactNode;
}

export function McpHubView({
  loaded,
  hasServers,
  visibleCount,
  query,
  busy = false,
  reading = false,
  error,
  searchSlot,
  importCopied = false,
  importCopyError,
  onCopyImportPrompt,
  onQueryChange,
  onRetry,
  children,
}: McpHubViewProps) {
  const { t } = useI18n();

  return (
    <main
      data-slot="mcp-content"
      className="flex min-h-0 flex-col gap-5"
      aria-busy={reading || busy}
    >
      {error && (
        <Notice
          tone="danger"
          action={
            !loaded &&
            onRetry && (
              <Button variant="outline" size="sm" busy={reading} onClick={onRetry}>
                {t("retry")}
              </Button>
            )
          }
        >
          {error}
        </Notice>
      )}

      {!loaded ? (
        !error && (
          <div className="flex items-center justify-center gap-2 py-8 text-small text-text-secondary">
            <Spinner size={16} />
            <span>{t("loading")}</span>
          </div>
        )
      ) : hasServers ? (
        <>
          {searchSlot ?? (
            <SearchInput
              className="w-full"
              value={query}
              placeholder={t("mcp.search")}
              readOnly={!onQueryChange}
              onChange={(event) => onQueryChange?.(event.target.value)}
            />
          )}
          <div data-slot="mcp-servers" className="grid gap-3.5">{children}</div>
          {visibleCount === 0 && (
            <p
              className="m-0 py-12 text-center text-small text-text-secondary"
              role="status"
            >
              {t("mcp.noMatch")}
            </p>
          )}
        </>
      ) : (
        <section
          className="flex min-w-0 flex-col items-center pt-8 text-center"
          aria-labelledby="mcp-empty-title"
        >
          <span
            aria-hidden="true"
            className="grid size-10 place-items-center rounded-tile border border-border bg-surface-subtle text-text-secondary"
          >
            <Plug size={18} strokeWidth={1.75} absoluteStrokeWidth />
          </span>
          <h3
            id="mcp-empty-title"
            className="m-0 mt-4 text-title font-semibold leading-6 text-foreground"
          >
            {t("mcp.emptyTitle")}
          </h3>
          <p className="m-0 mt-2 text-small leading-5 text-text-secondary">
            {t("mcp.empty")}
          </p>
          <McpImportPromptView
            actionBelow
            copied={importCopied}
            copyError={importCopyError}
            onCopyText={onCopyImportPrompt}
            className="mt-6"
          />
        </section>
      )}
    </main>
  );
}
