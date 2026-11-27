import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUp, Ellipsis, LoaderCircle } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { locale, t } from "../i18n";
import { isDesktop, openUrl } from "../platform";
import { connector } from "../state/connector";
import { navigation } from "../state/navigation";
import {
  groupedReleaseNotes,
  releaseList,
  updateRange,
  type PublishedRelease,
} from "../state/releaseNotes";
import {
  available,
  checkUpdate,
  dismissUpdate,
  downloadUpdate,
  installUpdate,
  loadReleaseHistory,
  showUpdate,
  skipUpdate,
  updateActive,
  updates,
  updateVisible,
} from "../state/updates";
import { Notice } from "./kit/alert";
import { IconButton } from "./kit/button";
import { PopoverPrimitive } from "./kit/popover";
import { Icon, Menu } from "./ui";
import Dialog, { useDialogFeedback } from "./ui/Dialog";
import { TransientLayer } from "./ui/TransientLayer";
import { UpdateAboutView } from "./updates/UpdateAboutView";
import { UpdateHistoryView } from "./updates/UpdateHistoryView";
import {
  UpdatePanelView,
  type ReleaseNoteGroup,
} from "./updates/UpdatePanelView";
import "./AppUpdate.css";

const repository = "https://github.com/whzxc/agent-remote-control";

function useUpdateAction() {
  const feedback = useDialogFeedback();
  const mounted = useRef(true);
  const [actionError, setActionError] = useState("");
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const action = (promise: Promise<unknown>) => {
    setActionError("");
    void promise.catch((error) => {
      if (mounted.current) setActionError(String(error));
      else feedback(String(error), true);
    });
  };
  return { action, actionError };
}

const mb = (bytes: number) => (bytes / 1048576).toFixed(1);

function toNoteGroups(
  releases: PublishedRelease[],
  language: "en" | "zh-CN",
): ReleaseNoteGroup[] {
  return groupedReleaseNotes(releases, language).map((group) => {
    const bullets = group.entries.flatMap(({ markdown, version }) =>
      markdown
        .split(/\r?\n/)
        .filter((line) => line.trim())
        .map((line) => ({ version, text: /^[-*+] (.+)$/.exec(line)?.[1] })),
    );
    if (bullets.every((bullet) => bullet.text)) {
      return {
        title: group.title,
        bullets: bullets.map((bullet) => ({
          text: bullet.text!,
          version: bullet.version,
        })),
      };
    }
    return {
      title: group.title,
      entries: group.entries,
    };
  });
}

function ReleaseMarkdown({
  text,
  inline = false,
}: {
  text: string;
  inline?: boolean;
}) {
  const { action, actionError } = useUpdateAction();
  return (
    <>
      {actionError && (
        <Notice compact tone="danger">
          {actionError}
        </Notice>
      )}
      <ReactMarkdown
        skipHtml
        disallowedElements={["img"]}
        components={{
          ...(inline ? { p: ({ children }) => <>{children}</> } : {}),
          a: ({ href, children }) =>
            href?.startsWith("https://") ? (
              <a
                href={href}
                className="text-accent-text underline"
                onClick={(event) => {
                  event.preventDefault();
                  action(openUrl(href));
                }}
              >
                {children}
              </a>
            ) : (
              <span>{children}</span>
            ),
        }}
      >
        {text}
      </ReactMarkdown>
    </>
  );
}

function PanelContents() {
  const { action, actionError } = useUpdateAction();
  const state = updates.use();
  const { status } = connector.use();
  const language = locale.use();
  const [history, setHistory] = useState<PublishedRelease[]>([]);

  useEffect(() => {
    if (!state.panelOpen || !state.version) return;
    let current = true;
    void loadReleaseHistory().then(
      (rows) => {
        if (current) setHistory(rows);
      },
      () => {},
    );
    return () => {
      current = false;
    };
  }, [state.panelOpen, state.version]);

  const currentVersion = state.currentVersion ?? status?.version;
  const notes = state.notesZh
    ? `${state.notes ?? ""}\n\n<!-- lang:zh-CN -->\n\n${state.notesZh}`
    : (state.notes ?? "");
  const releases = state.version
    ? updateRange(history, currentVersion, { version: state.version, notes })
    : [];
  const noteGroups = toNoteGroups(releases, language);
  const downloading = state.phase === "downloading";

  return (
    <UpdatePanelView
      targetVersion={state.version}
      currentVersion={currentVersion}
      phase={state.phase}
      ready={state.ready}
      available={available()}
      downloadedAmount={
        downloading
          ? state.total
            ? `${mb(state.downloaded)} / ${mb(state.total)} MB`
            : `${mb(state.downloaded)} MB`
          : undefined
      }
      progressPercent={
        downloading && state.total
          ? (state.downloaded / state.total) * 100
          : undefined
      }
      error={state.error}
      actionError={actionError}
      message={state.message}
      noteGroups={noteGroups}
      showNoteVersions={releases.length > 1}
      renderMarkdown={(text, inline) => (
        <ReleaseMarkdown text={text} inline={inline} />
      )}
      onDismiss={dismissUpdate}
      onPrimaryAction={() =>
        action(
          state.ready ? installUpdate(state.version) : downloadUpdate(),
        )
      }
      onRetryCheck={() => action(checkUpdate())}
    />
  );
}

