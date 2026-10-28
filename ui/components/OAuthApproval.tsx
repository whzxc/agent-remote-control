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

export function ApprovalCard({ request, ingress, inline = false, product, onDecided, onBusy }: { request: OAuthRequest; ingress: Ingress; inline?: boolean; product?: string; onDecided?: (allow: boolean) => void; onBusy?: (busy: boolean) => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [sourceId, setSourceId] = useState(request.switchSourceId || "new"), [label, setLabel] = useState(() => nextSourceName(product ?? request.product ?? "custom", connector.get().sources.filter(s => s.id !== request.sourceId).map(s => s.label))), [labelError, setLabelError] = useState("");
  const { status, sources } = connector.use();
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
    setBusy(true); setError("");
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
      <div className="pairing-code-panel"><span>{t("connect.compareCode")}</span><strong className="pairing-code">{request.pairingCode ?? "—"}</strong></div>
      {request.switchSourceId && <><div className="pairing-claim"><Tag>{t("switch.claim", { name: fixed?.label ?? request.switchSourceId })}</Tag></div><p className="pairing-summary">{t(fixed?.connectionRemoved ? "switch.detached" : "switch.remaining", { connection: oldConnection?.name ?? fixed?.connectionName ?? t("source.connectionRemoved"), names: remaining.map(s => s.label).join(", ") || t("switch.none") })}</p></>}
      {!request.switchSourceId && candidates.length > 0 && <SingleChoice label={t("source.authorization")} value={sourceId} onChange={setSourceId} disabled={busy} options={[{ value: "new", label: t("source.new") }, ...candidates.map(s => ({ value: s.id, label: t("source.reauthorize", { name: s.label }) }))]} />}
      {!request.switchSourceId && sourceId === "new" && <Field id={`approval-label-${request.id}`} label={t("setup.accountName")} error={labelError}>
        <Input id={`approval-label-${request.id}`} value={label} disabled={busy} aria-invalid={!!labelError} aria-describedby={labelError ? `approval-label-${request.id}-error` : undefined} onChange={e => { setLabel(e.target.value); setLabelError(""); }} />
      </Field>}
      <p className="pairing-fact">{t("connect.client", { name: request.clientName })}</p>
      <p className="pairing-fact">{t("connect.scope", { scope: ingress.toolPolicy === "all" ? t("connect.allPermissions") : t("connect.selectedPermissions") })}</p>
      {!inline && <div className="actions"><Button disabled={busy} onClick={() => void decide(false)}>{t("oauthDeny")}</Button><Button variant="primary" busy={busy} disabled={!request.switchSourceId && sourceId !== "new" && !candidates.some(s => s.id === sourceId)} onClick={() => void decide(true)}>{t("oauthAllow")}</Button></div>}
    </> : <p>{t(request.status === "approved" ? "connect.returning" : request.status === "denied" ? "oauthDenied" : "oauthFinished")}</p>}
    {error && <Notice tone="danger">{error}</Notice>}
  </form>;
}
export default function OAuthApproval({ requested, onClose, inlineEnabled }: { requested?: { id: string }; onClose: () => void; inlineEnabled: boolean }) {
  const { status } = connector.use(), savedFlow = onboarding.use(), switching = connectionSwitch.use();
  const flow = inlineEnabled ? savedFlow : undefined;
  const dismissed = useRef(new Set<string>());
  const [selectedId, setSelectedId] = useState<string>();
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
  const selected = requested ? requests.find(p => p.request.id === requested.id) : requests.find(p => p.request.id === selectedId && p.request.status === "pending" && !inFlow(p.request.id))
    ?? requests.find(p => p.request.status === "pending" && !dismissed.current.has(p.request.id) && !inFlow(p.request.id));
  useEffect(() => { if (selected) setSelectedId(selected.request.id); }, [selected?.request.id]);
  if (selected && inFlow(selected.request.id)) return null;
  if (!selected && !requested) return null;
  function close() { if (selected) dismissed.current.add(selected.request.id); setSelectedId(undefined); onClose(); }
  return <Dialog title={t("connect.approveTitle")} width={440} onClose={close}>
    {selected ? <ApprovalCard key={selected.request.id} {...selected} /> : <p>{t("oauthFinished")}</p>}
  </Dialog>;
}
