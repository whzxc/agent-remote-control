import { useCopyState } from "./ui/useCopyState";
import { Tooltip as HoverHelp } from "./ui/index";
import Panel from "./ui/Panel";
import { useDockOpening } from "./useDockOpening";
import { useSubmittedDirty } from "./ui/useSubmittedDirty";
import { DialogActions, useDialogCompletion, useDialogFeedback } from "./ui/Dialog";
import { Sensitive } from "./Sensitive";
import { useCallback, useEffect, useState } from "react";
import { Cloud, RefreshCw } from "lucide-react";
import { api } from "../api";
import { locale, t } from "../i18n";
import { connector, notify, refreshConnector } from "../state/connector";
import { appNow, useAppNow } from "../state/appEnvironment";
import { useRelays, useRelayProgress, type Relay, type RelayProgress as Progress } from "../state/relay";
import RelayProgress from "./RelayProgress";
import { ConfirmDialog, Button, DataTable, Dialog, Icon, IconButton, Loading, Notice, Status } from "./ui";

type Member = { id: string; name: string; isSelf: boolean; joinedAt: string; lastOnline: string | null; online: boolean };
type Job = { action: "create" | "redeploy" | "delete"; id?: string };
type Confirmation = "reset-token" | "delete" | Member;

function hostname(relay: Relay) {
  try { return new URL(relay.url).hostname; }
  catch { return t("hosting.notDeployed"); }
}
function compactDate(value: string | null, recent = false) {
  if (!value) return t("connect.neverOnline");
  const date = new Date(value), age = appNow() - date.getTime();
  if (!Number.isFinite(date.getTime())) return t("connect.neverOnline");
  if (recent && age >= 0 && age < 120_000) return t("hosting.justNow");
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function HostedRelay({ relay, version, startJob, disabled }: {
  relay: Relay; version: string; startJob: (job: Job) => Promise<boolean>; disabled: boolean;
}) {
  const { status } = connector.use();
  const invitation = useCopyState();
  const notify = useDialogFeedback();
  const [members, setMembers] = useState<Member[]>([]), [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(""), [error, setError] = useState(""), [membersError, setMembersError] = useState("");
  const [confirm, setConfirm] = useState<Confirmation>();
  const confirmation = useDialogCompletion(() => setConfirm(undefined));
  useAppNow(30_000);
  const ingress = status?.ingresses.find(value => value.id === relay.ingressId);
  const readMembers = useCallback(async () => {
    setLoading(true); setMembersError("");
    try { setMembers(relay.url ? await api<Member[]>("relay/instances", "POST", { id: relay.id }) : []); }
    catch { setMembersError(t("connect.membersFailed")); }
    finally { setLoading(false); }
  }, [relay.id, relay.url]);
  useEffect(() => { void readMembers(); }, [readMembers]);
  async function action(name: "share" | "reset-token" | "remove" | "delete", member?: Member) {
    setBusy(name); setError("");
    try {
      if (name === "delete") {
        if (!await startJob({ action: "delete", id: relay.id })) { setError(t("connect.actionFailed")); return; }
      } else {
        const result = await api<{ link?: string }>(`relay/${name}`, "POST", { id: relay.id, ...(member ? { instanceId: member.id } : {}) });
        if (name === "share" && result.link) { if (!await invitation.copy(result.link)) setError(t("copyFailedSelectAndCopyTheTextManually")); }
        if (name === "reset-token") notify(t("hosting.inviteReset"));
        if (name === "remove") await readMembers();
      }
      if (confirm) await confirmation.finish();
    } catch { setError(t("connect.actionFailed")); }
    finally { setBusy(""); }
  }
  const blocked = disabled || !!busy;
  const name = (member: Member) => member.isSelf ? status?.deviceName || t("connect.thisComputer") : member.name;
  const outdated = !!version && relay.workerVersion !== version;
  return <article className="hosted-relay" aria-label={t("hosting.title")}>
    <div className="hosted-relay-card">
      <div className="hosted-relay-summary">
        <div className="hosted-relay-icon"><Icon icon={Cloud} /></div>
        <div className="hosted-relay-identity">
          <h3><Sensitive>{hostname(relay)}</Sensitive></h3>
          <div className="hosted-relay-provider"><span>Cloudflare Workers</span><span aria-hidden="true"> · </span>
            {outdated || !relay.url ? <Button variant="ghost" disabled={blocked} onClick={() => void startJob({ action: "redeploy", id: relay.id })}>{t(outdated && relay.url ? "hosting.update" : "retry")}</Button> : <span>{t("hosting.upToDate")}</span>}
          </div>
        </div>
        <span className={`hosted-relay-state ${ingress?.state === "ready" ? "running" : ""}`}><Status tone={ingress?.state === "ready" ? "success" : "neutral"}>{t(ingress?.state === "ready" ? "hosting.running" : "connect.offline")}</Status></span>
      </div>
      <div className="hosted-relay-invite">
        <p>{t("hosting.invite")}<span className="muted"> · {t("hosting.inviteDescription")}</span></p>
        <div className="actions">
          <Button variant="primary" busy={busy === "share"} disabled={blocked || !relay.url} onClick={() => void action("share")}>{t(invitation.copied ? "copied" : "hosting.copyInvite")}</Button>
          <Button disabled={blocked || !relay.url} onClick={() => { setError(""); setConfirm("reset-token"); }}>{t("hosting.reset")}</Button>
        </div>
      </div>
    </div>
    <section className="hosted-relay-devices">
      <div className="hosting-section-heading">
        <div><h3>{t("hosting.devices")}</h3><p className="muted small">{t("hosting.devicesDescription")}</p></div>
        <IconButton icon={RefreshCw} label={t("hosting.refreshDevices")} busy={loading} disabled={blocked || !relay.url} onClick={() => void readMembers()} />
      </div>
      {membersError && <Notice tone="danger">{membersError}</Notice>}
      <div className="hosted-relay-table" aria-busy={loading}>
        <DataTable rows={members} empty={loading ? <Loading /> : membersError ? t("connect.membersFailed") : t("hosting.noDevices")} columns={[
          { key: "device", title: t("hosting.device"), width: 180, render: member => <div className="hosted-relay-device"><Status tone={member.online ? "success" : "neutral"}><span className="sr-only">{t(member.online ? "connect.online" : "connect.offline")}</span></Status><HoverHelp text={name(member)}><span className="hosted-relay-device-name">{name(member)}</span></HoverHelp>{member.isSelf && <span className="hosted-relay-self">{t("hosting.self")}</span>}</div> },
          { key: "joined", title: t("hosting.joined"), width: 100, render: member => <time dateTime={member.joinedAt}>{compactDate(member.joinedAt)}</time> },
          { key: "seen", title: t("hosting.lastSeen"), width: 100, render: member => member.lastOnline ? <time dateTime={member.lastOnline}>{compactDate(member.lastOnline, true)}</time> : t("connect.neverOnline") },
          { key: "actions", title: <span className="sr-only">{t("hosting.actions")}</span>, width: 80, align: "right", render: member => !member.isSelf && <Button variant="ghost" disabled={blocked} onClick={() => { setError(""); setConfirm(member); }}>{t("hosting.remove")}</Button> },
        ]} />
      </div>
    </section>
    <div className="hosted-relay-danger">
      <div><h3>{t("hosting.deleteTitle")}</h3><p className="muted small">{t("hosting.deleteDescription")}</p></div>
      <Button variant="danger" disabled={blocked} onClick={() => { setError(""); setConfirm("delete"); }}>{t("hosting.delete")}</Button>
    </div>
    {error && !confirm && <Notice tone="danger">{error}</Notice>}
    {confirm && <ConfirmDialog layerId={confirmation.layerId} title={t(confirm === "reset-token" ? "hosting.resetTitle" : confirm === "delete" ? "hosting.deleteTitle" : "connect.confirm.remove")} onClose={() => setConfirm(undefined)} busy={!!busy} confirmLabel={t(confirm === "reset-token" ? "hosting.reset" : confirm === "delete" ? "delete" : "hosting.remove")}
      confirmVariant={confirm === "reset-token" ? "primary" : "danger"}
      onConfirm={() => action(typeof confirm === "string" ? confirm : "remove", typeof confirm === "object" ? confirm : undefined)}>
      <p>{t(confirm === "reset-token" ? "hosting.resetDescription" : confirm === "delete" ? "hosting.deleteDescription" : "hosting.removeDescription", { name: typeof confirm === "object" ? name(confirm) : "" })}</p>
      {error && <Notice tone="danger">{error}</Notice>}
    </ConfirmDialog>}
  </article>;
}

export default function RelayHosting({ expanded, onToggleWidth, onClose }: { expanded: boolean; onToggleWidth: () => void; onClose: () => void }) {
  locale.use();
  const relays = useRelays();
  const ready = useDockOpening("relay-hosting", !relays.loaded, undefined, onClose);
  return ready ? <Panel role="region" title={t("hosting.feature")} expanded={expanded} onToggleWidth={onToggleWidth}
    onClose={onClose} returnFocus='[data-page="relay-hosting"]'><RelayHostingContent relays={relays} /></Panel> : null;
}
function RelayHostingContent({ relays }: { relays: ReturnType<typeof useRelays> }) {
  const { status } = connector.use();
  const [job, setJob] = useState<Job>(), [dialogOpen, setDialogOpen] = useState(false), [busy, setBusy] = useState(false);
  const [account, setAccount] = useState(""), [error, setError] = useState("");
  const draft = useSubmittedDirty(account, !!account);
  const [revision, setRevision] = useState(0);
  const deployment = useDialogCompletion(() => { setJob(undefined); setDialogOpen(false); setAccount(""); });
  const { progress, setProgress, error: progressError } = useRelayProgress(!!job, () => {
    void deployment.finish(`${t("hosting.title")} · ${t("activity.completed")}`);
    if (!deployment.isOpen()) setJob(undefined);
    setRevision(value => value + 1);
    void relays.refresh().catch(() => {}); void refreshConnector().catch(() => {});
  });
  useEffect(() => {
    let alive = true;
    void api<Progress>("relay/progress").then(value => {
      if (alive && ["create", "redeploy", "delete"].includes(value.action ?? "") && ["login", "deploying", "connecting", "failed"].includes(value.phase) && !value.cancelled) {
        setProgress(value); setJob({ action: value.action as Job["action"], id: value.relayId });
      }
    }).catch(() => {});
    return () => { alive = false; };
  }, [setProgress]);
  async function startJob(next: Job) {
    draft.submit(); setDialogOpen(true); setBusy(true); setError("");
    try {
      const value = await api<Progress>(`relay/${next.action}`, "POST", { ...(next.id ? { id: next.id } : {}), ...(next.action === "create" ? { name: status?.deviceName || t("connect.thisComputer") } : {}), ...(next.action !== "delete" && account ? { accountId: account } : {}) });
      setProgress(value); setJob(next); return true;
    } catch { setError(t("connect.actionFailed")); return false; }
    finally { setBusy(false); }
  }
  async function cancel() {
    setBusy(true); setError("");
    try { await api("relay/cancel", "POST"); setJob(undefined); setDialogOpen(false); setAccount(""); await relays.refresh(); await refreshConnector(); return true; }
    catch { setError(t("connect.actionFailed")); return false; }
    finally { setBusy(false); }
  }
  useEffect(() => {
    if (!dialogOpen && job && progress.phase === "failed") {
      notify(progress.reason || t("connect.actionFailed"), true); setJob(undefined);
    }
  }, [dialogOpen, job, progress.phase, progress.reason]);
  const owners = relays.relays.filter(relay => relay.owner);
  return <div className="relay-hosting">
    <div className="hosting-empty-group"><div className="hosting-empty-copy"><h2>{t("hosting.title")}</h2>
      {!relays.loaded ? <Loading /> : !owners.length && !relays.error && <p className="muted">{t("hosting.empty")}</p>}</div>
      <Button disabled={busy || !!job} onClick={() => { setError(""); setAccount(""); draft.submit(""); setDialogOpen(true); }}>{t("hosting.deploy")}</Button>
    </div>
    {relays.error && <Notice tone="danger" action={<Button onClick={() => void relays.refresh().catch(() => {})}>{t("retry")}</Button>}>{t("connect.readFailed")}</Notice>}
    {error && !dialogOpen && !job && <Notice tone="danger">{error}</Notice>}
    {owners.map(relay => <HostedRelay key={`${relay.id}:${revision}`} relay={relay} version={relays.version} startJob={startJob} disabled={busy || !!job} />)}
    {dialogOpen && <Dialog layerId={deployment.layerId} title={t(job?.action === "delete" ? "hosting.deleteTitle" : job?.action === "redeploy" ? "connect.updateRelay" : "hosting.deploy")} busy={busy || !!job && ["login", "deploying", "connecting"].includes(progress.phase)} dirty={draft.dirty}
      onCancel={job ? cancel : undefined} onClose={() => { setDialogOpen(false); setJob(undefined); setError(""); }}>
      {error && <Notice tone="danger">{error}</Notice>}
      {progressError && job && <Notice tone="danger">{t("connect.readFailed")}</Notice>}
      {job ? <RelayProgress progress={progress} busy={busy} account={account} setAccount={setAccount} onRetry={() => void startJob({ action: job.action === "create" && progress.relayId ? "redeploy" : job.action, id: progress.relayId ?? job.id })} /> : <form onSubmit={event => { event.preventDefault(); void startJob({ action: "create" }); }}>
        <p className="muted">{t("connect.freeAccount")}</p>
        <DialogActions><Button type="submit" variant="primary" busy={busy}>{t("hosting.deploy")}</Button></DialogActions>
      </form>}
    </Dialog>}
  </div>;
}
