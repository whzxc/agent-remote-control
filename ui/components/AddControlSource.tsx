import { useEffect, useState } from "react";
import { Check, ExternalLink, Plus } from "lucide-react";
import { api } from "../api";
import { controlSource, curatedSources, nextSourceName } from "../controlSources";
import { locale, t } from "../i18n";
import { openUrl } from "../platform";
import { connector, refreshConnector } from "../state/connector";
import { onboarding, openConnectionSetup, finishSourceSetup, addedSource, type OnboardingStep, type ConnectionMethod } from "../state/onboarding";
import { connectionDisabledReason, connectionKind, isPendingSource } from "../sourcePresentation";
import SetupDialog from "./SetupDialog";
import SourceIcon from "./SourceIcon";
import { ApprovalCard } from "./OAuthApproval";
import { Button, CopyField, Field, Icon, Loading, Notice, SingleChoice } from "./ui";

const steps: OnboardingStep[] = ["product", "connection", "address", "approval", "success"];
const products = [...curatedSources.map(source => source.id), "grok-bot", "local-code", "local-desktop", "custom"];
export default function AddControlSource({ returnFocus }: { returnFocus?: string }) {
  const flow = onboarding.use()!, { status, sources } = connector.use();
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [route, setRoute] = useState("");
  const [credentials, setCredentials] = useState<{ ingressId: string; bearerToken: string }>();
  const product = flow.source ?? "custom", info = controlSource(product), name = info?.shortName ?? t("connect.other");
  const settingsUrl = info?.setup?.url;
  const entries = status?.ingresses ?? [], current = entries.find(i => i.id === flow.ingressId);
  const visible = entries.filter(i => (!flow.localTarget || i.id === `local-claude-${flow.localTarget}`)
    && (i.transport !== "openai-tunnel" || product === "chatgpt"));
  const existing = visible.filter(i => !connectionDisabledReason(i, product, sources, flow.localTarget));
  const existingIds = existing.map(i => i.id).join(",");
  useEffect(() => {
    setRoute(old => existing.some(i => i.id === flow.ingressId) ? flow.ingressId! : existing.some(i => i.id === old) ? old : existing[0]?.id ?? "");
  }, [flow.source, flow.localTarget, flow.ingressId, existingIds]);
  useEffect(() => {
    setCredentials(undefined);
    if (flow.step !== "address" || current?.auth !== "bearer") return;
    let alive = true;
    void api<{ bearerToken: string }>(`ingress/${current.id}/credentials`, "POST").then(value => {
      if (alive) setCredentials({ ingressId: current.id, bearerToken: value.bearerToken });
    }).catch(e => { if (alive) setError(String(e)); });
    return () => { alive = false; };
  }, [flow.step, current?.id, current?.auth]);
  function step(next: OnboardingStep) { setError(""); onboarding.set(old => old && { ...old, step: next, ...(["product", "connection"].includes(next) ? { requestId: undefined, ingressId: old.fixedConnection ? old.ingressId : undefined, sourceId: undefined } : {}) }); }
  async function perform(action: () => Promise<void>) {
    setBusy(true); setError("");
    try { await action(); } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }
  async function selectConnection(id: string) {
    await perform(async () => {
      const entry = connector.get().status?.ingresses.find(i => i.id === id);
      if (!entry) return;
      if (entry.auth !== "oauth") {
        const source = sources.find(s => s.ingressId === id && s.state !== "revoked");
        if (source && source.product !== product) {
          await api(`source/${source.id}`, "PUT", { product,
            ...(source.label === controlSource(source.product)?.displayName ? { label: nextSourceName(product, sources.filter(s => s.id !== source.id).map(s => s.label)) } : {}) });
          await refreshConnector();
        }
      }
      onboarding.set(old => old && { ...old, step: "address", ingressId: id, requestId: undefined, sourceId: undefined, baseline: (entry.oauth?.pending ?? []).map(p => p.id) });
    });
  }
  const pending = current?.oauth?.pending.filter(p => p.status === "pending" && !p.switchSourceId) ?? [];
  const waiting = current?.oauth?.pending.find(p => p.id === flow.requestId);
  useEffect(() => {
    if (flow.step !== "address" || current?.auth !== "oauth") return;
    const next = pending.find(p => !flow.baseline?.includes(p.id));
    if (next) onboarding.set(old => old?.step === "address" ? { ...old, step: "approval", requestId: next.id } : old);
  }, [flow.step, flow.ingressId, current?.oauth]);
  const connected = sources.find(s => s.ingressId === current?.id && s.product === product && s.state === "connected" && s.connectedAt !== null && (current?.auth !== "oauth" || s.credential.grantId === flow.requestId));
  useEffect(() => {
    if ((flow.step === "approval" || flow.step === "address" && current?.auth !== "oauth") && connected) onboarding.set(old => old && ["approval", "address"].includes(old.step) ? { ...old, step: "success", sourceId: connected.id } : old);
  }, [flow.step, connected?.id]);
  function retry() {
    onboarding.set(old => old && { ...old, step: "address", requestId: undefined, baseline: (current?.oauth?.pending ?? []).map(p => p.id) });
  }
  const added = sources.find(s => s.id === flow.sourceId);
  const selectedProduct = flow.localTarget ? `local-${flow.localTarget}` : flow.source ?? "";
  function chooseProduct(value: string) {
    onboarding.set(old => old && { ...old, source: value.startsWith("local-") ? "claude" : value,
      localTarget: value.startsWith("local-") ? value.slice(6) as "code" | "desktop" : undefined,
      ingressId: old.fixedConnection ? old.ingressId : undefined, requestId: undefined, sourceId: undefined });
  }
  function newConnection(method?: ConnectionMethod) { openConnectionSetup({ forSource: true, product, localTarget: flow.localTarget, method }); }
  const productName = (id: string) => id === "custom" ? t("setup.otherClient") : id === "local-code" ? "Claude Code" : id === "local-desktop" ? t("setup.claudeDesktop") : id === "microsoft-copilot" ? "Copilot" : controlSource(id)!.displayName;
  const title = selectedProduct ? t("setup.addProduct", { name: productName(selectedProduct) }) : t("addControlSource");
  const footer = <>
    {flow.step === "approval" && waiting?.status === "pending" && <><Button type="submit" form={`approval-${waiting.id}`} value="deny" disabled={busy}>{t("oauthDeny")}</Button><Button variant="primary" type="submit" form={`approval-${waiting.id}`} value="allow" busy={busy}>{t("oauthAllow")}</Button></>}
    {flow.step !== "product" && flow.step !== "success" && flow.step !== "approval" && <Button variant="ghost" disabled={busy} onClick={() => step(flow.step === "address" && flow.fixedConnection ? "product" : steps[Math.max(0, steps.indexOf(flow.step) - 1)])}>{t("back")}</Button>}
    {flow.step === "product" && <><span className="spacer" /><Button variant="primary" busy={busy} disabled={!flow.source || !!(flow.fixedConnection && current && connectionDisabledReason(current, product, sources, flow.localTarget))} onClick={() => flow.fixedConnection && flow.ingressId ? void selectConnection(flow.ingressId) : step("connection")}>{t("source.next")}</Button></>}
    {flow.step === "connection" && <Button variant="primary" busy={busy} disabled={!existing.some(i => i.id === route)} onClick={() => void selectConnection(route)}>{t("source.next")}</Button>}
    {flow.step === "address" && <Loading label={t(current?.auth === "oauth" ? "connect.waitClient" : "source.waitConnection", { name })} />}
    {flow.step === "success" && <><Button variant="ghost" onClick={() => { if (flow.sourceId) addedSource.set(flow.sourceId); onboarding.set({ step: "product" }); }}>{t("setup.addAnother")}</Button><Button variant="primary" onClick={finishSourceSetup}>{t("source.done")}</Button></>}
  </>;
  return <SetupDialog title={title} steps={steps.slice(0, 4).map((value, index) => ({ label: t(`source.step.${value}`), value: index === 0 ? productName(selectedProduct || "custom") : index === 1 ? current?.name : undefined }))}
    active={steps.indexOf(flow.step)} done={flow.step === "success"} busy={busy} onClose={finishSourceSetup}
    initialFocus={flow.step === "product" && flow.focusGroup ? `platform-${flow.focusGroup}` : undefined}
    returnFocus={returnFocus}
    footer={footer}>
    <div className="setup-content">
    {error && <Notice>{error}</Notice>}
    {flow.step === "product" && <>
      {(["remote", "local"] as const).map(group => <section className="platform-group" key={group}>
        <h3 id={`platform-${group}`} tabIndex={-1}>{t(`setup.group.${group}`)}</h3>
        <SingleChoice tiles label={t(`setup.group.${group}`)} value={selectedProduct} onChange={chooseProduct}
          options={products.filter(id => (id.startsWith("local-") || id === "custom") === (group === "local")).map(id => {
            const localTarget = id.startsWith("local-") ? id.slice(6) as "code" | "desktop" : undefined;
            const reason = flow.fixedConnection && current ? connectionDisabledReason(current, localTarget ? "claude" : id, sources, localTarget) : "";
            return { value: id, label: productName(id), disabled: !!reason, description: reason, graphic: <SourceIcon platform={id === "local-code" ? "claude-code" : id === "local-desktop" ? "claude" : id} /> };
          })} />
      </section>)}
      {flow.fixedConnection && current && <p className="muted">{t("setup.via", { name: current.name })}</p>}
    </>}
    {flow.step === "connection" && <>
      <p className="muted">{t("setup.connectionPrompt", { name: productName(selectedProduct || "custom") })}</p>
      {visible.length > 0 && <SingleChoice cards label={t("source.connections")} value={route} onChange={setRoute} disabled={busy} options={visible.map(i => {
        const carried = sources.filter(s => s.ingressId === i.id && !isPendingSource(s, entries) && s.state !== "revoked");
        const reason = connectionDisabledReason(i, product, sources, flow.localTarget);
        return { value: i.id, label: i.name, disabled: !!reason,
          description: reason || [t(`source.kind.${connectionKind(i)}`), carried.length && t("setup.carriesSources", { names: carried.map(s => s.label).join(", ") }), t(i.state === "ready" ? "connect.online" : "connect.offline")].filter(Boolean).join(" · ") };
      })} />}
      {!existing.length && <div className="setup-empty">
        <h3>{t("setup.noConnection")}</h3>
        {flow.localTarget ? <Button onClick={() => newConnection(flow.localTarget === "code" ? "local-code" : "local-desktop")}>{t("connection.localSetup", { name: productName(selectedProduct) })}</Button> : <>
          <Button className="setup-recommended" onClick={() => newConnection("create")}>{t("source.createRelay")}<span className="setup-badge">{t("setup.recommended")}</span></Button>
          <Button onClick={() => newConnection("join")}>{t("source.pasteRelay")}</Button>
          <Button onClick={() => newConnection("https")}>{t("setup.ownAddress")}</Button>
        </>}
      </div>}
      {existing.length > 0 && <Button className="setup-new" data-add-connection disabled={busy} onClick={() => newConnection()}><Icon icon={Plus} /><span>{t("source.newConnection")}<small>{t("setup.newConnectionHint")}</small></span></Button>}
    </>}
    {flow.step === "address" && (current ? <>
      {current.transport === "local" ? <p>{t("connect.restartClaude")}</p> : <ol className="setup-instructions">
        <li><div><strong>{t("source.copyAddress")}</strong><CopyField value={current.url || current.config.tunnelId} label={t("source.copyAddress")} />
          {credentials?.ingressId === current.id && <Field label={t("source.bearerHeader")}><CopyField password value={`Bearer ${credentials.bearerToken}`} label={t("source.bearerHeader")} /></Field>}</div></li>
        <li><div><strong>{t("setup.configureProduct", { name })}</strong><p>{info?.setup?.path[locale.get()] ?? t("connect.customPath")}</p>
          {settingsUrl && <Button onClick={() => void perform(() => openUrl(settingsUrl))}>{t("connect.openSettings", { name })}<Icon icon={ExternalLink} /></Button>}</div></li>
        <li><div><strong>{t("setup.clickConnect", { name })}</strong><p>{t(current.auth === "oauth" ? "setup.browserCode" : "source.noOAuthApproval")}</p></div></li>
      </ol>}
      {current.error && <Notice>{current.error}</Notice>}
      {current.state !== "ready" && <Button busy={busy} onClick={() => void perform(async () => { await api(`ingress/${current.id}/start`, "POST"); await refreshConnector(); })}>{t("retry")}</Button>}
      {pending.length > 0 && <Button onClick={() => onboarding.set(old => old && { ...old, step: "approval", requestId: pending[0].id })}>{t("source.review")}</Button>}
    </> : <Notice>{t("source.connectionRemoved")}</Notice>)}
    {flow.step === "approval" && <>
      {pending.length > 1 && <SingleChoice label={t("source.pendingRequests")} value={flow.requestId ?? ""} onChange={requestId => onboarding.set(old => old && { ...old, requestId })} options={pending.map(p => ({ value: p.id, label: `${p.clientName} · ${p.pairingCode ?? p.redirectUri}` }))} />}
      {waiting && current ? <ApprovalCard key={waiting.id} request={waiting} ingress={current} product={product} inline onBusy={setBusy} onDecided={allow => { if (!allow) retry(); }} /> : <Notice tone="warning">{t("connect.requestExpired")}</Notice>}
      {(!waiting || ["denied", "expired"].includes(waiting.status)) && <Button onClick={retry}>{t("retry")}</Button>}
    </>}
    {flow.step === "success" && <div className="setup-success"><span className="setup-success-mark"><Icon icon={Check} size={20} /></span>
      <h3>{t("source.added", { name: added?.label ?? name })}</h3><p>{t("setup.via", { name: current?.name ?? t("source.connectionRemoved") })}</p>
      <Field label={t("setup.tryPrompt", { name })}><CopyField value={t("setup.firstPrompt")} label={t("copy")} /></Field>
    </div>}
    </div>
  </SetupDialog>;
}
