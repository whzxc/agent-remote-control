import { Check, Copy, Globe, RotateCw, Terminal, Trash } from "lucide-react";
import { useId } from "react";
import { Notice } from "../components/kit/alert";
import { Badge } from "../components/kit/badge";
import { Button, IconButton } from "../components/kit/button";
import { Switch } from "../components/kit/switch";
import { HintTooltip } from "../components/kit/tooltip";
import { cn } from "../components/kit/utils";
import { useI18n } from "../i18n/react";
import { McpDisclosureView } from "./McpControlsView";

export type McpServerState =
  | "ready"
  | "idle"
  | "connecting"
  | "unchecked"
  | "failed"
  | "disabled";

export interface McpToolItem {
  name: string;
  description?: string;
  readOnly?: boolean;
  destructive?: boolean;
}

const statusTone = (state: McpServerState) =>
  state === "ready" || state === "idle"
    ? "success"
    : state === "failed"
      ? "danger"
      : state === "connecting"
        ? "warning"
        : "neutral";

export function McpToolRowView({ tool }: { tool: McpToolItem }) {
  const { t } = useI18n();
  return (
    <li className="mcp-tool grid min-w-0 gap-1 px-3.5 py-2.5">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <code className="font-mono text-small font-medium leading-4 text-foreground wrap-anywhere">
          {tool.name}
        </code>
        {tool.readOnly && (
          <Badge size="sm" tone="neutral">
            {t("mcp.readOnly")}
          </Badge>
        )}
        {tool.destructive && !tool.readOnly && (
          <Badge size="sm" tone="danger">
            {t("mcp.destructive")}
          </Badge>
        )}
      </div>
      {tool.description && (
        <p className="m-0 line-clamp-2 text-meta leading-4 text-text-secondary wrap-anywhere">
          {tool.description}
        </p>
      )}
    </li>
  );
}

export function McpServiceFailureView({
  title,
  detail,
  errorCode,
  copied = false,
  copyError,
  onCopyFix,
  className,
}: {
  title: string;
  detail: string;
  errorCode: string;
  copied?: boolean;
  copyError?: string;
  onCopyFix?: () => void;
  className?: string;
}) {
  const { t } = useI18n();

  return (
    <Notice
      layout="stacked"
      actionBelow
      tone="danger"
      title={title}
      className={cn("w-auto", className)}
      action={
        <Button variant="outline" size="sm" onClick={onCopyFix}>
          {copied ? (
            <Check size={14} strokeWidth={1.75} absoluteStrokeWidth aria-hidden="true" />
          ) : (
            <Copy size={14} strokeWidth={1.75} absoluteStrokeWidth aria-hidden="true" />
          )}
          <span>{t(copied ? "copied" : "mcp.copyFix")}</span>
        </Button>
      }
    >
      <div className="grid gap-1.5">
        <p className="m-0 text-small leading-5 text-foreground">{detail}</p>
        <code className="font-mono text-caption leading-4 text-text-secondary wrap-anywhere select-text">
          {errorCode}
        </code>
        {copyError && (
          <p className="m-0 text-meta leading-4 text-destructive" role="alert">
            {copyError}
          </p>
        )}
      </div>
    </Notice>
  );
}

export interface McpServiceCardViewProps {
  name: string;
  transport: "http" | "stdio";
  transportLabel?: string;
  target?: string | null;
  state: McpServerState;
  statusLabel?: string;
  enabled: boolean;
  toolCount?: number;
  matchedCount?: number;
  tools?: readonly McpToolItem[];
  expanded: boolean;
  facts?: readonly string[];
  checkedLabel?: string;
  observedAt?: string | null;
  failure?: {
    title: string;
    detail: string;
    code: string;
    copied?: boolean;
    copyError?: string;
    onCopyFix?: () => void;
  };
  busy?: boolean;
  refreshing?: boolean;
  onToggleExpand?: () => void;
  onRefresh?: () => void;
  onRemove?: () => void;
  onToggleEnabled?: (enabled: boolean) => void;
}

