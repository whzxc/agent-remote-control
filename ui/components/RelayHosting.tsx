import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { locale, t } from "../i18n";
import { appNow, useAppNow } from "../state/appEnvironment";
import { connector, notify, refreshConnector } from "../state/connector";
import {
  useRelayProgress,
  useRelays,
  type Relay,
  type RelayProgress as Progress,
} from "../state/relay";
import { RelayCardView } from "./hosting/RelayCardView";
import type { RelayMemberRow } from "./hosting/RelayDevicesTableView";
import { RelayHostingView } from "./hosting/RelayHostingView";
import RelayProgress from "./RelayProgress";
import { Button, ConfirmDialog, Dialog, Notice } from "./ui";
import {
  DialogActions,
  useDialogCompletion,
  useDialogFeedback,
} from "./ui/Dialog";
import { EntityInventory } from "./ui/EntityInventory";
import Panel from "./ui/Panel";
import { useCopyState } from "./ui/useCopyState";
import { useSubmittedDirty } from "./ui/useSubmittedDirty";
import { useDockOpening } from "./useDockOpening";

type Member = {
  id: string;
  name: string;
  isSelf: boolean;
  joinedAt: string;
  lastOnline: string | null;
  online: boolean;
};
type Job = { action: "create" | "redeploy" | "delete"; id?: string };
type Confirmation = "reset-token" | "delete" | Member;

function hostname(relay: Relay) {
  try {
    return new URL(relay.url).hostname;
  } catch {
    return t("hosting.notDeployed");
  }
}

