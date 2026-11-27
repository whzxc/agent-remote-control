import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { Button, ConfirmDialog, Dialog, Notice, SearchInput } from "../components/ui";
import { useDialogCompletion } from "../components/ui/Dialog";
import Panel from "../components/ui/Panel";
import { useCopyState } from "../components/ui/useCopyState";
import { locale, t } from "../i18n";
import { relativeTime } from "../lib/relativeTime";
import { useAppNow } from "../state/appEnvironment";
import {
  McpHubActionsView,
  McpHubStatsView,
  McpHubView,
} from "./McpHubView";
import { McpImportDialogView, mcpProfiles } from "./McpImportDialogView";
import { McpServiceCardView } from "./McpServiceCardView";
import { failureKind, hubSummary, matchServer } from "./model";
import type { HubServer, HubSnapshot } from "./state";

const profileName = (from?: string) =>
  from && (mcpProfiles as readonly string[]).includes(from)
    ? t(`mcp.profile.${from}`)
    : (from ?? "");

function ServerItem({
  server,
  query,
  busy,
  act,
  remove,
  now,
}: {
  server: HubServer;
  query: string;
  busy: string;
  act: (action: string, server: HubServer) => void;
  remove: (server: HubServer) => void;
  now: number;
}) {
  const [open, setOpen] = useState(false);
  const fixCopy = useCopyState();
  const match = matchServer(server, query);
  const searching = Boolean(query.trim());
  const expanded =
    open ||
    (searching &&
      match.tools.length > 0 &&
      match.tools.length < (server.tools?.length ?? 0));

  const origin =
    server.addedBy?.kind === "import"
      ? t("mcp.importedFrom", { from: profileName(server.addedBy.from) })
      : server.addedBy?.sourceLabel
        ? t("mcp.addedBy", { source: server.addedBy.sourceLabel })
        : server.addedBy?.kind === "local"
          ? t("mcp.addedLocally")
          : "";

  const checked =
    server.enabled && server.observedAt
      ? t("mcp.checked", {
          time: relativeTime(
            server.observedAt,
            now,
            locale.get(),
            t("time.justNow"),
          ),
        })
      : undefined;

  const facts = [
    server.envNames.length > 0 &&
      t("mcp.envNames", { names: server.envNames.join(", ") }),
    server.headerNames.length > 0 &&
      t("mcp.headerNames", { names: server.headerNames.join(", ") }),
    origin,
  ].filter((fact): fact is string => Boolean(fact));

  const hasFailure =
    server.enabled && server.state === "failed" && Boolean(server.error);
  const kind = hasFailure ? failureKind(server.error) : undefined;

  return (
    <McpServiceCardView
      name={server.name}
      transport={server.transport}
      target={server.transport === "http" ? server.endpoint : server.command}
      state={server.state}
      enabled={server.enabled}
      toolCount={server.toolCount}
      matchedCount={searching ? match.tools.length : undefined}
      tools={searching ? match.tools : (server.tools ?? [])}
      expanded={expanded}
      facts={facts}
      checkedLabel={checked}
      observedAt={server.observedAt}
      failure={
        hasFailure && kind
          ? {
              title: t(`mcp.failure.${kind}`),
              detail: t(`mcp.failureHint.${kind}`),
              code: server.error ?? "",
              copied: fixCopy.copied,
              copyError: fixCopy.error || undefined,
              onCopyFix: () => {
                void fixCopy.copy(
                  t("mcp.promptFix", {
                    name: server.name,
                    error: server.error ?? "",
                  }),
                );
              },
            }
          : undefined
      }
      busy={Boolean(busy)}
      refreshing={busy === `refresh:${server.name}`}
      onToggleExpand={() => setOpen(!expanded)}
      onRefresh={() => act("refresh", server)}
      onRemove={() => remove(server)}
      onToggleEnabled={(enabled) =>
        act(enabled ? "enable" : "disable", server)
      }
    />
  );
}

