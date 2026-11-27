import { Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import { controlSource } from "../controlSources";
import { locale, t } from "../i18n";
import { openUrl } from "../platform";
import {
  connectionDisabledReason,
  connectionKind,
  isPendingSource,
} from "../sourcePresentation";
import { connector, refreshConnector } from "../state/connector";
import { connectionSwitch, openConnectionSetup } from "../state/onboarding";
import { usePrivacy } from "../state/privacy";
import type { Ingress } from "../state/types";
import {
  ChangeConnectionAddressView,
  ChangeConnectionPickView,
} from "./connectivity/ChangeConnectionView";
import { Alert } from "./kit/alert";
import { Button } from "./kit/button";
import { Field } from "./kit/field";
import { PrivacyProvider } from "./kit/privacy";
import { ApprovalCard } from "./OAuthApproval";
import { CopyField, DialogClose, SetupAction } from "./ui";
import { useDialogCompletion } from "./ui/Dialog";
import { SetupFlow } from "./ui/SetupFlow";
import { useSubmittedDirty } from "./ui/useSubmittedDirty";

const steps = ["connection", "address", "approval"] as const;

export default function ChangeConnection() {
  const completion = useDialogCompletion(() => connectionSwitch.set(undefined));
  const flow = connectionSwitch.use()!;
  const { status, sources } = connector.use();
  const hidden = usePrivacy();
  const [busy, setBusy] = useState(false);
  const [approvalDirty, setApprovalDirty] = useState(false);
  const [error, setError] = useState("");
  const [credentials, setCredentials] = useState<{
    ingressId: string;
    bearerToken: string;
  }>();
  const draft = useSubmittedDirty(
    flow.ingressId,
    flow.step === "connection" && !!flow.ingressId,
  );

  const source = sources.find((item) => item.id === flow.sourceId);
  const entries = status?.ingresses ?? [];
  const current = entries.find((item) => item.id === source?.ingressId);
  const target = entries.find((item) => item.id === flow.ingressId);
  const info = controlSource(source?.product ?? "custom");
  const productName = info?.shortName ?? t("connect.other");
  const settingsUrl = info?.setup?.url;
  const addressInstruction = t(
    info?.setup?.editableUrl === true
      ? "switch.editAddress"
      : "switch.replaceConnector",
    { name: productName },
  );
  const request = target?.oauth?.pending.find(
    (item) =>
      item.id === flow.requestId ||
      (item.switchSourceId === source?.id && item.status === "pending"),
  );

  function reason(item: Ingress) {
    if (item.id === source?.ingressId) return t("switch.current");
    if (
      item.auth !== "oauth" &&
      sources.some((entry) => entry.ingressId === item.id)
    ) {
      return t("setup.connectionOccupied");
    }
    return connectionDisabledReason(item, source?.product ?? "custom", sources);
  }

  const connections = entries.filter(
    (item) =>
      item.transport !== "openai-tunnel" || source?.product === "chatgpt",
  );

  useEffect(() => {
    if (flow.step === "address" && request?.status === "pending") {
      connectionSwitch.set(
        (old) => old && { ...old, step: "approval", requestId: request.id },
      );
    }
  }, [flow.step, request?.id, request?.status]);

  useEffect(() => {
    if (
      source &&
      flow.ingressId &&
      flow.step !== "connection" &&
      source.ingressId === flow.ingressId &&
      source.state === "connected"
    ) {
      void completion.finish();
    }
  }, [source, flow.ingressId, flow.step]);

  useEffect(() => {
    setCredentials(undefined);
    if (flow.step !== "address" || target?.auth !== "bearer") return;
    let alive = true;
    void api<{ bearerToken: string }>(
      `ingress/${target.id}/credentials`,
      "POST",
    )
      .then((value) => {
        if (alive) {
          setCredentials({
            ingressId: target.id,
            bearerToken: value.bearerToken,
          });
        }
      })
      .catch((e) => {
        if (alive) setError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [flow.step, target?.id, target?.auth]);

  async function perform(action: () => Promise<void>) {
    draft.submit();
    setBusy(true);
    setError("");
    try {
      await action();
      completion.feedback(
        `${t("switch.reauthorize")} · ${t("activity.completed")}`,
      );
    } catch (e) {
      setError(String(e));
      completion.feedback(String(e), true);
    } finally {
      setBusy(false);
    }
  }

  async function cancel(close: boolean) {
    setBusy(true);
    setError("");
    try {
      await api(`source/${flow.sourceId}/switch`, "DELETE");
      await refreshConnector();
      connectionSwitch.set(
        close
          ? undefined
          : {
              sourceId: flow.sourceId,
              step: "connection",
              ingressId: flow.ingressId,
            },
      );
      return true;
    } catch (failure) {
      setError(String(failure));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function begin() {
    if (!target || reason(target)) return;
    await perform(async () => {
      await api(`source/${flow.sourceId}/switch`, "POST", {
        ingressId: target.id,
      });
      await refreshConnector();
      connectionSwitch.set((old) =>
        old === flow ? { ...flow, step: "address", requestId: undefined } : old,
      );
    });
  }

  const expired =
    flow.step !== "connection" &&
    ((!source?.pendingSwitch && source?.ingressId !== flow.ingressId) ||
      request?.status === "expired" ||
      request?.status === "denied");
  const canApprove = request?.status === "pending" && !expired;
  const waiting =
    flow.step === "address" && !expired && source?.ingressId !== flow.ingressId;

  return (
    <SetupFlow
      layerId={completion.layerId}
      title={t("switch.sourceTitle", { name: source?.label ?? flow.sourceId })}
      active={steps.indexOf(flow.step)}
      busy={busy || waiting}
      dirty={approvalDirty || draft.dirty}
      steps={[
        { label: t("source.step.connection"), value: target?.name },
        { label: t("switch.address") },
        { label: t("switch.reauthorize") },
      ]}
      actionLayout={flow.step === "approval" && canApprove ? "end" : "split"}
      returnFocus="[data-change-connection]"
      onCancel={waiting ? () => cancel(true) : undefined}
      onClose={async () => {
        await cancel(true);
      }}
      footer={
        flow.step === "approval" && canApprove ? (
          <>
            <Button
              form={`approval-${request.id}`}
              type="submit"
              value="deny"
              disabled={busy}
            >
              {t("oauthDeny")}
            </Button>
            <Button
              form={`approval-${request.id}`}
              type="submit"
              value="allow"
              variant="primary"
              busy={busy}
            >
              {t("switch.approve")}
            </Button>
          </>
        ) : (
          <>
            {flow.step === "connection" ? (
              <DialogClose asChild>
                <Button variant="ghost">{t("cancel")}</Button>
              </DialogClose>
            ) : (
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => void cancel(false)}
              >
                {t("back")}
              </Button>
            )}
            {flow.step === "connection" ? (
              <Button
                variant="primary"
                busy={busy}
                disabled={!target || !!reason(target)}
                onClick={() => void begin()}
              >
                {t("source.next")}
              </Button>
            ) : (
              !expired && (
                <Button variant="primary" busy>
                  {t(
                    request?.status === "approved"
                      ? "connect.returning"
                      : "connect.waitClient",
                    { name: productName },
                  )}
                </Button>
              )
            )}
          </>
        )
      }
    >
      <PrivacyProvider hidden={hidden}>
        <div className="grid min-w-0 gap-5">
          {error && <Alert tone="danger">{error}</Alert>}
          {flow.step === "connection" ? (
            <ChangeConnectionPickView
              currentSummary={t("switch.currentVia", {
                name:
                  current?.name ??
                  source?.connectionName ??
                  t("source.connectionRemoved"),
              })}
              connectionsLabel={t("source.connections")}
              selectedId={flow.ingressId ?? ""}
              onSelect={(ingressId) =>
                connectionSwitch.set({ ...flow, ingressId })
              }
              disabled={busy}
              connections={connections.map((item) => {
                const disabledReason = reason(item);
                return {
                  value: item.id,
                  label: item.name,
                  disabled: Boolean(disabledReason),
                  description:
                    disabledReason ||
                    [
                      t(`source.kind.${connectionKind(item)}`),
                      t(
                        item.state === "ready"
                          ? "connect.online"
                          : "connect.offline",
                      ),
                      sources
                        .filter(
                          (entry) =>
                            entry.ingressId === item.id &&
                            entry.state !== "revoked" &&
                            !isPendingSource(entry, entries),
                        )
                        .map((entry) => entry.label)
                        .join(", "),
                    ]
                      .filter(Boolean)
                      .join(" · "),
                };
              })}
              addConnectionAction={
                <SetupAction
                  data-add-connection=""
                  disabled={busy}
                  icon={Plus}
                  label={t("source.newConnection")}
                  description={t("setup.newConnectionHint")}
                  onClick={() =>
                    openConnectionSetup({
                      forSwitch: true,
                      product: source?.product,
                    })
                  }
                />
              }
              warningMessage={`${addressInstruction} ${t("switch.warning")}`}
            />
          ) : (
            <ChangeConnectionAddressView
              step={flow.step}
              address={target ? target.url || target.config.tunnelId : undefined}
              copyAddressLabel={t("source.copyAddress")}
              bearerField={
                target && credentials?.ingressId === target.id ? (
                  <Field label={t("source.bearerHeader")}>
                    <CopyField
                      password
                      value={`Bearer ${credentials.bearerToken}`}
                      label={t("source.bearerHeader")}
                    />
                  </Field>
                ) : undefined
              }
              addressInstruction={addressInstruction}
              configureTitle={t("setup.configureProduct", {
                name: productName,
              })}
              configurePath={
                info?.setup?.path[locale.get()] ?? t("connect.customPath")
              }
              openSettingsLabel={
                settingsUrl
                  ? t("connect.openSettings", { name: productName })
                  : undefined
              }
              onOpenSettings={
                settingsUrl
                  ? () => void perform(() => openUrl(settingsUrl))
                  : undefined
              }
              browserCodeNote={t(
                target?.auth === "oauth"
                  ? "setup.browserCode"
                  : "source.noOAuthApproval",
              )}
              retryLabel={
                target && target.state !== "ready" ? t("retry") : undefined
              }
              retryBusy={busy}
              onRetry={
                target && target.state !== "ready"
                  ? () =>
                      void perform(async () => {
                        await api(`ingress/${target.id}/start`, "POST");
                        await refreshConnector();
                      })
                  : undefined
              }
              approvalContent={
                target && flow.step === "approval" && request ? (
                  <ApprovalCard
                    key={request.id}
                    request={request}
                    ingress={target}
                    inline
                    onBusy={setBusy}
                    onDirty={setApprovalDirty}
                    onDecided={(allow) => {
                      if (!allow) {
                        connectionSwitch.set({
                          sourceId: flow.sourceId,
                          ingressId: flow.ingressId,
                          step: "connection",
                        });
                      }
                    }}
                  />
                ) : undefined
              }
              removedMessage={
                !target ? t("source.connectionRemoved") : undefined
              }
              expiredMessage={expired ? t("switch.expired") : undefined}
            />
          )}
        </div>
      </PrivacyProvider>
    </SetupFlow>
  );
}