export function McpServiceCardView({
  name,
  transport,
  transportLabel,
  target,
  state,
  statusLabel,
  enabled,
  toolCount,
  matchedCount,
  tools = [],
  expanded,
  facts = [],
  checkedLabel,
  observedAt,
  failure,
  busy = false,
  refreshing = false,
  onToggleExpand,
  onRefresh,
  onRemove,
  onToggleEnabled,
}: McpServiceCardViewProps) {
  const { t } = useI18n();
  const headingId = useId();
  const toolsId = useId();
  const http = transport === "http";
  const TransportIcon = http ? Globe : Terminal;
  const resolvedTransport =
    transportLabel ?? t(http ? "mcp.transport.http" : "mcp.transport.stdio");
  const resolvedStatus = statusLabel ?? t(`mcp.state.${state}`);
  const disabledDim = !enabled || state === "disabled";
  const hasMeta =
    toolCount !== undefined || facts.length > 0 || Boolean(checkedLabel);

  return (
    <article
      data-state={state}
      data-transport={transport}
      aria-labelledby={headingId}
      className="mcp-server grid min-w-0 gap-3 rounded-kit-card border border-border bg-surface-subtle/60 p-4"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <span
          aria-hidden="true"
          className={cn(
            "grid size-9 shrink-0 place-items-center rounded-tile border border-border",
            http
              ? "bg-phase-command/14 text-phase-command"
              : "bg-phase-file/14 text-phase-file",
            disabledDim && "opacity-50",
          )}
        >
          <TransportIcon size={16} strokeWidth={1.75} absoluteStrokeWidth />
        </span>

        <div
          className={cn(
            "min-w-0 flex-1 basis-[180px]",
            disabledDim && "opacity-50",
          )}
        >
          <h3
            id={headingId}
            className="m-0 truncate text-body font-semibold leading-5 text-foreground"
          >
            {name}
          </h3>
          <p className="m-0 mt-0.5 flex min-w-0 items-center text-meta leading-4 text-text-secondary whitespace-pre">
            <span>{target ? `${resolvedTransport} · ` : resolvedTransport}</span>
            {target && (
              <HintTooltip text={target}>
                <span className="min-w-0 truncate font-mono">{target}</span>
              </HintTooltip>
            )}
          </p>
        </div>

        {!failure && (
          <Badge
            dot
            tone={statusTone(state)}
            className={cn(disabledDim && "opacity-55")}
          >
            {resolvedStatus}
          </Badge>
        )}

        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <IconButton
            compact
            icon={RotateCw}
            label={t("mcp.check", { name })}
            busy={refreshing}
            disabled={busy || !enabled}
            onClick={onRefresh}
          />
          <IconButton
            compact
            icon={Trash}
            label={t("mcp.remove", { name })}
            disabled={busy}
            onClick={onRemove}
          />
          <span className="ml-2 inline-flex shrink-0">
            <Switch
              aria-label={t("mcp.enable", { name })}
              checked={enabled}
              disabled={busy}
              onCheckedChange={(checked) => onToggleEnabled?.(checked)}
            />
          </span>
        </div>
      </div>

      {(failure || hasMeta || expanded) && (
        <div className="grid min-w-0 gap-2.5 pl-12 max-[540px]:pl-0">
          {hasMeta && (
            <div className="flex min-h-6 min-w-0 flex-wrap items-center gap-2.5 text-meta leading-4 text-text-secondary">
              {toolCount !== undefined &&
                !failure &&
                (toolCount > 0 ? (
                  <McpDisclosureView
                    expanded={expanded}
                    controls={toolsId}
                    onToggle={onToggleExpand}
                  >
                    {matchedCount !== undefined && matchedCount < toolCount
                      ? t("mcp.toolsMatched", {
                          count: matchedCount,
                          total: toolCount,
                        })
                      : t("mcp.tools", { count: toolCount })}
                  </McpDisclosureView>
                ) : (
                  <Badge size="sm" tone="neutral">
                    {t("mcp.noTools")}
                  </Badge>
                ))}
              {(facts.length > 0 || checkedLabel) && (
                <span className="wrap-anywhere">
                  {facts.join(" · ")}
                  {checkedLabel && (
                    <>
                      {facts.length > 0 && " · "}
                      <time dateTime={observedAt ?? undefined}>
                        {checkedLabel}
                      </time>
                    </>
                  )}
                </span>
              )}
            </div>
          )}

          {failure && (
            <McpServiceFailureView
              title={failure.title}
              detail={failure.detail}
              errorCode={failure.code}
              copied={failure.copied}
              copyError={failure.copyError}
              onCopyFix={failure.onCopyFix}
            />
          )}

          {expanded && tools.length > 0 && (
            <ul
              id={toolsId}
              aria-label={t("mcp.toolList")}
              className="mcp-tools m-0 grid list-none divide-y divide-border rounded-inset border border-border bg-surface p-0"
            >
              {tools.map((tool) => (
                <McpToolRowView key={tool.name} tool={tool} />
              ))}
            </ul>
          )}
        </div>
      )}
    </article>
  );
}
