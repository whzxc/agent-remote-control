import { Bot, ChevronRight, CircleAlert } from "lucide-react";
import type { ReactElement, ReactNode, RefObject } from "react";
import { useI18n } from "../../i18n/react";
import { Badge } from "../kit/badge";
import { Card } from "../kit/card";
import { Switch } from "../kit/switch";
import { HintTooltip } from "../kit/tooltip";
import { cn } from "../kit/utils";

export type QuotaTone = "success" | "warning" | "danger" | "muted";

const toneDotClass: Record<QuotaTone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  muted: "bg-text-tertiary",
};

export function AgentBrandGlyph({
  markup,
  icon,
  size = 28,
}: {
  markup?: string;
  icon?: ReactNode;
  size?: number;
}): ReactElement {
  return (
    <span
      className="inline-grid shrink-0 place-items-center text-foreground [&_svg]:block [&_svg]:size-full"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {icon ? (
        icon
      ) : markup ? (
        <span
          className="block size-full"
          dangerouslySetInnerHTML={{ __html: markup }}
        />
      ) : (
        <Bot
          size={Math.round(size * 0.72)}
          strokeWidth={1.75}
          absoluteStrokeWidth
        />
      )}
    </span>
  );
}

export interface AgentCardItem {
  id: string;
  title: string;
  link?: string;
  iconMarkup?: string;
  icon?: ReactNode;
  version?: string;
  metaText: string;
  enabled: boolean;
  switchDisabled?: boolean;
  quotaText?: string;
  quotaTooltip?: string;
  quotaTone?: QuotaTone;
  hardQuotaError?: boolean;
  statusText: string;
  adapterMessage?: string;
  adapterFailed?: boolean;
}

export interface AgentInventoryCardViewProps {
  agent: AgentCardItem;
  triggerRef?: RefObject<HTMLButtonElement | null>;
  onOpen?: () => void;
  onOpenLink?: (href: string) => void;
  onToggle?: (enabled: boolean) => void;
}

export function AgentInventoryCardView({
  agent,
  triggerRef,
  onOpen,
  onOpenLink,
  onToggle,
}: AgentInventoryCardViewProps): ReactElement {
  const { t } = useI18n();

  return (
    <Card
      render={
        <article
          onClick={(event) => {
            if (!(event.target as Element).closest("button, a")) {
              onOpen?.();
            }
          }}
        />
      }
      className="cursor-pointer gap-2.5 p-3.5 hover:border-border-strong"
    >
      <div className="flex items-center gap-3">
        <button
          ref={triggerRef}
          type="button"
          aria-label={agent.title}
          aria-haspopup="dialog"
          onClick={onOpen}
          className="inline-flex shrink-0 cursor-pointer items-center justify-center rounded-kit-field border-0 bg-transparent p-0 outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <AgentBrandGlyph
            markup={agent.iconMarkup}
            icon={agent.icon}
            size={28}
          />
        </button>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          {agent.link ? (
            <a
              href={agent.link}
              onClick={(event) => {
                event.preventDefault();
                onOpenLink?.(agent.link!);
              }}
              className="truncate text-body font-semibold leading-5 text-foreground no-underline hover:underline"
            >
              {agent.title}
            </a>
          ) : (
            <strong className="truncate text-body font-semibold leading-5 text-foreground">
              {agent.title}
            </strong>
          )}
          <HintTooltip text={agent.version || undefined}>
            <span className="truncate text-caption leading-4 text-text-secondary">
              {agent.metaText}
            </span>
          </HintTooltip>
        </div>
        <span onClick={(event) => event.stopPropagation()}>
          <Switch
            aria-label={t("allowConnectorToUseValue", { agent: agent.title })}
            checked={agent.enabled}
            disabled={agent.switchDisabled}
            onCheckedChange={(checked) => onToggle?.(checked)}
          />
        </span>
      </div>

      <div className="mt-auto flex items-center gap-2 border-t border-border pt-2 text-caption leading-4 text-text-secondary">
        {agent.quotaText && (
          <span
            className="inline-flex min-w-0 items-center gap-1.5 truncate tabular-nums"
            title={agent.quotaTooltip || agent.quotaText}
          >
            {agent.hardQuotaError ? (
              <CircleAlert
                size={12}
                strokeWidth={1.75}
                absoluteStrokeWidth
                aria-hidden="true"
                className="shrink-0 text-danger"
              />
            ) : (
              <span
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  toneDotClass[agent.quotaTone ?? "muted"],
                )}
                aria-hidden="true"
              />
            )}
            <span className="truncate">{agent.quotaText}</span>
          </span>
        )}
        <Badge
          size="sm"
          tone="neutral"
          className="ml-auto max-w-[55%] truncate"
        >
          <span className="truncate">{agent.statusText}</span>
        </Badge>
        <ChevronRight
          size={14}
          strokeWidth={1.75}
          absoluteStrokeWidth
          aria-hidden="true"
          className="shrink-0 text-text-tertiary"
        />
      </div>

      {agent.adapterMessage && (
        <p
          className="m-0 truncate text-caption leading-4 text-text-secondary"
          role={agent.adapterFailed ? "alert" : "status"}
        >
          {agent.adapterMessage}
        </p>
      )}
    </Card>
  );
}
