import { createStore } from "./store";
import { api } from "../api";
import { notifyNative } from "../platform";
import { t } from "../i18n";
import type { TaskOwnership } from "../types";
export interface TaskRecord {
  agent?: string;
  open?: { taskId: string };
  taskId?: string;
  origin?: { ingressId?: string; sourceId?: string; sourceLabel?: string };
  requestId: string;
  executionOwner?: "desktop" | "connector";
  threadId?: string;
  turnId?: string;
  runtime?: TaskRuntime;
  state: string;
  createdAt: string;
  updatedAt: string;
  approval: { decision: string; source: string; at: string };
  error?: { message?: string };
  task: {
    origin?: { ingressId?: string; sourceId?: string; sourceLabel?: string };
    detailsRecorded?: boolean;
    kind: string;
    title?: string;
    prompt: string;
    promptTruncated?: boolean;
    project?: string;
    directory?: string;
    threadId?: string;
    model?: string;
    effort?: string;
  };
}
export interface TaskRuntime {
  ownership?: TaskOwnership;
  archived?: boolean;
  runtimeStatus: string;
  title?: string;
  project?: string;
  observedAt: string;
  stale?: boolean;
}
export const tasks = createStore<{
  records: TaskRecord[];
  error: string;
  loading: boolean;
}>({ records: [], error: "", loading: true });
let refreshing: Promise<void> | undefined, seen: Set<string> | undefined;
export function refreshTasks() {
  if (refreshing) return refreshing;
  refreshing = api<{ records: TaskRecord[] }>("tasks")
    .then((data) => {
      const ids = new Set(
        data.records
          .filter((r) => r.state === "awaiting-approval")
          .map((r) => r.requestId),
      );
      if (seen && [...ids].some((id) => !seen!.has(id)))
        void notifyNative(
          t("newTaskRequestsAwaitApproval"),
          t("confirmInConnectorOrChatgptOrExecuteDirectly"),
        ).catch(() => {});
      seen = ids;
      tasks.set({ records: data.records, error: "", loading: false });
    })
    .catch((e) =>
      tasks.set((old) => ({ ...old, error: String(e), loading: false })),
    )
    .finally(() => {
      refreshing = undefined;
    });
  return refreshing;
}
export function startTasks() {
  void refreshTasks();
  const timer = setInterval(() => void refreshTasks(), 5000);
  return () => clearInterval(timer);
}
