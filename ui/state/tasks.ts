import { createStore } from "./store";
import { api } from "../api";
import { isDesktop, notifyNative } from "../platform";
import { t } from "../i18n";
import type { TaskOwnership } from "../types";
export interface TaskRecord {
  agentAccountId?: string | null;
  agent?: string;
  open?: { taskId: string };
  taskId?: string;
  origin?: import("../types").AgentActivitySession["origin"];
  requestId: string;
  executionOwner?: "desktop" | "connector";
  threadId?: string;
  turnId?: string;
  runtime?: TaskRuntime;
  state: string;
  createdAt: string;
  updatedAt: string;
  approval: { answeredBy?: import("../types").AnsweredBy; decision: string; source: string; at: string };
  error?: { message?: string };
  task: {
    origin?: import("../types").AgentActivitySession["origin"];
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
  status?: string;
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
let refreshing: Promise<void> | undefined, seen: Set<string> | undefined, revision: string | undefined;
type TaskFeed = { records?: TaskRecord[]; revision?: string; removed?: string[] };

function compareTasks(a: TaskRecord, b: TaskRecord) {
  if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt ? -1 : 1;
  return a.requestId < b.requestId ? -1 : a.requestId > b.requestId ? 1 : 0;
}

export function refreshTasks() {
  if (refreshing) return refreshing;
  refreshing = (isDesktop
    ? api<TaskFeed>("tasks/snapshot", "POST", revision ? { revision } : {})
    : api<TaskFeed>("tasks"))
    .then((data) => {
      revision = data.revision;
      const current = tasks.get();
      if (!data.records || data.records === current.records) {
        if (current.loading || current.error) tasks.set({ ...current, loading: false, error: "" });
        return;
      }
      let records = data.records;
      if (data.removed) {
        const next = new Map(current.records.map(row => [row.requestId, row]));
        for (const id of data.removed) next.delete(id);
        for (const row of data.records) next.set(row.requestId, row);
        records = [...next.values()].sort(compareTasks);
      }
      const ids = new Set(
        records
          .filter((r) => r.state === "awaiting-approval")
          .map((r) => r.requestId),
      );
      if (seen && [...ids].some((id) => !seen!.has(id)))
        void notifyNative(
          t("newTaskRequestsAwaitApproval"),
          t("confirmInConnectorOrChatgptOrExecuteDirectly"),
        ).catch(() => {});
      seen = ids;
      tasks.set({ records, error: "", loading: false });
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
