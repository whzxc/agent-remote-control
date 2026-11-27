import { Cloud, Link, Plug, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { readOnlyBrowser } from "../browserMode";
import {
  controlSource,
  curatedSources,
  nextSourceName,
} from "../controlSources";
import { locale, t } from "../i18n";
import { openUrl } from "../platform";
import {
  connectionDisabledReason,
  connectionKind,
  isPendingSource,
} from "../sourcePresentation";
import { connector, refreshConnector } from "../state/connector";
import {
  addedSource,
  finishSourceSetup,
  onboarding,
  openConnectionSetup,
  type ConnectionMethod,
  type OnboardingStep,
} from "../state/onboarding";
import { usePrivacy } from "../state/privacy";
import {
  SourceAddressStepView,
  SourceApprovalStepView,
  SourceConnectionStepView,
  SourceProductPickerView,
  SourceSuccessStepView,
} from "./connectivity/SourceOnboardingView";
import { Alert } from "./kit/alert";
import { Button } from "./kit/button";
import { Field } from "./kit/field";
import { PrivacyProvider } from "./kit/privacy";
import { ApprovalCard } from "./OAuthApproval";
import SourceIcon from "./SourceIcon";
import { CopyField, SetupAction } from "./ui";
import { useDialogCompletion } from "./ui/Dialog";
import { SetupFlow } from "./ui/SetupFlow";
import { useSubmittedDirty } from "./ui/useSubmittedDirty";

const steps: OnboardingStep[] = [
  "product",
  "connection",
  "address",
  "approval",
  "success",
];
const products = [
  ...curatedSources.map((source) => source.id),
  "grok-bot",
  "local-code",
  "local-desktop",
  "custom",
];

export default function AddControlSource({
  returnFocus,
}: {
  returnFocus?: string;
}) {
  const completion = useDialogCompletion(finishSourceSetup);
  const flow = onboarding.use()!;
  const { status, sources } = connector.use();
  const hidden = usePrivacy();
  const [busy, setBusy] = useState(false);
  const [approvalDirty, setApprovalDirty] = useState(false);
  const [error, setError] = useState("");
  const [route, setRoute] = useState("");
  const [choiceDirty, setChoiceDirty] = useState(false);
  const initialProduct = useRef(flow.source);
  const draft = useSubmittedDirty(
    { source: flow.source, route },
    choiceDirty || flow.source !== initialProduct.current,
  );
  const [credentials, setCredentials] = useState<{
    ingressId: string;
    bearerToken: string;
  }>();

  const product = flow.source ?? "custom";
  const info = controlSource(product);
  const name = info?.shortName ?? t("connect.other");
  const settingsUrl = info?.setup?.url;
  const entries = status?.ingresses ?? [];
  const current = entries.find((item) => item.id === flow.ingressId);
  const visible = entries.filter(
    (item) =>
      (!flow.localTarget || item.id === `local-claude-${flow.localTarget}`) &&
      (item.transport !== "openai-tunnel" || product === "chatgpt"),
  );
  const existing = visible.filter(
    (item) =>
      !connectionDisabledReason(item, product, sources, flow.localTarget),
  );
  const existingIds = existing.map((item) => item.id).join(",");

  useEffect(() => {
    setRoute((old) =>
      existing.some((item) => item.id === flow.ingressId)
        ? flow.ingressId!
        : existing.some((item) => item.id === old)
          ? old
          : (existing[0]?.id ?? ""),
    );
  }, [flow.source, flow.localTarget, flow.ingressId, existingIds]);

  useEffect(() => {
    setCredentials(undefined);
    if (readOnlyBrowser || flow.step !== "address" || current?.auth !== "bearer") {
      return;
    }
    let alive = true;
    void api<{ bearerToken: string }>(
      `ingress/${current.id}/credentials`,
      "POST",
    )
      .then((value) => {
        if (alive) {
          setCredentials({
            ingressId: current.id,
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
  }, [flow.step, current?.id, current?.auth]);

  function step(next: OnboardingStep) {
    setError("");
    onboarding.set(
      (old) =>
        old && {
          ...old,
          step: next,
          ...(["product", "connection"].includes(next)
            ? {
                requestId: undefined,
                ingressId: old.fixedConnection ? old.ingressId : undefined,
                sourceId: undefined,
              }
            : {}),
        },
    );
  }

  async function perform(action: () => Promise<void>) {
    draft.submit();
    setBusy(true);
    setError("");
    try {
      await action();
      completion.feedback(
        `${t("addControlSource")} · ${t("activity.completed")}`,
      );
    } catch (e) {
      setError(String(e));
      completion.feedback(String(e), true);
    } finally {
      setBusy(false);
    }
  }

  async function selectConnection(id: string) {
    await perform(async () => {
      const entry = connector
        .get()
        .status?.ingresses.find((item) => item.id === id);
      if (!entry) return;
      if (entry.auth !== "oauth") {
        const source = sources.find(
          (item) => item.ingressId === id && item.state !== "revoked",
        );
        if (!readOnlyBrowser && source && source.product !== product) {
          await api(`source/${source.id}`, "PUT", {
            product,
            ...(source.label === controlSource(source.product)?.displayName
              ? {
                  label: nextSourceName(
                    product,
                    sources
                      .filter((item) => item.id !== source.id)
                      .map((item) => item.label),
                  ),
                }
              : {}),
          });
          await refreshConnector();
        }
      }
      onboarding.set(
        (old) =>
          old && {
            ...old,
            step: "address",
            ingressId: id,
            requestId: undefined,
            sourceId: undefined,
            baseline: (entry.oauth?.pending ?? []).map((item) => item.id),
          },
      );
    });
  }

  const pending =
    current?.oauth?.pending.filter(
      (item) => item.status === "pending" && !item.switchSourceId,
    ) ?? [];
  const waiting = current?.oauth?.pending.find(
    (item) => item.id === flow.requestId,
  );

  useEffect(() => {
    if (flow.step !== "address" || current?.auth !== "oauth") return;
    const next = pending.find((item) => !flow.baseline?.includes(item.id));
    if (next) {
      onboarding.set((old) =>
        old?.step === "address"
          ? { ...old, step: "approval", requestId: next.id }
          : old,
      );
    }
  }, [flow.step, flow.ingressId, current?.oauth]);

  const connected = sources.find(
    (source) =>
      source.ingressId === current?.id &&
      source.product === product &&
      source.state === "connected" &&
      source.connectedAt !== null &&
      (current?.auth !== "oauth" || source.credential.grantId === flow.requestId),
  );

  useEffect(() => {
    if (
      (flow.step === "approval" ||
        (flow.step === "address" && current?.auth !== "oauth")) &&
      connected
    ) {
      onboarding.set((old) =>
        old && ["approval", "address"].includes(old.step)
          ? { ...old, step: "success", sourceId: connected.id }
          : old,
      );
    }
  }, [flow.step, connected?.id]);

  function retry() {
    onboarding.set(
      (old) =>
        old && {
          ...old,
          step: "address",
          requestId: undefined,
          baseline: (current?.oauth?.pending ?? []).map((item) => item.id),
        },
    );
  }

  const added = sources.find((source) => source.id === flow.sourceId);
  const selectedProduct = flow.localTarget
    ? `local-${flow.localTarget}`
    : (flow.source ?? "");

  function chooseProduct(value: string) {
    onboarding.set(
      (old) =>
        old && {
          ...old,
          source: value.startsWith("local-") ? "claude" : value,
          localTarget: value.startsWith("local-")
            ? (value.slice(6) as "code" | "desktop")
            : undefined,
          ingressId: old.fixedConnection ? old.ingressId : undefined,
          requestId: undefined,
          sourceId: undefined,
        },
    );
  }

  function newConnection(method?: ConnectionMethod) {
    openConnectionSetup({
      forSource: true,
      product,
      localTarget: flow.localTarget,
      method,
    });
  }

  const productName = (id: string) =>
    id === "custom"
      ? t("setup.otherClient")
      : id === "local-code"
        ? "Claude Code"
        : id === "local-desktop"
          ? t("setup.claudeDesktop")
          : id === "microsoft-copilot"
            ? "Copilot"
            : controlSource(id)!.displayName;

  const title = selectedProduct
    ? t("setup.addProduct", { name: productName(selectedProduct) })
    : t("addControlSource");

  const footer = (
    <>
      {flow.step === "approval" && waiting?.status === "pending" && (
        <>
          <Button
            type="submit"
            form={`approval-${waiting.id}`}
            value="deny"
            disabled={readOnlyBrowser || busy}
          >
            {t("oauthDeny")}
          </Button>
          <Button
            variant="primary"
            type="submit"
            form={`approval-${waiting.id}`}
            value="allow"
            disabled={readOnlyBrowser}
            busy={busy}
          >
            {t("oauthAllow")}
          </Button>
        </>
      )}
      {flow.step !== "product" &&
        flow.step !== "success" &&
        flow.step !== "approval" && (
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() =>
              step(
                flow.step === "address" && flow.fixedConnection
                  ? "product"
                  : steps[Math.max(0, steps.indexOf(flow.step) - 1)],
              )
            }
          >
            {t("back")}
          </Button>
        )}
      {flow.step === "product" && (
        <Button
          variant="primary"
          busy={busy}
          disabled={
            !flow.source ||
            Boolean(
              flow.fixedConnection &&
                current &&
                connectionDisabledReason(
                  current,
                  product,
                  sources,
                  flow.localTarget,
                ),
            )
          }
          onClick={() =>
            flow.fixedConnection && flow.ingressId
              ? void selectConnection(flow.ingressId)
              : step("connection")
          }
        >
          {t("source.next")}
        </Button>
      )}
      {flow.step === "connection" && existing.length > 0 && (
        <Button
          variant="primary"
          busy={busy}
          disabled={!existing.some((item) => item.id === route)}
          onClick={() => void selectConnection(route)}
        >
          {t("source.next")}
        </Button>
      )}
      {flow.step === "address" && (
        <Button variant="primary" busy>
          {t(
            current?.auth === "oauth"
              ? "connect.waitClient"
              : "source.waitConnection",
            { name },
          )}
        </Button>
      )}
      {flow.step === "success" && (
        <Button
          variant="primary"
          onClick={() => {
            if (flow.sourceId) addedSource.set(flow.sourceId);
            onboarding.set({ step: "product" });
          }}
        >
          {t("setup.addAnother")}
        </Button>
      )}
    </>
  );

  return (
    <SetupFlow
      layerId={completion.layerId}
      title={title}
      steps={steps.slice(0, 4).map((value, index) => ({
        label: t(`source.step.${value}`),
        value:
          index === 0
            ? productName(selectedProduct || "custom")
            : index === 1
              ? current?.name
              : undefined,
      }))}
      context={
        flow.step === "product" && flow.fixedConnection && current
          ? t("setup.via", { name: current.name })
          : undefined
      }
      actionLayout={
        ["product", "approval", "success"].includes(flow.step) ? "end" : "split"
      }
      active={steps.indexOf(flow.step)}
      done={flow.step === "success"}
      busy={busy || (flow.step === "address" && !connected)}
      dirty={approvalDirty || draft.dirty}
      onClose={finishSourceSetup}
      initialFocus={
        flow.step === "product" && flow.focusGroup
          ? `platform-${flow.focusGroup}`
          : undefined
      }
      returnFocus={returnFocus}
      footer={footer}
    >
      <PrivacyProvider hidden={hidden}>
        <div className="grid min-w-0 gap-5">
          {error && <Alert tone="danger">{error}</Alert>}
          {flow.step === "product" && (
            <SourceProductPickerView
              value={selectedProduct}
              onChange={chooseProduct}
              groups={(["remote", "local"] as const).map((group) => ({
                id: group,
                headingId: `platform-${group}`,
                label: t(`setup.group.${group}`),
                options: products
                  .filter(
                    (id) =>
                      (id.startsWith("local-") || id === "custom") ===
                      (group === "local"),
                  )
                  .map((id) => {
                    const localTarget = id.startsWith("local-")
                      ? (id.slice(6) as "code" | "desktop")
                      : undefined;
                    const disabledReason =
                      flow.fixedConnection && current
                        ? connectionDisabledReason(
                            current,
                            localTarget ? "claude" : id,
                            sources,
                            localTarget,
                          )
                        : "";
                    return {
                      value: id,
                      label: productName(id),
                      disabled: Boolean(disabledReason),
                      description: disabledReason || undefined,
                      icon: (
                        <SourceIcon
                          platform={
                            id === "local-code"
                              ? "claude-code"
                              : id === "local-desktop"
                                ? "claude"
                                : id
                          }
                        />
                      ),
                    };
                  }),
              }))}
            />
          )}
          {flow.step === "connection" && (
            <SourceConnectionStepView
              prompt={t("setup.connectionPrompt", {
                name: productName(selectedProduct || "custom"),
              })}
              connectionsLabel={t("source.connections")}
              selectedConnection={route}
              onSelectConnection={(value) => {
                setChoiceDirty(true);
                setRoute(value);
              }}
              disabled={readOnlyBrowser || busy}
              hasSelectableConnection={existing.length > 0}
              connections={visible.map((item) => {
                const carried = sources.filter(
                  (source) =>
                    source.ingressId === item.id &&
                    !isPendingSource(source, entries) &&
                    source.state !== "revoked",
                );
                const disabledReason = connectionDisabledReason(
                  item,
                  product,
                  sources,
                  flow.localTarget,
                );
                return {
                  value: item.id,
                  label: item.name,
                  disabled: Boolean(disabledReason),
                  description:
                    disabledReason ||
                    [
                      t(`source.kind.${connectionKind(item)}`),
                      carried.length &&
                        t("setup.carriesSources", {
                          names: carried.map((source) => source.label).join(", "),
                        }),
                      t(
                        item.state === "ready"
                          ? "connect.online"
                          : "connect.offline",
                      ),
                    ]
                      .filter(Boolean)
                      .join(" · "),
                };
              })}
              emptyTitle={t("setup.noConnection")}
              emptyPrompt={t("setup.connectionPrompt", {
                name: productName(selectedProduct || "custom"),
              })}
              emptyActions={
                flow.localTarget ? (
                  <Button
                    disabled={readOnlyBrowser}
                    onClick={() =>
                      newConnection(
                        flow.localTarget === "code"
                          ? "local-code"
                          : "local-desktop",
                      )
                    }
                  >
                    {t("connection.localSetup", {
                      name: productName(selectedProduct),
                    })}
                  </Button>
                ) : (
                  <div className="grid grid-cols-3 gap-2.5 max-[540px]:grid-cols-1">
                    <SetupAction
                      disabled={readOnlyBrowser}
                      icon={Cloud}
                      label={t("source.createRelay")}
                      badge={t("setup.recommended")}
                      onClick={() => newConnection("create")}
                    />
                    <SetupAction
                      disabled={readOnlyBrowser}
                      icon={Link}
                      label={t("source.pasteRelay")}
                      onClick={() => newConnection("join")}
                    />
                    <SetupAction
                      disabled={readOnlyBrowser}
                      icon={Plug}
                      label={t("setup.ownAddress")}
                      onClick={() => newConnection("https")}
                    />
                  </div>
                )
              }
              addConnectionAction={
                <SetupAction
                  data-add-connection=""
                  disabled={readOnlyBrowser || busy}
                  icon={Plus}
                  label={t("source.newConnection")}
                  description={t("setup.newConnectionHint")}
                  onClick={() => newConnection()}
                />
              }
            />
          )}
          {flow.step === "address" &&
            (current ? (
              <SourceAddressStepView
                isLocal={current.transport === "local"}
                localRestartText={t("connect.restartClaude")}
                copyStepTitle={t("source.copyAddress")}
                address={current.url || current.config.tunnelId}
                copyAddressLabel={t("source.copyAddress")}
                bearerField={
                  credentials?.ingressId === current.id ? (
                    <Field label={t("source.bearerHeader")}>
                      <CopyField
                        password
                        value={`Bearer ${credentials.bearerToken}`}
                        label={t("source.bearerHeader")}
                      />
                    </Field>
                  ) : undefined
                }
                configureStepTitle={t("setup.configureProduct", { name })}
                configurePath={
                  info?.setup?.path[locale.get()] ?? t("connect.customPath")
                }
                openSettingsLabel={
                  settingsUrl ? t("connect.openSettings", { name }) : undefined
                }
                onOpenSettings={
                  settingsUrl
                    ? () => void perform(() => openUrl(settingsUrl))
                    : undefined
                }
                connectStepTitle={t("setup.clickConnect", { name })}
                connectStepNote={t(
                  current.auth === "oauth"
                    ? "setup.browserCode"
                    : "source.noOAuthApproval",
                )}
                error={current.error || undefined}
                retryLabel={current.state !== "ready" ? t("retry") : undefined}
                retryBusy={busy}
                retryDisabled={readOnlyBrowser}
                onRetry={
                  current.state !== "ready"
                    ? () =>
                        void perform(async () => {
                          await api(`ingress/${current.id}/start`, "POST");
                          await refreshConnector();
                        })
                    : undefined
                }
                reviewLabel={pending.length > 0 ? t("source.review") : undefined}
                onReview={
                  pending.length > 0
                    ? () =>
                        onboarding.set(
                          (old) =>
                            old && {
                              ...old,
                              step: "approval",
                              requestId: pending[0].id,
                            },
                        )
                    : undefined
                }
              />
            ) : (
              <Alert tone="danger">{t("source.connectionRemoved")}</Alert>
            ))}
          {flow.step === "approval" && (
            <SourceApprovalStepView
              pendingRequests={pending.map((item) => ({
                id: item.id,
                label: `${item.clientName} · ${item.pairingCode ?? item.redirectUri}`,
              }))}
              pendingRequestsLabel={t("source.pendingRequests")}
              selectedRequestId={flow.requestId ?? ""}
              onSelectRequest={(requestId) =>
                onboarding.set((old) => old && { ...old, requestId })
              }
              expiredMessage={t("connect.requestExpired")}
              retryLabel={
                !waiting || ["denied", "expired"].includes(waiting.status)
                  ? t("retry")
                  : undefined
              }
              onRetry={
                !waiting || ["denied", "expired"].includes(waiting.status)
                  ? retry
                  : undefined
              }
            >
              {waiting && current ? (
                <ApprovalCard
                  key={waiting.id}
                  request={waiting}
                  ingress={current}
                  product={product}
                  inline
                  onBusy={setBusy}
                  onDirty={setApprovalDirty}
                  onDecided={(allow) => {
                    if (!allow) retry();
                  }}
                />
              ) : undefined}
            </SourceApprovalStepView>
          )}
          {flow.step === "success" && (
            <SourceSuccessStepView
              title={t("source.added", { name: added?.label ?? name })}
              subtitle={t("setup.via", {
                name: current?.name ?? t("source.connectionRemoved"),
              })}
              promptLabel={t("setup.tryPrompt", { name })}
              promptValue={t("setup.firstPrompt")}
              copyLabel={t("copy")}
            />
          )}
        </div>
      </PrivacyProvider>
    </SetupFlow>
  );
}
