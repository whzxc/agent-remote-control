import { createStore } from "./store";
import { api } from "../api";
import { isDesktop, notifyNative } from "../platform";
import { t } from "../i18n";
import type { DispatchSummary, TaskOwnership } from "../types";
export interface TaskRecord {
  agent?: string;
  open?: { taskId: string };
  taskId?: string;
  origin?: import("../types").AgentActivitySession["origin"];
  requestId: string;
  executionOwner?: "desktop" | "connector";
  submissionStage?: string;
  desktopRecovery?: { state: string; decisionId?: string; reason?: string; target?: { pid: number } };
  threadId?: string;
  turnId?: string;
  runtime?: TaskRuntime;
  requested?: Pick<DispatchSummary, "model" | "effort" | "serviceTier">;
  state: string;
  createdAt: string;
  updatedAt: string;
  approval: { answeredBy?: import("../types").AnsweredBy; decision: string; source: string; at: string };
  error?: { code?: string; message?: string; version?: number };
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
      const approvals = records.filter(r => r.state === "awaiting-approval");
      const key = (r: TaskRecord) => r.desktopRecovery?.decisionId ?? r.requestId;
      const ids = new Set(approvals.map(key));
      const arrived = seen && approvals.find(r => !seen!.has(key(r)));
      if (arrived) {
        const desktop = arrived.desktopRecovery?.state === "waiting-for-local";
        void notifyNative(
          t(desktop ? "desktopRecovery.waiting" : "newTaskRequestsAwaitApproval"),
          t(desktop ? "desktopRecovery.chooseInSettings" : "confirmInConnectorOrChatgptOrExecuteDirectly"),
        ).catch(() => {});
      }
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
