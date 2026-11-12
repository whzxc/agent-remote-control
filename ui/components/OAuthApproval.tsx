import { useSubmittedDirty } from "./ui/useSubmittedDirty";
import { DialogActions, useDialogCompletion } from "./ui/Dialog";
import { layers } from "../state/layers";
import { readOnlyBrowser } from "../browserMode";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { nextSourceName } from "../controlSources";
import { t } from "../i18n";
import { connector, refreshConnector } from "../state/connector";
import { onboarding, connectionSetup, connectionSwitch } from "../state/onboarding";
import { navigation } from "../state/navigation";
import { sourceCandidates } from "../sourcePresentation";
import type { Ingress, OAuthRequest } from "../state/types";
import { Button, Dialog, Field, Input, Notice, SingleChoice, Tag } from "./ui";
import { Card } from "./ui/card";

export function ApprovalCard({ request, ingress, inline = false, product, onDecided, onBusy, onDirty }: { request: OAuthRequest; ingress: Ingress; inline?: boolean; product?: string; onDecided?: (allow: boolean) => void; onBusy?: (busy: boolean) => void; onDirty?: (dirty: boolean) => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [sourceId, setSourceId] = useState(request.switchSourceId || "new"), [label, setLabel] = useState(() => nextSourceName(product ?? request.product ?? "custom", connector.get().sources.filter(s => s.id !== request.sourceId).map(s => s.label))), [labelError, setLabelError] = useState("");
  const { status, sources } = connector.use();
  const initialLabel = useRef(label);
  const draft = useSubmittedDirty({ label, sourceId }, label !== initialLabel.current || sourceId !== (request.switchSourceId || "new"));
  useEffect(() => { onDirty?.(draft.dirty); }, [draft.dirty, onDirty]);
  const fixed = sources.find(s => s.id === request.switchSourceId);
  const oldConnection = status?.ingresses.find(i => i.id === fixed?.ingressId);
  const remaining = sources.filter(s => s.ingressId === fixed?.ingressId && s.id !== fixed?.id && s.state !== "revoked" && s.connectedAt !== null);
  const candidates = sourceCandidates(sources, status?.ingresses ?? [], ingress.id, product ?? request.product ?? "custom", request.sourceId);
  useEffect(() => { onBusy?.(busy); return () => onBusy?.(false); }, [busy, onBusy]);
  async function decide(allow: boolean) {
    if (busy || allow && !request.switchSourceId && sourceId !== "new" && !candidates.some(s => s.id === sourceId)) return;
    if (allow && sourceId === "new" && new TextEncoder().encode(label.trim()).length > 120) {
      setLabelError(t("sourceNameTooLong")); document.getElementById(`approval-label-${request.id}`)?.focus(); return;
    }
    draft.submit(); setBusy(true); setError("");
    try {
      if (allow && request.sourceId) {
        if (!request.switchSourceId && (product || sourceId === "new" && label.trim())) await api(`source/${request.sourceId}`, "PUT", { ...(product ? { product } : {}), ...(sourceId === "new" && label.trim() ? { label: label.trim() } : {}) });
        await api(`source/${request.sourceId}/claim`, "POST", { sourceId });
      } else await api(`ingress/${ingress.id}/oauth/decision`, "POST", { id: request.id, allow, sourceId });
      await refreshConnector(); onDecided?.(allow);
    } catch (e) { setError(`${t("connect.approvalFailed")} ${String(e)}`); }
    finally { setBusy(false); }
  }
  return <form id={`approval-${request.id}`} className={`pairing-card ${inline ? "pairing-inline" : ""}`} aria-live="polite" onSubmit={e => { e.preventDefault(); void decide((e.nativeEvent as SubmitEvent).submitter?.getAttribute("value") !== "deny"); }}>
    {request.status === "pending" ? <>
      {inline ? <Card className="pairing-code-panel"><div className="pairing-code-heading"><strong className="pairing-code">{request.pairingCode ?? "—"}</strong><span>{t("connect.compareCode")}</span></div>
        <p className="pairing-fact">{t("connect.client", { name: request.clientName })} · {t("connect.scope", { scope: ingress.toolPolicy === "all" ? t("connect.allPermissions") : t("connect.selectedPermissions") })}</p>
      </Card> : <div className="pairing-code-panel"><span>{t("connect.compareCode")}</span><strong className="pairing-code">{request.pairingCode ?? "—"}</strong></div>}
      {request.switchSourceId && <><div className="pairing-claim"><Tag>{t("switch.claim", { name: fixed?.label ?? request.switchSourceId })}</Tag></div><p className="pairing-summary">{t(fixed?.connectionRemoved ? "switch.detached" : "switch.remaining", { connection: oldConnection?.name ?? fixed?.connectionName ?? t("source.connectionRemoved"), names: remaining.map(s => s.label).join(", ") || t("switch.none") })}</p></>}
      {!request.switchSourceId && candidates.length > 0 && <SingleChoice fill={inline} label={t("source.authorization")} value={sourceId} onChange={setSourceId} disabled={readOnlyBrowser || busy} options={[{ value: "new", label: t("source.new") }, ...candidates.map(s => ({ value: s.id, label: t("source.reauthorize", { name: s.label }) }))]} />}
      {!request.switchSourceId && sourceId === "new" && <Field id={`approval-label-${request.id}`} label={t("setup.accountName")} error={labelError}>
        <Input id={`approval-label-${request.id}`} value={label} disabled={readOnlyBrowser || busy} aria-invalid={!!labelError} aria-describedby={labelError ? `approval-label-${request.id}-error` : undefined} onChange={e => { setLabel(e.target.value); setLabelError(""); }} />
      </Field>}
      {!inline && <><p className="pairing-fact">{t("connect.client", { name: request.clientName })}</p><p className="pairing-fact">{t("connect.scope", { scope: ingress.toolPolicy === "all" ? t("connect.allPermissions") : t("connect.selectedPermissions") })}</p></>}
      {!inline && <DialogActions className="actions"><Button disabled={readOnlyBrowser || busy} onClick={() => void decide(false)}>{t("oauthDeny")}</Button><Button variant="primary" busy={busy} disabled={readOnlyBrowser || !request.switchSourceId && sourceId !== "new" && !candidates.some(s => s.id === sourceId)} onClick={() => void decide(true)}>{t("oauthAllow")}</Button></DialogActions>}
    </> : <p>{t(request.status === "approved" ? "connect.returning" : request.status === "denied" ? "oauthDenied" : "oauthFinished")}</p>}
    {error && <Notice tone="danger">{error}</Notice>}
  </form>;
}
export default function OAuthApproval({ requested, onClose, inlineEnabled }: { requested?: { id: string }; onClose: () => void; inlineEnabled: boolean }) {
  const { status } = connector.use(), savedFlow = onboarding.use(), switching = connectionSwitch.use();
  const flow = inlineEnabled ? savedFlow : undefined;
  const dismissed = useRef(new Set<string>());
  const [busy, setBusy] = useState(false), [dirty, setDirty] = useState(false);
  const [resolved, setResolved] = useState<{ ingress: Ingress; request: OAuthRequest }>();
  const completion = useDialogCompletion(close);
  const keepAfterWork = layers.use().find(layer => layer.id === completion.layerId)?.keepAfterWork;
  const previousSelection = useRef<{ ingress: Ingress; request: OAuthRequest } | undefined>(undefined);
  const requests = status?.ingresses.flatMap(ingress => (ingress.oauth?.pending ?? []).map(request => ({ ingress, request }))) ?? [];
  useEffect(() => {
    if (!requested) return;
    const target = requests.find(p => p.request.id === requested.id);
    if (!target) return;
    dismissed.current.delete(requested.id);
    connectionSetup.set(undefined);
    if (target.request.switchSourceId) {
      onboarding.set(undefined);
      navigation.set(old => ({ ...old, page: "overview", connectionsOpen: true, remoteSourceId: target.request.switchSourceId, remoteConnectionId: undefined }));
      connectionSwitch.set({ sourceId: target.request.switchSourceId, ingressId: target.ingress.id, requestId: target.request.id, step: "approval" });
      onClose(); return;
    }
    navigation.set(old => ({ ...old, page: "overview" }));
    onboarding.set(old => ({ ...(old?.ingressId === target.ingress.id ? old : {}), step: "approval", ingressId: target.ingress.id,
      source: target.request.product ?? target.ingress.controlSource, requestId: requested.id }));
    onClose();
  }, [requested, status]);
  const inFlow = (id: string) => requests.some(p => p.request.id === id && p.request.switchSourceId === switching?.sourceId && !!switching) || requests.some(p => p.request.id === id && p.ingress.id === flow?.ingressId && ["address", "approval"].includes(flow.step));
  const candidate = requested ? requests.find(p => p.request.id === requested.id) : undefined;
  const selected = keepAfterWork ? resolved ?? previousSelection.current ?? candidate : candidate;
  useEffect(() => { if (selected) { previousSelection.current = selected; } }, [selected]);
  if (selected && inFlow(selected.request.id)) return null;
  if (!selected && !requested) return null;
  function close() { if (selected) dismissed.current.add(selected.request.id); setResolved(undefined); previousSelection.current = undefined; onClose(); }
  return <Dialog layerId={completion.layerId} dirty={dirty} busy={busy} title={t("connect.approveTitle")} onClose={close}>
    {selected ? <ApprovalCard key={selected.request.id} {...selected} onBusy={setBusy} onDirty={setDirty} onDecided={allow => {
      setResolved({ ...selected, request: { ...selected.request, status: allow ? "approved" : "denied" } });
      setDirty(false); void completion.finish();
    }} /> : <p>{t("oauthFinished")}</p>}
  </Dialog>;
}
