import { RefreshCw } from "lucide-react";
import { useI18n } from "../../i18n/react";
import { Notice } from "../kit/alert";
import { Badge } from "../kit/badge";
import { Button, IconButton } from "../kit/button";
import { Spinner } from "../kit/spinner";
import { HintTooltip } from "../kit/tooltip";
import { DataTable } from "./DataTable";

export interface RelayMemberRow {
  id: string;
  name: string;
  isSelf: boolean;
  online: boolean;
  joinedAt: string;
  joinedLabel: string;
  lastOnline: string | null;
  lastSeenLabel: string;
}

export interface RelayDevicesTableViewProps {
  members: readonly RelayMemberRow[];
  loading?: boolean;
  error?: string;
  disabled?: boolean;
  onRefresh?: () => void;
  onRemove?: (member: RelayMemberRow) => void;
}

export function RelayDevicesTableView({
  members,
  loading = false,
  error,
  disabled = false,
  onRefresh,
  onRemove,
}: RelayDevicesTableViewProps) {
  const { t } = useI18n();

  return (
    <section className="hosted-relay-devices grid gap-3">
      <div className="hosting-section-heading flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="m-0 text-body font-semibold leading-5 text-foreground">
            {t("hosting.devices")}
          </h3>
          <p className="mt-1 text-small leading-5 text-text-secondary">
            {t("hosting.devicesDescription")}
          </p>
        </div>
        <IconButton
          icon={RefreshCw}
          label={t("hosting.refreshDevices")}
          busy={loading}
          disabled={disabled}
          onClick={onRefresh}
        />
      </div>
      {error && <Notice tone="danger">{error}</Notice>}
      <div
        className="hosted-relay-table overflow-hidden rounded-kit-card border border-border bg-surface"
        aria-busy={loading}
      >
        <DataTable
          rows={[...members]}
          empty={
            loading ? (
              <div className="flex items-center justify-center py-4">
                <Spinner size={16} />
              </div>
            ) : error ? (
              <span className="text-small text-text-secondary">
                {t("connect.membersFailed")}
              </span>
            ) : (
              <span className="text-small text-text-secondary">
                {t("hosting.noDevices")}
              </span>
            )
          }
          columns={[
            {
              key: "device",
              title: t("hosting.device"),
              width: 180,
              render: (member) => (
                <div className="hosted-relay-device flex min-w-0 items-center gap-2">
                  <span
                    className={`size-2 shrink-0 rounded-full ${member.online ? "bg-success" : "bg-text-tertiary"}`}
                    aria-hidden="true"
                  />
                  <span className="sr-only">
                    {t(member.online ? "connect.online" : "connect.offline")}
                  </span>
                  <HintTooltip text={member.name}>
                    <span className="hosted-relay-device-name truncate text-small text-foreground">
                      {member.name}
                    </span>
                  </HintTooltip>
                  {member.isSelf && (
                    <Badge size="sm" tone="neutral" className="hosted-relay-self">
                      {t("hosting.self")}
                    </Badge>
                  )}
                </div>
              ),
            },
            {
              key: "joined",
              title: t("hosting.joined"),
              width: 100,
              render: (member) => (
                <time
                  className="whitespace-nowrap text-small tabular-nums text-text-secondary"
                  dateTime={member.joinedAt}
                >
                  {member.joinedLabel}
                </time>
              ),
            },
            {
              key: "seen",
              title: t("hosting.lastSeen"),
              width: 100,
              render: (member) =>
                member.lastOnline ? (
                  <time
                    className="whitespace-nowrap text-small tabular-nums text-text-secondary"
                    dateTime={member.lastOnline}
                  >
                    {member.lastSeenLabel}
                  </time>
                ) : (
                  <span className="text-small text-text-secondary">
                    {t("connect.neverOnline")}
                  </span>
                ),
            },
            {
              key: "actions",
              title: <span className="sr-only">{t("hosting.actions")}</span>,
              width: 80,
              align: "right",
              render: (member) =>
                !member.isSelf && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={disabled}
                    onClick={() => onRemove?.(member)}
                  >
                    {t("hosting.remove")}
                  </Button>
                ),
            },
          ]}
        />
      </div>
    </section>
  );
}
