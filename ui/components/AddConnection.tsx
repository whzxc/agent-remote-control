import { ExternalLink } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { api } from "../api";
import { controlSource } from "../controlSources";
import { t } from "../i18n";
import { connectionKind, isPendingSource } from "../sourcePresentation";
import { connector, refreshConnector } from "../state/connector";
import {
  connectionSwitch,
  onboarding,
  openOnboarding,
  type ConnectionMethod,
  type ConnectionSetup,
} from "../state/onboarding";
import { usePrivacy } from "../state/privacy";
import {
  useRelayProgress,
  type RelayProgress as Progress,
} from "../state/relay";
import {
  ConnectionJoinStepView,
  ConnectionLocalStepView,
  ConnectionMethodStepView,
  ConnectionReadyStepView,
} from "./connectivity/ConnectionOnboardingView";
import IngressDialog from "./IngressDialog";
import { Alert } from "./kit/alert";
import { Button } from "./kit/button";
import { PrivacyProvider } from "./kit/privacy";
import RelayProgress from "./RelayProgress";
import { SensitiveInput, useSensitiveText } from "./Sensitive";
import { DialogClose } from "./ui";
import { useDialogCompletion } from "./ui/Dialog";
import { SetupFlow } from "./ui/SetupFlow";
import { useSubmittedDirty } from "./ui/useSubmittedDirty";

type LocalAccess = { codeAvailable: boolean; desktopAvailable: boolean };
const steps = ["method", "address", "success"] as const;

