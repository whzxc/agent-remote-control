import { useEffect, useState } from "react";
import { ExternalLink, Plus } from "lucide-react";
import { api } from "../api";
import { controlSource } from "../controlSources";
import { locale, t } from "../i18n";
import { openUrl } from "../platform";
import { connector, refreshConnector } from "../state/connector";
import { connectionSwitch, openConnectionSetup } from "../state/onboarding";
import { connectionDisabledReason, connectionKind, isPendingSource } from "../sourcePresentation";
import type { Ingress } from "../state/types";
import SetupDialog from "./SetupDialog";
import { ApprovalCard } from "./OAuthApproval";
import { Button, CopyField, Field, Icon, Loading, Notice, SingleChoice } from "./ui";

const steps = ["connection", "address", "approval"] as const;
export default function ChangeConnection() {
  const flow = connectionSwitch.use()!, { status, sources } = connector.use();
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [credentials, setCredentials] = useState<{ ingressId: string; bearerToken: string }>();
  const source = sources.find(s => s.id === flow.sourceId);
  const entries = status?.ingresses ?? [], current = entries.find(i => i.id === source?.ingressId), target = entries.find(i => i.id === flow.ingressId);
  const info = controlSource(source?.product ?? "custom"), productName = info?.shortName ?? t("connect.other");
  const settingsUrl = info?.setup?.url;
  const addressInstruction = t(info?.setup?.editableUrl === true ? "switch.editAddress" : "switch.replaceConnector", { name: productName });
  const request = target?.oauth?.pending.find(p => p.id === flow.requestId || p.switchSourceId === source?.id && p.status === "pending");
  function reason(i: Ingress) {
    if (i.id === source?.ingressId) return t("switch.current");
    if (i.auth !== "oauth" && sources.some(s => s.ingressId === i.id)) return t("setup.connectionOccupied");
    return connectionDisabledReason(i, source?.product ?? "custom", sources);
  }
  const connections = entries.filter(i => i.transport !== "openai-tunnel" || source?.product === "chatgpt");
  useEffect(() => {
    if (flow.step === "address" && request?.status === "pending") connectionSwitch.set(old => old && { ...old, step: "approval", requestId: request.id });
  }, [flow.step, request?.id, request?.status]);
  useEffect(() => {
    if (source && flow.ingressId && flow.step !== "connection" && source.ingressId === flow.ingressId && source.state === "connected") connectionSwitch.set(undefined);
  }, [source, flow.ingressId, flow.step]);
  useEffect(() => {
    setCredentials(undefined);
    if (flow.step !== "address" || target?.auth !== "bearer") return;
    let alive = true;
    void api<{ bearerToken: string }>(`ingress/${target.id}/credentials`, "POST").then(value => { if (alive) setCredentials({ ingressId: target.id, bearerToken: value.bearerToken }); }).catch(e => { if (alive) setError(String(e)); });
    return () => { alive = false; };
  }, [flow.step, target?.id, target?.auth]);
  async function perform(action: () => Promise<void>) {
    setBusy(true); setError("");
    try { await action(); } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }
  async function cancel(close: boolean) {
    await perform(async () => {
      await api(`source/${flow.sourceId}/switch`, "DELETE"); await refreshConnector();
      connectionSwitch.set(close ? undefined : { sourceId: flow.sourceId, step: "connection", ingressId: flow.ingressId });
    });
  }
  async function begin() {
    if (!target || reason(target)) return;
    await perform(async () => {
      await api(`source/${flow.sourceId}/switch`, "POST", { ingressId: target.id });
      await refreshConnector(); connectionSwitch.set({ ...flow, step: "address", requestId: undefined });
    });
  }
  const expired = flow.step !== "connection" && ((!source?.pendingSwitch && source?.ingressId !== flow.ingressId) || request?.status === "expired" || request?.status === "denied");
  const canApprove = request?.status === "pending" && !expired;
  return <SetupDialog title={t("switch.sourceTitle", { name: source?.label ?? flow.sourceId })} active={steps.indexOf(flow.step)} busy={busy}
    steps={[{ label: t("source.step.connection"), value: target?.name }, { label: t("switch.address") }, { label: t("switch.reauthorize") }]}
    returnFocus="[data-change-connection]" onClose={() => cancel(true)} footer={<>
      {flow.step === "approval" && canApprove ? <><Button form={`approval-${request.id}`} type="submit" value="deny" disabled={busy}>{t("oauthDeny")}</Button><Button form={`approval-${request.id}`} type="submit" value="allow" variant="primary" busy={busy}>{t("switch.approve")}</Button></> : <>
        <Button variant="ghost" disabled={busy} onClick={() => void cancel(flow.step === "connection")}>{t(flow.step === "connection" ? "cancel" : "back")}</Button>
        {flow.step === "connection" ? <Button variant="primary" busy={busy} disabled={!target || !!reason(target)} onClick={() => void begin()}>{t("source.next")}</Button> : !expired && <Loading label={t(request?.status === "approved" ? "connect.returning" : "connect.waitClient", { name: productName })} />}
      </>}
    </>}>
    <div className="setup-content">
      {error && <Notice>{error}</Notice>}
      {flow.step === "connection" ? <>
        <p>{t("switch.currentVia", { name: current?.name ?? source?.connectionName ?? t("source.connectionRemoved") })}</p>
        <SingleChoice cards label={t("source.connections")} value={flow.ingressId ?? ""} onChange={ingressId => connectionSwitch.set({ ...flow, ingressId })} disabled={busy} options={connections.map(i => ({ value: i.id, label: i.name, disabled: !!reason(i), description: reason(i) || [t(`source.kind.${connectionKind(i)}`), t(i.state === "ready" ? "connect.online" : "connect.offline"), sources.filter(s => s.ingressId === i.id && s.state !== "revoked" && !isPendingSource(s, entries)).map(s => s.label).join(", ")].filter(Boolean).join(" · ") }))} />
        <Button className="setup-new" data-add-connection disabled={busy} onClick={() => openConnectionSetup({ forSwitch: true, product: source?.product })}><Icon icon={Plus} /><span>{t("source.newConnection")}<small>{t("setup.newConnectionHint")}</small></span></Button>
        <Notice tone="warning">{addressInstruction} {t("switch.warning")}</Notice>
      </> : <>
        {target ? <>
          <CopyField value={target.url || target.config.tunnelId} label={t("source.copyAddress")} />
          {credentials?.ingressId === target.id && <Field label={t("source.bearerHeader")}><CopyField password value={`Bearer ${credentials.bearerToken}`} label={t("source.bearerHeader")} /></Field>}
          {flow.step === "address" && <><p>{addressInstruction}</p><h3>{t("setup.configureProduct", { name: productName })}</h3><p>{info?.setup?.path[locale.get()] ?? t("connect.customPath")}</p>
            {settingsUrl && <Button onClick={() => void perform(() => openUrl(settingsUrl))}>{t("connect.openSettings", { name: productName })}<Icon icon={ExternalLink} /></Button>}
            <p>{t(target.auth === "oauth" ? "setup.browserCode" : "source.noOAuthApproval")}</p>
            {target.state !== "ready" && <Button busy={busy} onClick={() => void perform(async () => { await api(`ingress/${target.id}/start`, "POST"); await refreshConnector(); })}>{t("retry")}</Button>}
          </>}
          {flow.step === "approval" && request && <ApprovalCard key={request.id} request={request} ingress={target} inline onBusy={setBusy} onDecided={allow => { if (!allow) connectionSwitch.set({ sourceId: flow.sourceId, ingressId: flow.ingressId, step: "connection" }); }} />}
        </> : <Notice>{t("source.connectionRemoved")}</Notice>}
        {expired && <Notice tone="warning">{t("switch.expired")}</Notice>}
      </>}
    </div>
  </SetupDialog>;
}