export default function McpHub({
  expanded,
  onToggleWidth,
  onClose,
}: {
  expanded: boolean;
  onToggleWidth: () => void;
  onClose: () => void;
}) {
  locale.use();
  const now = useAppNow(30_000);
  const [snapshot, setSnapshot] = useState<HubSnapshot>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [removing, setRemoving] = useState<HubServer>();
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const [reading, setReading] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string>();
  const promptCopy = useCopyState();
  const removal = useDialogCompletion(() => setRemoving(undefined));

  const copyPrompt = (key: string, text: string) => {
    setCopiedKey(key);
    void promptCopy.copy(text);
  };

  const refresh = useCallback((showProgress = true) => {
    if (showProgress) setReading(true);
    return api<HubSnapshot>("mcp-hub")
      .then(
        (value) => {
          setSnapshot(value);
          setError("");
        },
        (err) => setError(String(err)),
      )
      .finally(() => {
        if (showProgress) setReading(false);
      });
  }, []);

  const connecting =
    snapshot?.servers.some((server) => server.state === "connecting") ?? false;
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    const timer = setInterval(
      () => {
        if (!document.hidden) void refresh(false);
      },
      connecting ? 1000 : 15000,
    );
    return () => clearInterval(timer);
  }, [connecting, refresh]);

  async function act(action: string, server: HubServer) {
    const trigger =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : undefined;
    setBusy(`${action}:${server.name}`);
    setError("");
    try {
      const result = await api<{ error?: { message?: string } }>(
        "mcp-hub/configure",
        "POST",
        { action, name: server.name },
      );
      if (result?.error?.message) {
        setError(result.error.message);
        return;
      }
      await refresh();
      if (action === "remove") await removal.finish();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy("");
      requestAnimationFrame(() => {
        if (document.activeElement === document.body && trigger?.isConnected) {
          trigger.focus({ preventScroll: true });
        }
      });
    }
  }

  const summary = snapshot && hubSummary(snapshot.servers);
  const visible =
    snapshot?.servers.filter((server) => matchServer(server, query).server) ??
    [];

  return (
    <Panel
      role="region"
      className="mcp-page"
      title={t("mcp.title")}
      busy={reading || Boolean(busy)}
      expanded={expanded}
      onToggleWidth={onToggleWidth}
      onClose={onClose}
      returnFocus='[data-page="mcp-hub"]'
      headerNavigation={summary && <McpHubStatsView summary={summary} />}
      actions={
        Boolean(snapshot?.servers.length) && (
          <McpHubActionsView
            reading={reading}
            busy={Boolean(busy)}
            onAdd={() => setAdding(true)}
            onRefresh={() => void refresh()}
          />
        )
      }
    >
      <McpHubView
        loaded={Boolean(snapshot)}
        hasServers={Boolean(snapshot?.servers.length)}
        visibleCount={visible.length}
        query={query}
        busy={Boolean(busy)}
        reading={reading}
        error={error || undefined}
        searchSlot={
          <SearchInput
            className="mcp-search w-full"
            value={query}
            placeholder={t("mcp.search")}
            onChange={(event) => setQuery(event.target.value)}
          />
        }
        importCopied={copiedKey === "empty-import" && promptCopy.copied}
        importCopyError={
          copiedKey === "empty-import" ? promptCopy.error || undefined : undefined
        }
        onCopyImportPrompt={(text) => copyPrompt("empty-import", text)}
        onQueryChange={setQuery}
        onRetry={() => void refresh()}
      >
        {visible.map((server) => (
          <ServerItem
            key={server.name}
            server={server}
            query={query}
            busy={busy}
            act={act}
            remove={setRemoving}
            now={now}
          />
        ))}
      </McpHubView>

      {adding && (
        <Dialog
          title={t("mcp.addTitle")}
          onClose={() => setAdding(false)}
          footer={
            <Button onClick={() => setAdding(false)}>{t("close")}</Button>
          }
        >
          <McpImportDialogView
            copiedKey={promptCopy.copied ? copiedKey : undefined}
            copyErrorKey={promptCopy.error ? copiedKey : undefined}
            copyError={promptCopy.error || undefined}
            onCopyPrompt={copyPrompt}
          />
        </Dialog>
      )}

      {removing && (
        <ConfirmDialog
          layerId={removal.layerId}
          title={t("mcp.remove", { name: removing.name })}
          onClose={() => setRemoving(undefined)}
          busy={Boolean(busy)}
          confirmLabel={t("delete")}
          onConfirm={() => act("remove", removing)}
        >
          <p>{t("mcp.removeEffect", { name: removing.name })}</p>
          {error && <Notice>{error}</Notice>}
        </ConfirmDialog>
      )}
    </Panel>
  );
}