function compactDate(value: string | null, recent = false) {
  if (!value) return t("connect.neverOnline");
  const date = new Date(value);
  const age = appNow() - date.getTime();
  if (!Number.isFinite(date.getTime())) return t("connect.neverOnline");
  if (recent && age >= 0 && age < 120_000) return t("hosting.justNow");
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function HostedRelay({
  relay,
  version,
  startJob,
  disabled,
}: {
  relay: Relay;
  version: string;
  startJob: (job: Job) => Promise<boolean>;
  disabled: boolean;
}) {
  const { status } = connector.use();
  const invitation = useCopyState();
  const dialogFeedback = useDialogFeedback();
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [membersError, setMembersError] = useState("");
  const [confirm, setConfirm] = useState<Confirmation>();
  const confirmation = useDialogCompletion(() => setConfirm(undefined));
  useAppNow(30_000);

  const ingress = status?.ingresses.find(
    (value) => value.id === relay.ingressId,
  );
  const readMembers = useCallback(async () => {
    setLoading(true);
    setMembersError("");
    try {
      setMembers(
        relay.url
          ? await api<Member[]>("relay/instances", "POST", { id: relay.id })
          : [],
      );
    } catch {
      setMembersError(t("connect.membersFailed"));
    } finally {
      setLoading(false);
    }
  }, [relay.id, relay.url]);

  useEffect(() => {
    void readMembers();
  }, [readMembers]);

  async function action(
    name: "share" | "reset-token" | "remove" | "delete",
    member?: Member,
  ) {
    setBusy(name);
    setError("");
    try {
      if (name === "delete") {
        if (!(await startJob({ action: "delete", id: relay.id }))) {
          setError(t("connect.actionFailed"));
          return;
        }
      } else {
        const result = await api<{ link?: string }>(`relay/${name}`, "POST", {
          id: relay.id,
          ...(member ? { instanceId: member.id } : {}),
        });
        if (name === "share" && result.link) {
          if (!(await invitation.copy(result.link))) {
            setError(t("copyFailedSelectAndCopyTheTextManually"));
          }
        }
        if (name === "reset-token") dialogFeedback(t("hosting.inviteReset"));
        if (name === "remove") await readMembers();
      }
      if (confirm) await confirmation.finish();
    } catch {
      setError(t("connect.actionFailed"));
    } finally {
      setBusy("");
    }
  }

  const blocked = disabled || Boolean(busy);
  const memberName = (member: Member) =>
    member.isSelf ? status?.deviceName || t("connect.thisComputer") : member.name;
  const outdated = Boolean(version && relay.workerVersion !== version);

  const memberRows: RelayMemberRow[] = members.map((member) => ({
    id: member.id,
    name: memberName(member),
    isSelf: member.isSelf,
    online: member.online,
    joinedAt: member.joinedAt,
    joinedLabel: compactDate(member.joinedAt),
    lastOnline: member.lastOnline,
    lastSeenLabel: compactDate(member.lastOnline, true),
  }));

  return (
    <>
      <RelayCardView
        hostname={hostname(relay)}
        hasUrl={Boolean(relay.url)}
        running={ingress?.state === "ready"}
        outdated={outdated}
        copied={invitation.copied}
        shareBusy={busy === "share"}
        disabled={blocked}
        members={memberRows}
        membersLoading={loading}
        membersError={membersError || undefined}
        error={error && !confirm ? error : undefined}
        onRedeploy={() => void startJob({ action: "redeploy", id: relay.id })}
        onShare={() => void action("share")}
        onResetToken={() => {
          setError("");
          setConfirm("reset-token");
        }}
        onRefreshMembers={() => void readMembers()}
        onRemoveMember={(row) => {
          const target = members.find((item) => item.id === row.id);
          if (!target) return;
          setError("");
          setConfirm(target);
        }}
        onDelete={() => {
          setError("");
          setConfirm("delete");
        }}
      />
      {confirm && (
        <ConfirmDialog
          layerId={confirmation.layerId}
          title={t(
            confirm === "reset-token"
              ? "hosting.resetTitle"
              : confirm === "delete"
                ? "hosting.deleteTitle"
                : "connect.confirm.remove",
          )}
          onClose={() => setConfirm(undefined)}
          busy={Boolean(busy)}
          confirmLabel={t(
            confirm === "reset-token"
              ? "hosting.reset"
              : confirm === "delete"
                ? "delete"
                : "hosting.remove",
          )}
          confirmVariant={confirm === "reset-token" ? "primary" : "danger"}
          onConfirm={() =>
            action(
              typeof confirm === "string" ? confirm : "remove",
              typeof confirm === "object" ? confirm : undefined,
            )
          }
        >
          <p>
            {t(
              confirm === "reset-token"
                ? "hosting.resetDescription"
                : confirm === "delete"
                  ? "hosting.deleteDescription"
                  : "hosting.removeDescription",
              { name: typeof confirm === "object" ? memberName(confirm) : "" },
            )}
          </p>
          {error && <Notice tone="danger">{error}</Notice>}
        </ConfirmDialog>
      )}
    </>
  );
}

export default function RelayHosting({
  expanded,
  onToggleWidth,
  onClose,
}: {
  expanded: boolean;
  onToggleWidth: () => void;
  onClose: () => void;
}) {
  locale.use();
  const relays = useRelays();
  const ready = useDockOpening("relay-hosting", !relays.loaded, undefined, onClose);
  return ready ? (
    <Panel
      role="region"
      title={t("hosting.feature")}
      expanded={expanded}
      onToggleWidth={onToggleWidth}
      onClose={onClose}
      returnFocus='[data-page="relay-hosting"]'
    >
      <RelayHostingContent relays={relays} />
    </Panel>
  ) : null;
}

function RelayHostingContent({
  relays,
}: {
  relays: ReturnType<typeof useRelays>;
}) {
  const { status } = connector.use();
  const [job, setJob] = useState<Job>();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [account, setAccount] = useState("");
  const [error, setError] = useState("");
  const draft = useSubmittedDirty(account, Boolean(account));
  const [revision, setRevision] = useState(0);
  const deployment = useDialogCompletion(() => {
    setJob(undefined);
    setDialogOpen(false);
    setAccount("");
  });
  const { progress, setProgress, error: progressError } = useRelayProgress(
    Boolean(job),
    () => {
      void deployment.finish(`${t("hosting.title")} · ${t("activity.completed")}`);
      if (!deployment.isOpen()) setJob(undefined);
      setRevision((value) => value + 1);
      void relays.refresh().catch(() => {});
      void refreshConnector().catch(() => {});
    },
  );

  useEffect(() => {
    let alive = true;
    void api<Progress>("relay/progress")
      .then((value) => {
        if (
          alive &&
          ["create", "redeploy", "delete"].includes(value.action ?? "") &&
          ["login", "deploying", "connecting", "failed"].includes(value.phase) &&
          !value.cancelled
        ) {
          setProgress(value);
          setJob({ action: value.action as Job["action"], id: value.relayId });
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [setProgress]);

  async function startJob(next: Job) {
    draft.submit();
    setDialogOpen(true);
    setBusy(true);
    setError("");
    try {
      const value = await api<Progress>(`relay/${next.action}`, "POST", {
        ...(next.id ? { id: next.id } : {}),
        ...(next.action === "create"
          ? { name: status?.deviceName || t("connect.thisComputer") }
          : {}),
        ...(next.action !== "delete" && account ? { accountId: account } : {}),
      });
      setProgress(value);
      setJob(next);
      return true;
    } catch {
      setError(t("connect.actionFailed"));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    setBusy(true);
    setError("");
    try {
      await api("relay/cancel", "POST");
      setJob(undefined);
      setDialogOpen(false);
      setAccount("");
      await relays.refresh();
      await refreshConnector();
      return true;
    } catch {
      setError(t("connect.actionFailed"));
      return false;
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!dialogOpen && job && progress.phase === "failed") {
      notify(progress.reason || t("connect.actionFailed"), {
        errorSource: "relay-deploy",
      });
      setJob(undefined);
    }
  }, [dialogOpen, job, progress.phase, progress.reason]);

  const owners = relays.relays.filter((relay) => relay.owner);

  return (
    <EntityInventory className="contents">
      <RelayHostingView
        loaded={relays.loaded}
        hasOwners={owners.length > 0}
        deployDisabled={busy || Boolean(job)}
        readError={Boolean(relays.error)}
        actionError={error && !dialogOpen && !job ? error : undefined}
        onDeploy={() => {
          setError("");
          setAccount("");
          draft.submit("");
          setDialogOpen(true);
        }}
        onRetryRead={() => void relays.refresh().catch(() => {})}
      >
        {owners.map((relay) => (
          <HostedRelay
            key={`${relay.id}:${revision}`}
            relay={relay}
            version={relays.version}
            startJob={startJob}
            disabled={busy || Boolean(job)}
          />
        ))}
      </RelayHostingView>

      {dialogOpen && (
        <Dialog
          layerId={deployment.layerId}
          title={t(
            job?.action === "delete"
              ? "hosting.deleteTitle"
              : job?.action === "redeploy"
                ? "connect.updateRelay"
                : "hosting.deploy",
          )}
          busy={
            busy ||
            (Boolean(job) &&
              ["login", "deploying", "connecting"].includes(progress.phase))
          }
          dirty={draft.dirty}
          onCancel={job ? cancel : undefined}
          onClose={() => {
            setDialogOpen(false);
            setJob(undefined);
            setError("");
          }}
        >
          {error && <Notice tone="danger">{error}</Notice>}
          {progressError && job && (
            <Notice tone="danger">{t("connect.readFailed")}</Notice>
          )}
          {job ? (
            <RelayProgress
              progress={progress}
              busy={busy}
              account={account}
              setAccount={setAccount}
              onRetry={() =>
                void startJob({
                  action:
                    job.action === "create" && progress.relayId
                      ? "redeploy"
                      : job.action,
                  id: progress.relayId ?? job.id,
                })
              }
            />
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void startJob({ action: "create" });
              }}
            >
              <p className="text-small leading-5 text-text-secondary">
                {t("connect.freeAccount")}
              </p>
              <DialogActions>
                <Button type="submit" variant="primary" busy={busy}>
                  {t("hosting.deploy")}
                </Button>
              </DialogActions>
            </form>
          )}
        </Dialog>
      )}
    </EntityInventory>
  );
}
