import { Laptop, Monitor, Plus, Unlink } from "lucide-react";
import { useId, type FormEvent, type ReactNode, type RefObject } from "react";
import { Notice } from "../components/kit/alert";
import { Button } from "../components/kit/button";
import { Card } from "../components/kit/card";
import { CopyField } from "../components/kit/copy-field";
import { Field } from "../components/kit/field";
import { Input } from "../components/kit/input";
import { Switch } from "../components/kit/switch";
import { useI18n } from "../i18n/react";
import { DeviceFingerprintView } from "./DeviceFactsView";

export type DevicePairState =
  | "input"
  | "waiting"
  | "success"
  | "invalid"
  | "expired"
  | "protocol"
  | "declined"
  | "unreachable"
  | "error";

const countdown = (seconds: number) =>
  `${String(Math.max(0, Math.floor(seconds / 60))).padStart(2, "0")}:${String(Math.max(0, seconds % 60)).padStart(2, "0")}`;

const pairErrorKeys: Partial<Record<DevicePairState, string>> = {
  invalid: "invalid",
  expired: "expired",
  protocol: "protocol",
  declined: "declined",
  unreachable: "unreachable",
};

export function DeviceMemberView({
  controller,
  pending,
  offer,
  offerSeconds = 0,
  deviceId,
  outcome,
  showUpstreamSources,
  showUpstreamToggle = false,
  upstreamSlot,
  busy = false,
  onOffer,
  onApprove,
  onDecline,
  onRevokeController,
  onToggleUpstreamSources,
}: {
  controller?: { deviceId: string; name: string } | null;
  pending?: { deviceId: string; name: string; expiresInSeconds: number } | null;
  offer?: { pairingString: string } | null;
  offerSeconds?: number;
  deviceId?: string;
  outcome?: "expired" | "declined";
  showUpstreamSources?: boolean;
  showUpstreamToggle?: boolean;
  upstreamSlot?: ReactNode;
  busy?: boolean;
  onOffer?: () => void;
  onApprove?: () => void;
  onDecline?: () => void;
  onRevokeController?: () => void;
  onToggleUpstreamSources?: (show: boolean) => void;
}) {
  const { t } = useI18n();
  const c = (key: string, params?: Record<string, unknown>) =>
    t(`device.${key}`, params);

  let card: ReactNode;
  if (controller) {
    card = (
      <Card padded className="gap-4">
        <div className="device-identity flex min-w-0 items-center gap-3">
          <span
            aria-hidden="true"
            className="grid size-9 shrink-0 place-items-center rounded-tile border border-border bg-phase-command/14 text-phase-command"
          >
            <Laptop size={16} strokeWidth={1.75} absoluteStrokeWidth />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-meta leading-4 text-text-secondary">
              {c("controlledBy")}
            </span>
            <strong className="text-body font-semibold leading-5 text-foreground wrap-anywhere">
              {controller.name}
            </strong>
          </div>
          <Button variant="danger" size="sm" onClick={onRevokeController}>
            <Unlink size={14} strokeWidth={1.75} absoluteStrokeWidth aria-hidden="true" />
            <span>{c("revoke")}</span>
          </Button>
        </div>
        <DeviceFingerprintView value={controller.deviceId} controller />
        <p className="m-0 text-small leading-5 text-text-secondary">
          {c("currentAuthority")}
        </p>
      </Card>
    );
  } else if (pending) {
    card = (
      <Card padded className="gap-4">
        <div className="device-identity flex min-w-0 items-center gap-3">
          <span
            aria-hidden="true"
            className="grid size-9 shrink-0 place-items-center rounded-tile border border-border bg-warning/14 text-warning"
          >
            <Laptop size={16} strokeWidth={1.75} absoluteStrokeWidth />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <strong className="text-body font-semibold leading-5 text-foreground">
              {c("pending")}
            </strong>
            <span className="text-small text-text-secondary">
              {pending.name}
            </span>
          </div>
        </div>
        <DeviceFingerprintView value={pending.deviceId} controller />
        <p className="m-0 text-small leading-5 text-text-secondary">
          {c("compare", { name: pending.name })}
        </p>
        <Notice layout="inline" tone="warning">
          {c("fullAuthority")}
        </Notice>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-meta leading-4 text-text-secondary">
            {c("offerDeadline", { time: countdown(pending.expiresInSeconds) })}
          </span>
          <div className="device-actions flex items-center justify-end gap-2">
            <Button disabled={busy} onClick={onDecline}>
              {c("decline")}
            </Button>
            <Button variant="primary" disabled={busy} onClick={onApprove}>
              {c("approve")}
            </Button>
          </div>
        </div>
      </Card>
    );
  } else if (offer && offerSeconds > 0) {
    card = (
      <Card padded className="gap-4">
        <Field
          label={c("pairing")}
          help={
            <span className="text-meta font-normal text-text-secondary">
              {c("offerExpiry", { time: countdown(offerSeconds) })}
            </span>
          }
        >
          <CopyField
            value={offer.pairingString}
            label={c("copy")}
            className="w-full"
          />
        </Field>
        <p className="m-0 text-small leading-5 text-text-secondary">
          {c("offerHint")}
        </p>
        {deviceId && <DeviceFingerprintView value={deviceId} />}
      </Card>
    );
  } else {
    card = (
      <div className="flex flex-col gap-3">
        {(outcome || (offer && offerSeconds === 0)) && (
          <Notice layout="inline" tone="warning">
            {c(outcome === "declined" ? "offerDeclined" : "offerExpired")}
          </Notice>
        )}
        <Card padded>
          <div className="device-identity flex min-w-0 items-center gap-3">
            <span
              aria-hidden="true"
              className="grid size-9 shrink-0 place-items-center rounded-tile border border-border bg-surface-subtle text-text-secondary"
            >
              <Monitor size={16} strokeWidth={1.75} absoluteStrokeWidth />
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <strong className="text-body font-semibold leading-5 text-foreground">
                {c("unpaired")}
              </strong>
              <span className="text-meta leading-4 text-text-secondary">
                {c("oneController")}
              </span>
            </div>
            <Button
              data-device-offer
              variant="primary"
              busy={busy}
              onClick={onOffer}
            >
              <Plus size={14} strokeWidth={1.75} absoluteStrokeWidth aria-hidden="true" />
              <span>{c("createOffer")}</span>
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <>
      {card}
      {showUpstreamToggle &&
        (upstreamSlot ?? (
          <Card className="p-0">
            <div className="flex min-w-0 items-center justify-between gap-4 px-4 py-3">
              <span className="text-body font-medium leading-5 text-foreground">
                {t("homepage.upstreamSources")}
              </span>
              <span className="inline-flex shrink-0">
                <Switch
                  aria-label={t("homepage.upstreamSources")}
                  checked={Boolean(showUpstreamSources)}
                  disabled={busy}
                  onCheckedChange={(checked) =>
                    onToggleUpstreamSources?.(checked)
                  }
                />
              </span>
            </div>
          </Card>
        ))}
    </>
  );
}

export function DevicePairFormView({
  state,
  input,
  memberName,
  controllerName,
  controllerFingerprint,
  memberStatusLabel,
  errorText,
  errorCode,
  inputRef,
  onInputChange,
  onSubmit,
  footer,
}: {
  state: DevicePairState;
  input: string;
  memberName?: string;
  controllerName?: string;
  controllerFingerprint?: string;
  memberStatusLabel?: string;
  errorText?: string;
  errorCode?: string;
  inputRef?: RefObject<HTMLInputElement | null>;
  onInputChange?: (value: string) => void;
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
  footer?: ReactNode;
}) {
  const { t } = useI18n();
  const c = (key: string, params?: Record<string, unknown>) =>
    t(`device.${key}`, params);
  const inputId = useId();
  const waiting = state === "waiting";
  const success = state === "success";
  const isError = !["input", "waiting", "success"].includes(state);
  const errorKey = pairErrorKeys[state];

  return (
    <form className="flex flex-col gap-4" onSubmit={onSubmit}>
      {success ? (
        <Notice
          layout="inline"
          tone="success"
          title={c("paired", { name: memberName ?? "" })}
        >
          {memberStatusLabel ? (
            <span className="text-foreground">{memberStatusLabel}</span>
          ) : null}
        </Notice>
      ) : (
        <>
          <Field
            id={inputId}
            label={c("pairing")}
            error={state === "invalid" ? c("invalidHint") : undefined}
          >
            <Input
              ref={inputRef}
              id={inputId}
              value={input}
              placeholder={c("paste")}
              readOnly={waiting || !onInputChange}
              aria-invalid={isError || undefined}
              aria-describedby={isError ? `${inputId}-error` : undefined}
              inputClassName="font-mono text-small truncate"
              onChange={(event) => onInputChange?.(event.target.value)}
            />
          </Field>

          {waiting ? (
            <div className="flex flex-col gap-3" role="status">
              {errorText && <Notice tone="danger">{errorText}</Notice>}
              <p className="m-0 text-small leading-5 text-foreground">
                {c("waitingHint", {
                  member: memberName || c("members"),
                  controller: controllerName || "",
                })}
              </p>
              {controllerFingerprint && (
                <DeviceFingerprintView value={controllerFingerprint} controller />
              )}
              <p className="m-0 text-meta leading-4 text-text-secondary">
                {c("deadline")}
              </p>
            </div>
          ) : state === "invalid" ? (
            <code className="font-mono text-caption text-destructive">
              DEVICE_PAIRING_INVALID
            </code>
          ) : isError ? (
            <div id={`${inputId}-error`}>
              <Notice
                layout="inline"
                tone="danger"
                title={errorKey ? c(errorKey) : undefined}
              >
                <div className="grid gap-1">
                  <p className="m-0 text-foreground">
                    {errorKey ? c(`${errorKey}Hint`) : errorText}
                  </p>
                  {errorKey && errorCode && (
                    <code className="font-mono text-caption text-text-secondary">
                      {errorCode}
                    </code>
                  )}
                </div>
              </Notice>
            </div>
          ) : (
            <p className="m-0 text-small leading-5 text-text-secondary">
              {c("lanOnly")}
            </p>
          )}
        </>
      )}
      {footer}
    </form>
  );
}

export function DeviceAddressFormView({
  deviceName,
  value,
  error,
  inputRef,
  onChange,
  onSubmit,
  footer,
}: {
  deviceName: string;
  value: string;
  error?: string;
  inputRef?: RefObject<HTMLInputElement | null>;
  onChange?: (value: string) => void;
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
  footer?: ReactNode;
}) {
  const { t } = useI18n();
  const c = (key: string) => t(`device.${key}`);
  const id = useId();

  return (
    <form className="flex flex-col gap-4" noValidate onSubmit={onSubmit}>
      <Field id={id} label={deviceName} error={error}>
        <Input
          ref={inputRef}
          id={id}
          value={value}
          readOnly={!onChange}
          aria-invalid={Boolean(error) || undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(event) => onChange?.(event.target.value)}
        />
      </Field>
      <p className="m-0 text-small leading-5 text-text-secondary">
        {c("overrideHint")}
      </p>
      {footer}
    </form>
  );
}

export function DeviceRevokeCopyView({
  peerName,
  memberSide,
  error,
}: {
  peerName: string;
  memberSide: boolean;
  error?: string;
}) {
  const { t } = useI18n();
  const c = (key: string, params?: Record<string, unknown>) =>
    t(`device.${key}`, params);

  return (
    <div data-slot="device-revoke-copy" className="flex flex-col gap-2.5 text-small leading-5">
      <p className="m-0 text-foreground">
        {c(memberSide ? "revokeMemberEffect" : "revokeEffect", {
          name: peerName,
        })}
      </p>
      <p className="m-0 text-text-secondary">{c("localWork")}</p>
      {error && <Notice layout="inline" tone="danger">{error}</Notice>}
    </div>
  );
}
