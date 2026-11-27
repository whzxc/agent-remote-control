import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { readOnlyBrowser } from "../browserMode";
import { nextSourceName } from "../controlSources";
import { t } from "../i18n";
import { sourceCandidates } from "../sourcePresentation";
import { connector, refreshConnector } from "../state/connector";
import { layers } from "../state/layers";
import { navigation } from "../state/navigation";
import {
  connectionSetup,
  connectionSwitch,
  onboarding,
} from "../state/onboarding";
import type { Ingress, OAuthRequest } from "../state/types";
import { OAuthApprovalView } from "./connectivity/OAuthApprovalView";
import { SetupApproval } from "./onboarding/SetupApproval";
import { Dialog } from "./ui";
import { DialogActions, useDialogCompletion } from "./ui/Dialog";
import { useSubmittedDirty } from "./ui/useSubmittedDirty";

export function ApprovalCard({
  request,
  ingress,
  inline = false,
  product,
  onDecided,
  onBusy,
  onDirty,
}: {
  request: OAuthRequest;
  ingress: Ingress;
  inline?: boolean;
  product?: string;
  onDecided?: (allow: boolean) => void;
  onBusy?: (busy: boolean) => void;
  onDirty?: (dirty: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sourceId, setSourceId] = useState(request.switchSourceId || "new");
  const [label, setLabel] = useState(() =>
    nextSourceName(
      product ?? request.product ?? "custom",
      connector
        .get()
        .sources.filter((source) => source.id !== request.sourceId)
        .map((source) => source.label),
    ),
  );
  const [labelError, setLabelError] = useState("");
  const { status, sources } = connector.use();
  const initialLabel = useRef(label);
  const draft = useSubmittedDirty(
    { label, sourceId },
    label !== initialLabel.current ||
      sourceId !== (request.switchSourceId || "new"),
  );

  useEffect(() => {
    onDirty?.(draft.dirty);
  }, [draft.dirty, onDirty]);

  const fixed = sources.find((source) => source.id === request.switchSourceId);
  const oldConnection = status?.ingresses.find(
    (item) => item.id === fixed?.ingressId,
  );
  const remaining = sources.filter(
    (source) =>
      source.ingressId === fixed?.ingressId &&
      source.id !== fixed?.id &&
      source.state !== "revoked" &&
      source.connectedAt !== null,
  );
  const candidates = sourceCandidates(
    sources,
    status?.ingresses ?? [],
    ingress.id,
    product ?? request.product ?? "custom",
    request.sourceId,
  );

  useEffect(() => {
    onBusy?.(busy);
    return () => onBusy?.(false);
  }, [busy, onBusy]);

  async function decide(allow: boolean) {
    if (
      busy ||
      (allow &&
        !request.switchSourceId &&
        sourceId !== "new" &&
        !candidates.some((source) => source.id === sourceId))
    ) {
      return;
    }
    if (
      allow &&
      sourceId === "new" &&
      new TextEncoder().encode(label.trim()).length > 120
    ) {
      setLabelError(t("sourceNameTooLong"));
      document.getElementById(`approval-label-${request.id}`)?.focus();
      return;
    }
    draft.submit();
    setBusy(true);
    setError("");
    try {
      if (allow && request.sourceId) {
        if (!request.switchSourceId && (product || (sourceId === "new" && label.trim()))) {
          await api(`source/${request.sourceId}`, "PUT", {
            ...(product ? { product } : {}),
            ...(sourceId === "new" && label.trim()
              ? { label: label.trim() }
              : {}),
          });
        }
        await api(`source/${request.sourceId}/claim`, "POST", { sourceId });
      } else {
        await api(`ingress/${ingress.id}/oauth/decision`, "POST", {
          id: request.id,
          allow,
          sourceId,
        });
      }
      await refreshConnector();
      onDecided?.(allow);
    } catch (e) {
      setError(`${t("connect.approvalFailed")} ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <SetupApproval
      id={`approval-${request.id}`}
      className={inline ? "pairing-inline" : ""}
      aria-live="polite"
      onSubmit={(event) => {
        event.preventDefault();
        void decide(
          (event.nativeEvent as SubmitEvent).submitter?.getAttribute("value") !==
            "deny",
        );
      }}
    >
      <OAuthApprovalView
        pending={request.status === "pending"}
        statusMessage={t(
          request.status === "approved"
            ? "connect.returning"
            : request.status === "denied"
              ? "oauthDenied"
              : "oauthFinished",
        )}
        inline={inline}
        pairingCode={request.pairingCode ?? "—"}
        compareCodeLabel={t("connect.compareCode")}
        clientText={t("connect.client", { name: request.clientName })}
        scopeText={t("connect.scope", {
          scope:
            ingress.toolPolicy === "all"
              ? t("connect.allPermissions")
              : t("connect.selectedPermissions"),
        })}
        switchClaimLabel={
          request.switchSourceId
            ? t("switch.claim", {
                name: fixed?.label ?? request.switchSourceId,
              })
            : undefined
        }
        switchSummary={
          request.switchSourceId
            ? t(
                fixed?.connectionRemoved
                  ? "switch.detached"
                  : "switch.remaining",
                {
                  connection:
                    oldConnection?.name ??
                    fixed?.connectionName ??
                    t("source.connectionRemoved"),
                  names:
                    remaining.map((source) => source.label).join(", ") ||
                    t("switch.none"),
                },
              )
            : undefined
        }
        authorizationLabel={t("source.authorization")}
        authorizationValue={sourceId}
        authorizationOptions={
          !request.switchSourceId && candidates.length > 0
            ? [
                { value: "new", label: t("source.new") },
                ...candidates.map((source) => ({
                  value: source.id,
                  label: t("source.reauthorize", { name: source.label }),
                })),
              ]
            : []
        }
        onAuthorizationChange={setSourceId}
        showAccountName={!request.switchSourceId && sourceId === "new"}
        accountNameId={`approval-label-${request.id}`}
        accountNameLabel={t("setup.accountName")}
        accountName={label}
        accountNameError={labelError || undefined}
        onAccountNameChange={(next) => {
          setLabel(next);
          setLabelError("");
        }}
        disabled={readOnlyBrowser}
        busy={busy}
        denyLabel={t("oauthDeny")}
        allowLabel={t("oauthAllow")}
        allowDisabled={
          !request.switchSourceId &&
          sourceId !== "new" &&
          !candidates.some((source) => source.id === sourceId)
        }
        onDeny={() => void decide(false)}
        onAllow={() => void decide(true)}
        actionsWrapper={(actions) => (
          <DialogActions className="actions">{actions}</DialogActions>
        )}
        error={error || undefined}
      />
    </SetupApproval>
  );
}

export default function OAuthApproval({
  requested,
  onClose,
  inlineEnabled,
}: {
  requested?: { id: string };
  onClose: () => void;
  inlineEnabled: boolean;
}) {
  const { status } = connector.use();
  const savedFlow = onboarding.use();
  const switching = connectionSwitch.use();
  const flow = inlineEnabled ? savedFlow : undefined;
  const dismissed = useRef(new Set<string>());
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [resolved, setResolved] = useState<{
    ingress: Ingress;
    request: OAuthRequest;
  }>();
  const completion = useDialogCompletion(close);
  const keepAfterWork = layers
    .use()
    .find((layer) => layer.id === completion.layerId)?.keepAfterWork;
  const previousSelection = useRef<
    { ingress: Ingress; request: OAuthRequest } | undefined
  >(undefined);
  const requests =
    status?.ingresses.flatMap((ingress) =>
      (ingress.oauth?.pending ?? []).map((request) => ({ ingress, request })),
    ) ?? [];

  useEffect(() => {
    if (!requested) return;
    const target = requests.find((item) => item.request.id === requested.id);
    if (!target) return;
    dismissed.current.delete(requested.id);
    connectionSetup.set(undefined);
    if (target.request.switchSourceId) {
      onboarding.set(undefined);
      navigation.set((old) => ({
        ...old,
        page: "overview",
        connectionsOpen: true,
        remoteSourceId: target.request.switchSourceId,
        remoteConnectionId: undefined,
      }));
      connectionSwitch.set({
        sourceId: target.request.switchSourceId,
        ingressId: target.ingress.id,
        requestId: target.request.id,
        step: "approval",
      });
      onClose();
      return;
    }
    navigation.set((old) => ({ ...old, page: "overview" }));
    onboarding.set((old) => ({
      ...(old?.ingressId === target.ingress.id ? old : {}),
      step: "approval",
      ingressId: target.ingress.id,
      source: target.request.product ?? target.ingress.controlSource,
      requestId: requested.id,
    }));
    onClose();
  }, [requested, status]);

  const inFlow = (id: string) =>
    requests.some(
      (item) =>
        item.request.id === id &&
        item.request.switchSourceId === switching?.sourceId &&
        !!switching,
    ) ||
    requests.some(
      (item) =>
        item.request.id === id &&
        item.ingress.id === flow?.ingressId &&
        ["address", "approval"].includes(flow.step),
    );

  const candidate = requested
    ? requests.find((item) => item.request.id === requested.id)
    : undefined;
  const selected = keepAfterWork
    ? (resolved ?? previousSelection.current ?? candidate)
    : candidate;

  useEffect(() => {
    if (selected) previousSelection.current = selected;
  }, [selected]);

  if (selected && inFlow(selected.request.id)) return null;
  if (!selected && !requested) return null;

  function close() {
    if (selected) dismissed.current.add(selected.request.id);
    setResolved(undefined);
    previousSelection.current = undefined;
    onClose();
  }

  return (
    <Dialog
      layerId={completion.layerId}
      dirty={dirty}
      busy={busy}
      title={t("connect.approveTitle")}
      onClose={close}
    >
      {selected ? (
        <ApprovalCard
          key={selected.request.id}
          {...selected}
          onBusy={setBusy}
          onDirty={setDirty}
          onDecided={(allow) => {
            setResolved({
              ...selected,
              request: {
                ...selected.request,
                status: allow ? "approved" : "denied",
              },
            });
            setDirty(false);
            void completion.finish();
          }}
        />
      ) : (
        <p>{t("oauthFinished")}</p>
      )}
    </Dialog>
  );
}