export function UpdateDock() {
  const state = updates.use();
  if (!updateVisible() && !state.panelOpen) return null;
  const active = updateActive();
  const installing = state.phase === "installing";

  return (
    <>
      <span className="update-dock-divider" aria-hidden="true" />
      <PopoverPrimitive.Root
        modal={false}
        open={state.panelOpen}
        onOpenChange={(open, details) => {
          if (details.reason === "escape-key") {
            details.event.stopPropagation();
            if (installing) {
              details.cancel();
              return;
            }
          }
          if (installing) {
            details.cancel();
            return;
          }
          if (open) showUpdate();
          else dismissUpdate();
        }}
      >
        <PopoverPrimitive.Trigger
          render={
            <button
              type="button"
              className="update-dock-entry"
              data-hover-target="updates"
              aria-label={t("viewUpdate")}
            />
          }
        >
          <Icon
            icon={active ? LoaderCircle : ArrowUp}
            size={20}
            className={active ? "update-ring" : undefined}
          />
          {available() && <span className="update-available-dot" />}
        </PopoverPrimitive.Trigger>
        <PopoverPrimitive.Portal>
          <TransientLayer
            onDismiss={() => {
              if (!installing) dismissUpdate();
            }}
          >
            <PopoverPrimitive.Positioner
              side="top"
              align="end"
              sideOffset={12}
              collisionPadding={16}
              className="z-60"
            >
              <PopoverPrimitive.Popup
                className="update-panel rounded-dialog"
                aria-label={t("appUpdates")}
                style={{
                  maxHeight:
                    "min(650px, calc(100dvh - 100px), var(--available-height, 650px))",
                }}
              >
                <PanelContents />
              </PopoverPrimitive.Popup>
            </PopoverPrimitive.Positioner>
          </TransientLayer>
        </PopoverPrimitive.Portal>
      </PopoverPrimitive.Root>
    </>
  );
}

function UpdateHistory({ currentVersion, onClose }: { currentVersion?: string; onClose: () => void }) {
  const { action, actionError } = useUpdateAction();
  const language = locale.use();
  const [request, setRequest] = useState(0);
  const [releases, setReleases] = useState<PublishedRelease[]>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let current = true;
    void loadReleaseHistory().then(
      (rows) => {
        if (current) setReleases(releaseList(rows, currentVersion));
      },
      () => {
        if (current) setFailed(true);
      },
    );
    return () => {
      current = false;
    };
  }, [currentVersion, request]);

  const retry = () => {
    setFailed(false);
    setRequest((previous) => previous + 1);
  };

  return (
    <Dialog
      title={t("updates.history")}
      className="update-history"
      onClose={onClose}
    >
      <UpdateHistoryView
        releases={releases?.map((release) => ({
          version: release.version,
          groups: toNoteGroups([release], language),
        }))}
        loading={!releases && !failed}
        failed={failed}
        actionError={actionError}
        renderMarkdown={(text, inline) => (
          <ReleaseMarkdown text={text} inline={inline} />
        )}
        onRetry={retry}
        onOpenAllReleases={() => action(openUrl(`${repository}/releases`))}
      />
    </Dialog>
  );
}

export function AppUpdate({ children }: { children?: ReactNode }) {
  const { action, actionError } = useUpdateAction();
  const { status } = connector.use();
  const state = updates.use();
  const [historyOpen, setHistoryOpen] = useState(false);
  const currentVersion = state.currentVersion ?? status?.version;
  const checking = state.phase === "checking";
  const feedback = state.error || state.message;
  const label = checking
    ? t("checkingLabel")
    : state.phase === "downloading"
      ? t("downloadingValueMb", { size: mb(state.downloaded) })
      : feedback
        ? state.error
          ? t("updateCheckRetry")
          : state.message!
        : t("checkForUpdates");

  return (
    <>
      <UpdateAboutView
        currentVersion={currentVersion}
        checkLabel={label}
        checkTooltip={feedback || label}
        checking={checking}
        checkDisabled={!isDesktop || updateActive()}
        updateAvailable={available()}
        actionError={!state.error ? actionError : undefined}
        overflowMenuSlot={
          <Menu
            label={t("appUpdates")}
            trigger={
              <IconButton compact icon={Ellipsis} label={t("appUpdates")} />
            }
            items={[
              {
                label: t("skipThisVersion"),
                action: skipUpdate,
                disabled: updateActive(),
              },
            ]}
          />
        }
        trailingNavSlot={children}
        onCheckUpdate={() => action(checkUpdate())}
        onViewUpdate={() => {
          navigation.set((old) => ({ ...old, page: "overview" }));
          showUpdate();
        }}
        onOpenHistory={() => setHistoryOpen(true)}
        onOpenRepository={() => action(openUrl(repository))}
      />
      {historyOpen && (
        <UpdateHistory
          currentVersion={currentVersion}
          onClose={() => setHistoryOpen(false)}
        />
      )}
    </>
  );
}