export default function AddConnection({
  options,
  onClose,
  onAdded,
  returnFocus,
}: {
  options: ConnectionSetup;
  onClose: () => void;
  onAdded: (id: string) => void;
  returnFocus?: string;
}) {
  const completion = useDialogCompletion(onClose);
  const { status, sources } = connector.use();
  const hidden = usePrivacy();
  const [step, setStep] = useState<(typeof steps)[number]>(
    options.step ?? (options.method ? "address" : "method"),
  );
  const [method, setMethod] = useState<ConnectionMethod>(
    options.localTarget
      ? `local-${options.localTarget}`
      : (options.method ?? "create"),
  );
  const initialMethod = useRef(method);
  const [busy, setBusy] = useState(false);
  const [configBusy, setConfigBusy] = useState(false);
  const [configDirty, setConfigDirty] = useState(false);
  const [error, setError] = useState("");
  const [link, setLink] = useState("");
  const [account, setAccount] = useState("");
  const [deviceName, setDeviceName] = useState(status?.deviceName ?? "");
  const draft = useSubmittedDirty(
    { method, link, account, deviceName },
    method !== initialMethod.current ||
      !!link ||
      !!account ||
      deviceName !== (status?.deviceName ?? ""),
  );
  const protect = useSensitiveText([link]);
  const [createdId, setCreatedId] = useState<string | undefined>(
    options.createdId,
  );
  const [operation, setOperation] = useState<"create" | "join" | "redeploy">();
  const [local, setLocal] = useState<LocalAccess>();
  const formId = useId();
  const target =
    method === "local-code"
      ? "code"
      : method === "local-desktop"
        ? "desktop"
        : undefined;
  const created = status?.ingresses.find((item) => item.id === createdId);
  const revoked =
    !!target &&
    sources.some(
      (source) =>
        source.ingressId === `local-claude-${target}` &&
        source.state === "revoked",
    );

  const {
    progress,
    setProgress,
    error: progressError,
  } = useRelayProgress(!!operation, (value) => {
    if (!value.result?.ingressId) return;
    setOperation(undefined);
    complete(value.result.ingressId);
    void refreshConnector().catch((e) => setError(String(e)));
  });

  useEffect(() => {
    let alive = true;
    void api<Progress>("relay/progress")
      .then((value) => {
        if (!alive) return;
        if (
          !["login", "deploying", "connecting"].includes(value.phase) ||
          !["create", "join", "redeploy"].includes(value.action ?? "")
        ) {
          if (options.method === "create" && !options.step) void startRelay();
          return;
        }
        setProgress(value);
        setOperation(value.action as "create" | "join" | "redeploy");
        setStep("address");
        setMethod(value.action === "join" ? "join" : "create");
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!target) return;
    let alive = true;
    void api<LocalAccess>("local-access/status")
      .then((value) => {
        if (alive) setLocal(value);
      })
      .catch((e) => {
        if (alive) setError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [target]);

  async function perform(action: () => Promise<void>) {
    draft.submit();
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(
        String(e).includes("LOCAL_CONFIG_CONFLICT")
          ? t("connect.localConflict")
          : String(e),
      );
      completion.feedback(String(e), true);
    } finally {
      setBusy(false);
    }
  }

  function complete(id: string) {
    if (!completion.isOpen()) {
      completion.feedback(t("connection.added"));
      return;
    }
    setCreatedId(id);
    setStep("success");
  }

  async function startRelay(retry = false) {
    const action =
      retry && progress.relayId && operation !== "join"
        ? "redeploy"
        : retry
          ? (operation ?? "create")
          : (method as "create" | "join");
    await perform(async () => {
      const value = await api<Progress>(
        `relay/${action}`,
        "POST",
        action === "join"
          ? { link: link.trim(), name: deviceName.trim() }
          : {
              ...(retry && progress.relayId ? { id: progress.relayId } : {}),
              ...(account ? { accountId: account } : {}),
              name: status?.deviceName || t("connect.thisComputer"),
            },
      );
      setProgress(value);
      setOperation(action);
    });
  }

  async function configure() {
    if (!target) {
      await startRelay();
      return;
    }
    await perform(async () => {
      const result = await api<{ ingressId: string }>(
        "local-access/install",
        "POST",
        { target },
      );
      complete(result.ingressId);
      await refreshConnector();
    });
  }

  function reason(value: ConnectionMethod) {
    if (options.localTarget) {
      return value !== `local-${options.localTarget}`
        ? t("setup.localOnly")
        : "";
    }
    if (value.startsWith("local-") && options.product) {
      return t("setup.localOnly");
    }
    return value === "openai-tunnel" &&
      options.product &&
      options.product !== "chatgpt"
      ? t("setup.chatgptOnly")
      : "";
  }

  const methods = (
    [
      "create",
      "join",
      "https",
      "openai-tunnel",
      "local-code",
      "local-desktop",
    ] as const
  ).map((value) => ({
    value,
    label:
      value === "create"
        ? t("source.createRelay")
        : value === "join"
          ? t("source.pasteRelay")
          : value === "https"
            ? t("setup.ownAddress")
            : value === "openai-tunnel"
              ? "OpenAI Secure Tunnel"
              : value === "local-code"
                ? "Claude Code"
                : t("setup.claudeDesktop"),
    description:
      reason(value) ||
      (value === "create"
        ? t("setup.relayRecommended")
        : value === "https"
          ? t("setup.ownAddressHint")
          : value === "join"
            ? t("setup.joinHint")
            : undefined),
    disabled: !!reason(value),
  }));

  const methodName = methods.find((item) => item.value === method)!.label;
  const editing =
    step === "address" &&
    !operation &&
    ["https", "openai-tunnel"].includes(method);
  const waiting = !!operation && progress.phase !== "failed";

  async function cancelRelay() {
    setBusy(true);
    setError("");
    try {
      await api("relay/cancel", "POST");
      setOperation(undefined);
      return true;
    } catch (failure) {
      setError(String(failure));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const flow = onboarding.get();
  const stacked = Boolean(
    options.forSource || options.forSwitch || options.forConnections,
  );
  const parentTitle = options.forConnections
    ? t("connections.title")
    : options.forSwitch
      ? t("switch.sourceTitle", {
          name:
            sources.find((item) => item.id === connectionSwitch.get()?.sourceId)
              ?.label ?? "",
        })
      : flow?.source
        ? t("setup.addProduct", {
            name:
              flow.localTarget === "code"
                ? "Claude Code"
                : flow.localTarget === "desktop"
                  ? t("setup.claudeDesktop")
                  : (controlSource(flow.source)?.shortName ??
                    t("setup.otherClient")),
          })
        : t("addControlSource");

  return (
    <SetupFlow
      layerId={completion.layerId}
      title={t("source.newConnection")}
      steps={[
        { label: t("setup.method"), value: methodName },
        { label: t("source.step.address") },
        { label: t("setup.ready") },
      ]}
      active={steps.indexOf(step)}
      done={step === "success"}
      stacked={stacked}
      parentTitle={parentTitle}
      busy={busy || configBusy || waiting}
      dirty={draft.dirty || configDirty}
      onCancel={waiting ? cancelRelay : undefined}
      onClose={onClose}
      returnFocus={returnFocus}
      actionLayout={step === "method" || step === "success" ? "end" : "split"}
      footer={
        <>
          {step === "address" && !waiting && (
            <Button
              disabled={busy || configBusy}
              variant="ghost"
              onClick={() => {
                setError("");
                setStep("method");
              }}
            >
              {t("back")}
            </Button>
          )}
          {step === "method" && (
            <Button
              variant="primary"
              disabled={!!reason(method)}
              onClick={() => {
                setError("");
                setStep("address");
                if (method === "create") void startRelay();
              }}
            >
              {method === "create" && (
                <ExternalLink
                  size={15}
                  strokeWidth={1.75}
                  absoluteStrokeWidth
                  aria-hidden="true"
                />
              )}
              {t(method === "create" ? "setup.deploy" : "source.next")}
            </Button>
          )}
          {step === "address" && !operation && (
            <Button
              type="submit"
              form={formId}
              variant="primary"
              busy={busy || configBusy}
              disabled={
                !!reason(method) ||
                (!!target &&
                  (!local ||
                    !local[
                      target === "code" ? "codeAvailable" : "desktopAvailable"
                    ] ||
                    revoked))
              }
            >
              {t(
                editing
                  ? "setup.saveStart"
                  : method === "create"
                    ? "setup.deploy"
                    : "source.next",
              )}
            </Button>
          )}
          {waiting && (
            <>
              <DialogClose asChild>
                <Button variant="ghost">{t("cancel")}</Button>
              </DialogClose>
              <Button variant="primary" busy>
                {t("connect.inProgress")}
              </Button>
            </>
          )}
          {step === "success" && (
            <Button
              variant="primary"
              disabled={!created || busy}
              onClick={() => {
                if (!createdId) return;
                onAdded(createdId);
                if (!stacked) {
                  openOnboarding("product", {
                    ingressId: createdId,
                    fixedConnection: true,
                  });
                }
              }}
            >
              {t(
                stacked
                  ? "setup.continueConnection"
                  : "setup.addSourceForConnection",
              )}
            </Button>
          )}
        </>
      }
    >
      <PrivacyProvider hidden={hidden}>
        <div className="grid min-w-0 gap-5">
          {error && <Alert tone="danger">{protect(error)}</Alert>}
          {step === "method" && (
            <ConnectionMethodStepView
              label={t("connectionMethod")}
              value={method}
              secondaryFrom={stacked ? undefined : 3}
              onChange={(value) => {
                setMethod(value as ConnectionMethod);
                setError("");
              }}
              options={methods.filter((option) => !option.disabled)}
            />
          )}
          {["https", "openai-tunnel"].includes(method) && (
            <div hidden={!editing}>
              <IngressDialog
                key={method}
                setupFormId={formId}
                initialTransport={
                  method === "openai-tunnel" ? "openai-tunnel" : "https"
                }
                onBusy={setConfigBusy}
                onDirty={setConfigDirty}
                onClose={() => setStep("method")}
                onRemoved={onClose}
                onSaved={(entry) => {
                  complete(entry.id);
                  void perform(async () => {
                    await api(`ingress/${entry.id}/start`, "POST");
                    await refreshConnector();
                  });
                }}
              />
            </div>
          )}
          {step === "address" &&
            !editing &&
            (operation ? (
              <div className="grid min-w-0 gap-4">
                {progressError && (
                  <Alert tone="danger">{t("connect.readFailed")}</Alert>
                )}
                <RelayProgress
                  cancelInFooter={waiting}
                  progress={progress}
                  busy={busy}
                  account={account}
                  setAccount={setAccount}
                  onRetry={() => void startRelay(true)}
                />
              </div>
            ) : (
              <form
                className="grid min-w-0 gap-5"
                id={formId}
                onSubmit={(event) => {
                  event.preventDefault();
                  void configure();
                }}
              >
                {method === "join" && (
                  <ConnectionJoinStepView
                    linkId={`${formId}-link`}
                    linkLabel={t("connect.sharedLink")}
                    linkInput={
                      <SensitiveInput
                        id={`${formId}-link`}
                        required
                        type="url"
                        value={link}
                        onChange={(event) => setLink(event.target.value)}
                      />
                    }
                    deviceId={`${formId}-device`}
                    deviceLabel={t("setup.deviceName")}
                    deviceValue={deviceName}
                    onDeviceChange={setDeviceName}
                    visibilityHint={t("setup.hostSees")}
                  />
                )}
                {method === "create" && (
                  <p className="m-0 text-body leading-6 text-foreground">
                    {t("connection.relayLogin")}
                  </p>
                )}
                {target && (
                  <ConnectionLocalStepView
                    description={t("connection.localSetup", {
                      name: methodName,
                    })}
                    loading={!local && !error}
                    retryLabel={!local && error ? t("retry") : undefined}
                    retryBusy={busy}
                    onRetry={
                      !local && error
                        ? () =>
                            void perform(async () =>
                              setLocal(
                                await api<LocalAccess>("local-access/status"),
                              ),
                            )
                        : undefined
                    }
                    unavailableWarning={
                      local &&
                      !local[
                        target === "code" ? "codeAvailable" : "desktopAvailable"
                      ]
                        ? t("connect.unavailable")
                        : undefined
                    }
                    revokedWarning={
                      revoked ? t("source.revokedConnection") : undefined
                    }
                  />
                )}
              </form>
            ))}
          {step === "success" && (
            <ConnectionReadyStepView
              heading={t("connection.added")}
              connection={
                created
                  ? {
                      name: created.name,
                      online: created.state === "ready",
                      statusLabel: t(
                        created.state === "ready"
                          ? "connect.online"
                          : "connect.offline",
                      ),
                      sourceCountLabel: t("source.count", {
                        count: sources.filter(
                          (source) =>
                            source.ingressId === created.id &&
                            source.state !== "revoked" &&
                            !isPendingSource(source, status?.ingresses ?? []),
                        ).length,
                      }),
                      kindLabel: t(`source.kind.${connectionKind(created)}`),
                      address: created.url || undefined,
                      copyAddressLabel: t("source.copyAddress"),
                    }
                  : undefined
              }
              restartHint={target ? t("connect.restartClaude") : undefined}
              error={created?.error ? protect(created.error) : undefined}
              retryLabel={
                !created || created.state !== "ready" ? t("retry") : undefined
              }
              retryBusy={busy}
              onRetry={
                !created
                  ? () => void perform(refreshConnector)
                  : created.state !== "ready"
                    ? () =>
                        void perform(async () => {
                          await api(`ingress/${created.id}/start`, "POST");
                          await refreshConnector();
                        })
                    : undefined
              }
            />
          )}
        </div>
      </PrivacyProvider>
    </SetupFlow>
  );
}
