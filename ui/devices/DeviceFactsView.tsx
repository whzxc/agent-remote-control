import { ChevronRight, Laptop, Monitor, Pencil, Server, Unlink } from "lucide-react";
import { Notice } from "../components/kit/alert";
import { Badge } from "../components/kit/badge";
import { Button, IconButton } from "../components/kit/button";
import { Card } from "../components/kit/card";
import { cn } from "../components/kit/utils";
import { useI18n } from "../i18n/react";

export interface DeviceSummary {
  id: string;
  name: string;
  platform: string | null;
  arch: string | null;
  arcVersion: string | null;
  state: "online" | "offline";
  path: "lan" | "tunnel";
  latency: number | null;
  addresses: readonly string[];
  tunnelUrl: string | null;
  addressOverride: string | null;
  error?: string | null;
  capabilities: { tools: string[]; screen: boolean } | null;
}

const platformIcon = (platform: string | null) =>
  platform === "darwin" || platform === "macos"
    ? Laptop
    : platform === "linux"
      ? Server
      : Monitor;

const platformName = (platform: string | null) =>
  platform === "darwin" || platform === "macos"
    ? "macOS"
    : platform === "windows"
      ? "Windows"
      : platform === "linux"
        ? "Linux"
        : platform;

export function DeviceFingerprintView({
  value,
  controller = false,
  className,
}: {
  value: string;
  controller?: boolean;
  className?: string;
}) {
  const { t } = useI18n();
  const formatted = value.match(/.{1,16}/g)?.join(" ") ?? value;
  return (
    <div
      className={cn("device-fingerprint flex min-w-0 flex-col gap-1.5", className)}
    >
      <span className="text-small font-semibold leading-4 text-foreground">
        {t(controller ? "device.controllerFingerprint" : "device.fingerprint")}
      </span>
      <code className="break-all font-mono text-meta leading-5 text-text-secondary">
        {formatted}
      </code>
    </div>
  );
}

export function DeviceStatusView({ state }: { state: "online" | "offline" }) {
  const { t } = useI18n();
  return (
    <Badge dot size="sm" tone={state === "online" ? "success" : "neutral"}>
      {t(`device.${state}`)}
    </Badge>
  );
}

export function DeviceIdentityView({
  name,
  platform = null,
  state,
  pathLabel,
  row = false,
  onOpen,
}: {
  name: string;
  platform?: string | null;
  state: "online" | "offline";
  pathLabel: string;
  row?: boolean;
  onOpen?: () => void;
}) {
  const { t } = useI18n();
  const PlatformIcon = platformIcon(platform);

  return (
    <div
      className="device-identity flex min-w-0 items-center gap-3"
    >
      <span
        aria-hidden="true"
        className={cn(
          "grid size-9 shrink-0 place-items-center rounded-tile border border-border",
          row && state === "offline"
            ? "bg-surface-subtle text-text-secondary"
            : "bg-phase-command/14 text-phase-command",
        )}
      >
        <PlatformIcon size={16} strokeWidth={1.75} absoluteStrokeWidth />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <strong className="text-body font-semibold leading-5 text-foreground wrap-anywhere">
            {name}
          </strong>
          {row && <DeviceStatusView state={state} />}
        </div>
        <span className="text-meta leading-4 text-text-secondary">
          {pathLabel}
        </span>
      </div>
      {!row && <DeviceStatusView state={state} />}
      {row && onOpen && (
        <IconButton
          compact
          icon={ChevronRight}
          label={`${t("device.open")}: ${name}`}
          onClick={onOpen}
        />
      )}
    </div>
  );
}

export function DeviceDetailView({
  device,
  pathLabel,
  onEditOverride,
  onRevoke,
}: {
  device: DeviceSummary;
  pathLabel: string;
  onEditOverride?: () => void;
  onRevoke?: () => void;
}) {
  const { t } = useI18n();
  const c = (key: string) => t(`device.${key}`);
  const capabilityLabels = device.capabilities
    ? [
        "tasks",
        "command",
        "files",
        device.capabilities.screen ? "screen" : "noScreen",
      ]
    : [];
  const os = platformName(device.platform);

  return (
    <div className="device-detail flex min-w-0 flex-col gap-4">
      <DeviceIdentityView
        name={device.name}
        platform={device.platform}
        state={device.state}
        pathLabel={pathLabel}
      />

      {device.state === "offline" && (
        <Notice layout="inline" tone="warning">
          {device.error || c("offlineHint")}
        </Notice>
      )}

      <Card padded className="gap-4">
        <DeviceFingerprintView value={device.id} />
        <dl className="m-0 grid grid-cols-2 gap-4 text-small">
          <div className="flex flex-col gap-1">
            <dt className="text-meta text-text-secondary">{c("platform")}</dt>
            <dd className="m-0 font-medium text-foreground">
              {[os, device.arch].filter(Boolean).join(" · ") || c("none")}
            </dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className="text-meta text-text-secondary">{c("version")}</dt>
            <dd className="m-0 font-medium text-foreground">
              {device.arcVersion || c("none")}
            </dd>
          </div>
        </dl>
        <div className="device-fingerprint flex flex-col gap-2">
          <span className="text-small font-semibold leading-4 text-foreground">
            {c("capabilities")}
          </span>
          <div className="flex flex-wrap gap-1.5">
            {capabilityLabels.length ? (
              capabilityLabels.map((label) => (
                <Badge key={label} size="sm" tone="neutral">
                  {c(label)}
                </Badge>
              ))
            ) : (
              <span className="text-small text-text-secondary">{c("none")}</span>
            )}
          </div>
        </div>
      </Card>

      <Card padded className="gap-4">
        <div className="device-fingerprint flex min-w-0 flex-col gap-1.5">
          <span className="text-small font-semibold leading-4 text-foreground">
            {c("addresses")}
          </span>
          {device.addresses.length ? (
            device.addresses.map((address) => (
              <code
                key={address}
                className="break-all font-mono text-small leading-5 text-text-secondary"
              >
                {address}
              </code>
            ))
          ) : (
            <span className="text-small text-text-secondary">{c("none")}</span>
          )}
        </div>
        <div className="device-fingerprint flex min-w-0 flex-col gap-1.5">
          <span className="text-small font-semibold leading-4 text-foreground">
            {c("tunnel")}
          </span>
          <code className="break-all font-mono text-small leading-5 text-text-secondary">
            {device.tunnelUrl || c("none")}
          </code>
          {device.tunnelUrl && (
            <p className="m-0 text-meta leading-4 text-text-secondary">
              {c("tunnelNotice")}
            </p>
          )}
        </div>
      </Card>

      <Card className="p-0">
        <div className="flex min-w-0 items-center justify-between gap-4 px-4 py-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-body font-medium leading-5 text-foreground">
              {c("override")}
            </span>
            <p className="m-0 truncate text-meta leading-4 text-text-secondary">
              {device.addressOverride || c("automatic")}
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={onEditOverride}>
            <Pencil size={14} strokeWidth={1.75} absoluteStrokeWidth aria-hidden="true" />
            <span>{c("edit")}</span>
          </Button>
        </div>
      </Card>

      <div className="device-actions flex items-center justify-end gap-2">
        <Button variant="danger" onClick={onRevoke}>
          <Unlink size={14} strokeWidth={1.75} absoluteStrokeWidth aria-hidden="true" />
          <span>{c("revoke")}</span>
        </Button>
      </div>
    </div>
  );
}
