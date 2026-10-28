import { useEffect, useId, useState } from "react";
import { Check, ExternalLink } from "lucide-react";
import { api } from "../api";
import { controlSource } from "../controlSources";
import { t } from "../i18n";
import { connector, refreshConnector } from "../state/connector";
import { onboarding, openOnboarding, connectionSwitch, type ConnectionSetup, type ConnectionMethod } from "../state/onboarding";
import { connectionKind, isPendingSource } from "../sourcePresentation";
import { useRelayProgress, type RelayProgress as Progress } from "../state/relay";
import { SensitiveInput, useSensitiveText } from "./Sensitive";
import IngressDialog from "./IngressDialog";
import RelayProgress from "./RelayProgress";
import SetupDialog from "./SetupDialog";
import { Button, CopyField, Field, Icon, Input, Loading, Notice, SingleChoice, Status } from "./ui";

type LocalAccess = { codeAvailable: boolean; desktopAvailable: boolean };
const steps = ["method", "address", "success"] as const;
export default function AddConnection({ options, onClose, onAdded, returnFocus }: { options: ConnectionSetup; onClose: () => void; onAdded: (id: string) => void; returnFocus?: string }) {
  const { status, sources } = connector.use();
  const [step, setStep] = useState<typeof steps[number]>(options.step ?? (options.method ? "address" : "method"));
  const [method, setMethod] = useState<ConnectionMethod>(options.localTarget ? `local-${options.localTarget}` : options.method ?? "create");
  const [busy, setBusy] = useState(false), [configBusy, setConfigBusy] = useState(false), [error, setError] = useState("");
  const [link, setLink] = useState(""), [account, setAccount] = useState(""), [deviceName, setDeviceName] = useState(status?.deviceName ?? "");
  const protect = useSensitiveText([link]);
  const [createdId, setCreatedId] = useState<string | undefined>(options.createdId);
  const [operation, setOperation] = useState<"create" | "join" | "redeploy">();
  const [local, setLocal] = useState<LocalAccess>();
  const formId = useId(), target = method === "local-code" ? "code" : method === "local-desktop" ? "desktop" : undefined;
  const created = status?.ingresses.find(i => i.id === createdId);
  const revoked = !!target && sources.some(s => s.ingressId === `local-claude-${target}` && s.state === "revoked");
  const { progress, setProgress, error: progressError } = useRelayProgress(!!operation, value => {
    if (!value.result?.ingressId) return;
    setOperation(undefined); complete(value.result.ingressId);
    void refreshConnector().catch(e => setError(String(e)));
  });
  useEffect(() => {
    let alive = true;
    void api<Progress>("relay/progress").then(value => {
      if (!alive) return;
      if (!["login", "deploying", "connecting"].includes(value.phase) || !["create", "join", "redeploy"].includes(value.action ?? "")) {
        if (options.method === "create" && !options.step) void startRelay();
        return;
      }
      setProgress(value); setOperation(value.action as "create" | "join" | "redeploy"); setStep("address");
      setMethod(value.action === "join" ? "join" : "create");
    }).catch(() => {});
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    if (!target) return;
    let alive = true;
    void api<LocalAccess>("local-access/status").then(value => { if (alive) setLocal(value); }).catch(e => { if (alive) setError(String(e)); });
    return () => { alive = false; };
  }, [target]);
  async function perform(action: () => Promise<void>) {
    setBusy(true); setError("");
    try { await action(); }
    catch (e) { setError(String(e).includes("LOCAL_CONFIG_CONFLICT") ? t("connect.localConflict") : String(e)); }
    finally { setBusy(false); }
  }
  function complete(id: string) { setCreatedId(id); setStep("success"); }
  async function startRelay(retry = false) {
    const action = retry && progress.relayId && operation !== "join" ? "redeploy" : retry ? operation ?? "create" : method as "create" | "join";
    await perform(async () => {
      const value = await api<Progress>(`relay/${action}`, "POST", action === "join" ? { link: link.trim(), name: deviceName.trim() } : { ...(retry && progress.relayId ? { id: progress.relayId } : {}), ...(account ? { accountId: account } : {}), name: status?.deviceName || t("connect.thisComputer") });
      setProgress(value); setOperation(action);
    });
  }
  async function configure() {
    if (!target) { await startRelay(); return; }
    await perform(async () => {
      const result = await api<{ ingressId: string }>("local-access/install", "POST", { target });
      complete(result.ingressId); await refreshConnector();
    });
  }
  function reason(value: ConnectionMethod) {
    if (options.localTarget) return value !== `local-${options.localTarget}` ? t("setup.localOnly") : "";
    if (value.startsWith("local-") && options.product) return t("setup.localOnly");
    return value === "openai-tunnel" && options.product && options.product !== "chatgpt" ? t("setup.chatgptOnly") : "";
  }
  const methods = (["create", "join", "https", "openai-tunnel", "local-code", "local-desktop"] as const).map(value => ({ value,
    label: value === "create" ? t("source.createRelay") : value === "join" ? t("source.pasteRelay") : value === "https" ? t("setup.ownAddress") : value === "openai-tunnel" ? "OpenAI Secure Tunnel" : value === "local-code" ? "Claude Code" : t("setup.claudeDesktop"),
    description: reason(value) || (value === "create" ? t("setup.relayRecommended") : value === "https" ? t("setup.ownAddressHint") : value === "join" ? t("setup.joinHint") : undefined), disabled: !!reason(value) }));
  const methodName = methods.find(m => m.value === method)!.label;
  const editing = step === "address" && !operation && ["https", "openai-tunnel"].includes(method);
  const waiting = !!operation && progress.phase !== "failed";
  const flow = onboarding.get();
  const parentTitle = options.forSwitch ? t("switch.sourceTitle", { name: sources.find(s => s.id === connectionSwitch.get()?.sourceId)?.label ?? "" }) : flow?.source ? t("setup.addProduct", { name: flow.localTarget === "code" ? "Claude Code" : flow.localTarget === "desktop" ? t("setup.claudeDesktop") : controlSource(flow.source)?.shortName ?? t("setup.otherClient") }) : t("addControlSource");
  return <SetupDialog title={t("source.newConnection")} steps={[{ label: t("setup.method"), value: methodName }, { label: t("source.step.address") }, { label: t("setup.ready") }]}
    active={steps.indexOf(step)} done={step === "success"} stacked={(options.forSource || options.forSwitch)} parentTitle={parentTitle} busy={busy || configBusy} onClose={onClose}
    returnFocus={returnFocus}
    footer={<>
      {step !== "success" && <Button disabled={busy || configBusy || waiting} variant="ghost" onClick={() => step === "method" ? onClose() : (setError(""), setStep("method"))}>{t("back")}</Button>}
      {step === "method" && <Button variant="primary" disabled={!!reason(method)} onClick={() => { setError(""); setStep("address"); if (method === "create") void startRelay(); }}>{t(method === "create" ? "setup.deploy" : "source.next")}{method === "create" && <Icon icon={ExternalLink} />}</Button>}
      {step === "address" && !operation && <Button type="submit" form={formId} variant="primary" busy={busy || configBusy} disabled={!!reason(method) || !!target && (!local || !local[target === "code" ? "codeAvailable" : "desktopAvailable"] || revoked)}>{t(editing ? "setup.saveStart" : method === "create" ? "setup.deploy" : "source.next")}</Button>}
      {waiting && <Loading label={t("connect.inProgress")} />}
      {step === "success" && <>{!(options.forSource || options.forSwitch) && <Button onClick={onClose}>{t("source.done")}</Button>}<span className="spacer" /><Button variant="primary" disabled={!created || busy} onClick={() => { if (!createdId) return; onAdded(createdId); if (!(options.forSource || options.forSwitch)) openOnboarding("product", { ingressId: createdId, fixedConnection: true }); }}>{t((options.forSource || options.forSwitch) ? "setup.continueConnection" : "setup.addSourceForConnection")}</Button></>}
    </>}>
    <div className={`setup-content ${step === "method" ? "setup-methods" : ""}`}>
      {error && <Notice>{protect(error)}</Notice>}
      {step === "method" && <SingleChoice cards label={t("connectionMethod")} value={method} onChange={value => { setMethod(value as ConnectionMethod); setError(""); }} options={methods.filter(option => !option.disabled)} />}
      {["https", "openai-tunnel"].includes(method) && <div hidden={!editing}><IngressDialog key={method} setupFormId={formId}
        initialTransport={method === "openai-tunnel" ? "openai-tunnel" : "https"} onBusy={setConfigBusy} onClose={() => setStep("method")} onRemoved={onClose} onSaved={entry => {
          complete(entry.id); void perform(async () => { await api(`ingress/${entry.id}/start`, "POST"); await refreshConnector(); });
        }} /></div>}
      {step === "address" && !editing && (operation ? <>
        {progressError && <Notice>{t("connect.readFailed")}</Notice>}
        <RelayProgress progress={progress} busy={busy} account={account} setAccount={setAccount} onRetry={() => void startRelay(true)} onCancel={() => void perform(async () => { await api("relay/cancel", "POST"); setOperation(undefined); })} />
      </> : <form className="setup-form" id={formId} onSubmit={e => { e.preventDefault(); void configure(); }}>
        {method === "join" && <>
          <Field id={`${formId}-link`} label={t("connect.sharedLink")}><SensitiveInput id={`${formId}-link`} required type="url" value={link} onChange={e => setLink(e.target.value)} /></Field>
          <Field id={`${formId}-device`} label={t("setup.deviceName")}><Input id={`${formId}-device`} required value={deviceName} onChange={e => setDeviceName(e.target.value)} /></Field><p className="muted">{t("setup.hostSees")}</p>
        </>}
        {method === "create" && <p>{t("connection.relayLogin")}</p>}
        {target && <>
          <p>{t("connection.localSetup", { name: methodName })}</p>
          {!local && !error && <Loading />}
          {!local && error && <Button busy={busy} onClick={() => void perform(async () => setLocal(await api<LocalAccess>("local-access/status")))}>{t("retry")}</Button>}
          {local && !local[target === "code" ? "codeAvailable" : "desktopAvailable"] && <Notice tone="warning">{t("connect.unavailable")}</Notice>}
          {revoked && <Notice tone="warning">{t("source.revokedConnection")}</Notice>}
        </>}
      </form>)}
      {step === "success" && <div className="setup-success"><span className="setup-success-mark"><Icon icon={Check} size={20} /></span><h3>{t("connection.added")}</h3>
        {created && <div className="setup-connection-card"><strong>{created.name}</strong><span>{t(`source.kind.${connectionKind(created)}`)}</span>
          {created.url && <CopyField value={created.url} label={t("source.copyAddress")} />}<Status tone={created.state === "ready" ? "success" : "neutral"}>{t(created.state === "ready" ? "connect.online" : "connect.offline")}</Status>
          <span className="muted">{t("source.count", { count: sources.filter(s => s.ingressId === created.id && s.state !== "revoked" && !isPendingSource(s, status?.ingresses ?? [])).length })}</span></div>}
        {target && <p>{t("connect.restartClaude")}</p>}
        {created?.error && <Notice>{created.error}</Notice>}
        {!created && <Button busy={busy} onClick={() => void perform(refreshConnector)}>{t("retry")}</Button>}
        {created && created.state !== "ready" && <Button busy={busy} onClick={() => void perform(async () => { await api(`ingress/${created.id}/start`, "POST"); await refreshConnector(); })}>{t("retry")}</Button>}
      </div>}
    </div>
  </SetupDialog>;
}
