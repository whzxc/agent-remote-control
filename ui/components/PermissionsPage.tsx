import { useEffect, useState } from "react";
import { api } from "../api";
import { locale } from "../i18n";
import { isDesktop, openUrl } from "../platform";
import { connector } from "../state/connector";
import {
  permissions,
  refreshPermissions,
  type PermissionItem,
} from "../state/permissions";
import {
  PermissionsPageView,
  type PermissionRowItem,
} from "./permissions/PermissionsPageView";
import { useDialogFeedback } from "./ui/Dialog";
import { usePanelState } from "./ui/Panel";

const systemIds = [
  "accessibility",
  "screen-recording",
  "full-disk-access",
  "notifications",
  "login-start",
];

function combined(a?: PermissionItem, b?: PermissionItem): string {
  const states = [a?.state ?? "unknown", b?.state ?? "unknown"];
  return states.includes("missing")
    ? "missing"
    : states.includes("unknown")
      ? "unknown"
      : states.every((state) => state === "not-applicable")
        ? "not-applicable"
        : "granted";
}

export default function PermissionsPage() {
  const notify = useDialogFeedback();
  const { data, loading } = permissions.use();
  const [acting, setActing] = useState(false);
  const busy = loading || acting;
  usePanelState({ busy });
  const { status } = connector.use();
  const currentLocale = locale.use();

  useEffect(() => {
    void refreshPermissions().catch((error) => notify(String(error), true));
  }, []);

  const find = (id: string) => data?.items.find((item) => item.id === id);
  const disk = find("full-disk-access");
  const commandDisk = find("command-full-disk-access");
  const appName =
    disk?.grantTarget?.split("/").pop()?.replace(/\.app$/, "") ||
    "Agent Remote Control";
  const mac = status?.platform === "darwin";

  const rows: PermissionRowItem[] = [
    ...systemIds.map((id) => ({
      id,
      system: true,
      state:
        id === "full-disk-access"
          ? combined(disk, commandDisk)
          : (find(id)?.state ?? "unknown"),
      diskMismatch:
        id === "full-disk-access" &&
        Boolean(disk && commandDisk && disk.state !== commandDisk.state),
    })),
    {
      id: "codex",
      system: false,
      state: combined(find("codex-desktop"), find("codex-login")),
    },
    {
      id: "claude-code",
      system: false,
      state: find("claude-code")?.state ?? "unknown",
    },
  ];
  const visible = rows.filter(
    (row) => row.state !== "not-applicable" && (mac || !row.system),
  );

  async function act(id: string) {
    if (id === "codex" || id === "claude-code") {
      await openUrl(
        "https://github.com/whzxc/agent-remote-control/blob/main/docs/" +
          (currentLocale === "zh-CN" ? "zh-CN/" : "") +
          "getting-started.md",
      );
      return;
    }
    setActing(true);
    try {
      if (id === "login-start") {
        await api("service", "POST", { enabled: true });
      } else {
        await api("permissions/request", "POST", { id });
      }
      await refreshPermissions();
    } catch (error) {
      notify(String(error), true);
    } finally {
      setActing(false);
    }
  }

  if (!data) return <div className="permissions-page" />;

  return (
    <PermissionsPageView
      showSystem={mac}
      appName={appName}
      items={visible}
      busy={busy}
      desktopAvailable={isDesktop}
      onAction={(id) => void act(id).catch((error) => notify(String(error), true))}
    />
  );
}
