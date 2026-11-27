import {
  Accessibility,
  Bell,
  Check,
  Circle,
  HardDrive,
  LogIn,
  Monitor,
  Terminal,
  type LucideIcon,
} from "lucide-react";
import type { ReactElement } from "react";
import { useI18n } from "../../i18n/react";
import { Badge } from "../kit/badge";
import { Button } from "../kit/button";
import { Card } from "../kit/card";
import { HintTooltip } from "../kit/tooltip";
import { cn } from "../kit/utils";

export type PermissionId =
  | "accessibility"
  | "screen-recording"
  | "full-disk-access"
  | "notifications"
  | "login-start"
  | "codex"
  | "claude-code";

export type PermissionRowState =
  | "granted"
  | "missing"
  | "unknown"
  | "not-applicable";

export interface PermissionRowItem {
  id: PermissionId | string;
  state: PermissionRowState | string;
  system: boolean;
  diskMismatch?: boolean;
}

const permissionIcons: Record<string, LucideIcon> = {
  accessibility: Accessibility,
  "screen-recording": Monitor,
  "full-disk-access": HardDrive,
  notifications: Bell,
  "login-start": LogIn,
  codex: Monitor,
  "claude-code": Terminal,
};

export interface PermissionRowViewProps {
  item: PermissionRowItem;
  actionDisabled?: boolean;
  onAction?: (id: string) => void;
  className?: string;
}

export function PermissionRowView({
  item,
  actionDisabled = false,
  onAction,
  className,
}: PermissionRowViewProps): ReactElement {
  const { t } = useI18n();
  const IconComponent = permissionIcons[item.id] ?? Circle;
  const ready = item.state === "granted";
  const missing = item.state === "missing";
  const authorization = item.system && item.id !== "login-start";
  const statusKey =
    item.state === "unknown"
      ? "permissionState.unknown"
      : ready
        ? authorization
          ? "permissionsGranted"
          : "permissionState.granted"
        : authorization
          ? "permissionsNotGranted"
          : "permissionState.missing";
  const actionKey = item.system
    ? item.id === "login-start"
      ? "permissionsEnable"
      : "permissionsGrant"
    : "permissionsInstructions";

  return (
    <div
      className={cn(
        "grid min-w-0 grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 max-[600px]:grid-cols-[20px_minmax(0,1fr)] max-[600px]:gap-y-2",
        className,
      )}
    >
      <HintTooltip text={t(`permissionTools.${item.id}`)}>
        <span
          tabIndex={0}
          className="inline-flex size-5 items-center justify-center text-text-secondary outline-none focus-visible:rounded-badge focus-visible:ring-2 focus-visible:ring-ring"
        >
          <IconComponent
            size={18}
            strokeWidth={1.75}
            absoluteStrokeWidth
            aria-hidden="true"
          />
        </span>
      </HintTooltip>
      <div className="min-w-0">
        <h3 className="m-0 text-small font-semibold leading-5 text-foreground">
          {t(`permission.${item.id}`)}
        </h3>
        <p className="mt-0.5 mb-0 text-meta leading-[var(--line-description)] text-text-secondary">
          {t(`permissionUse.${item.id}`)}
        </p>
        {item.diskMismatch && (
          <p className="mt-1 mb-0 text-meta leading-4 text-warning">
            {t("permissionsDiskMismatch")}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2 max-[600px]:col-start-2 max-[600px]:justify-between">
        <Badge
          tone={ready ? "success" : missing ? "warning" : "neutral"}
          size="default"
        >
          {ready ? (
            <Check size={12} strokeWidth={2} aria-hidden="true" />
          ) : (
            <Circle size={8} strokeWidth={2} aria-hidden="true" />
          )}
          <span>{t(statusKey)}</span>
        </Badge>
        {!ready && (
          <Button
            size="sm"
            variant="secondary"
            disabled={actionDisabled}
            onClick={() => onAction?.(item.id)}
          >
            {t(actionKey)}
          </Button>
        )}
      </div>
    </div>
  );
}

export interface PermissionsPageViewProps {
  showSystem?: boolean;
  appName?: string;
  items: readonly PermissionRowItem[];
  busy?: boolean;
  desktopAvailable?: boolean;
  onAction?: (id: string) => void;
}

export function PermissionsPageView({
  showSystem = false,
  appName = "Agent Remote Control",
  items,
  busy = false,
  desktopAvailable = true,
  onAction,
}: PermissionsPageViewProps): ReactElement {
  const { t } = useI18n();
  const systemItems = items.filter((item) => item.system);
  const envItems = items.filter((item) => !item.system);

  return (
    <div className="permissions-page flex min-w-0 flex-col gap-5">
      {showSystem && systemItems.length > 0 && (
        <section className="flex min-w-0 flex-col gap-2">
          <div className="flex flex-col gap-0.5">
            <h2 className="m-0 text-meta font-semibold leading-4 text-text-secondary">
              {t("permissionsSystem")}
            </h2>
            <p className="m-0 text-meta leading-4 text-text-tertiary">
              {t("permissionsAppHint", { app: appName })}
            </p>
          </div>
          <Card className="gap-0 divide-y divide-border overflow-hidden p-0">
            {systemItems.map((item) => (
              <PermissionRowView
                key={item.id}
                item={item}
                actionDisabled={busy || !desktopAvailable}
                onAction={onAction}
              />
            ))}
          </Card>
        </section>
      )}
      {envItems.length > 0 && (
        <section className="flex min-w-0 flex-col gap-2">
          <h2 className="m-0 text-meta font-semibold leading-4 text-text-secondary">
            {t("permissionsEnvironment")}
          </h2>
          <Card className="gap-0 divide-y divide-border overflow-hidden p-0">
            {envItems.map((item) => (
              <PermissionRowView
                key={item.id}
                item={item}
                actionDisabled={busy}
                onAction={onAction}
              />
            ))}
          </Card>
        </section>
      )}
    </div>
  );
}
