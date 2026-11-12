import type { TaskStepKind } from './taskProjection.ts';
import type { AgentActivitySession, AgentActivitySnapshot, AgentInteraction } from "../types.ts";
import { taskHierarchy } from './taskHierarchy.ts';
import { orderedSubset } from '../topology/order.ts';

// Activity events describe current observations; absence is not a terminal result.
export function mergeActivity(current: AgentActivitySnapshot | undefined, next: AgentActivitySnapshot) {
  return current && Date.parse(next.observedAt) < Date.parse(current.observedAt) ? current : next;
}
export const activityLayout = { hold: 2000, fade: 300 };
export const bubbleHeights = { compact: 54, standard: 76, detailed: 100 };
export const bubbleWidths = { narrow: 232, medium: 264, wide: 304 };
export type BubbleDensity = keyof typeof bubbleHeights;
export type BubbleWidth = keyof typeof bubbleWidths;
export function effectiveBubbleDensity(density: BubbleDensity, autoCompact: boolean, count: number): BubbleDensity {
  return autoCompact && count > 4 ? density === "detailed" ? "standard" : "compact" : density;
}
export type TrackedActivity = AgentActivitySession & { orderAt: number; observed?: boolean; selectedTurnId?: string; endedAt?: number; readAt?: number; conversation?: boolean; status?: string | null };
export interface ActivityRead {
  agent: string; id: string; readAt: number; turnId?: string; turnStartedAt?: string;
}
export const activityReadRetention = { maxAge: 30 * 24 * 60 * 60 * 1000, maxEntries: 1000 };
export function pruneActivityReads(value: unknown, now: number): ActivityRead[] {
  const entries = Array.isArray(value) ? value.filter((row): row is ActivityRead => row && typeof row.agent === "string" && row.agent.length > 0
    && typeof row.id === "string" && row.id.length > 0 && Number.isFinite(row.readAt)
    && row.readAt > now - activityReadRetention.maxAge && row.readAt <= now) : [];
  const unique = new Map<string, ActivityRead>();
  for (const row of entries.sort((a, b) => b.readAt - a.readAt)) {
    const key = JSON.stringify([row.agent, row.id]);
    if (!unique.has(key)) unique.set(key, { agent: row.agent, id: row.id, readAt: row.readAt,
      ...(typeof row.turnId === "string" && row.turnId ? { turnId: row.turnId } : {}),
      ...(typeof row.turnStartedAt === "string" && row.turnStartedAt ? { turnStartedAt: row.turnStartedAt } : {}) });
    if (unique.size === activityReadRetention.maxEntries) break;
  }
  return [...unique.values()];
}
export function activityReadMatches(read: ActivityRead, session: AgentActivitySession) {
  if (read.turnId && session.turnId) return read.turnId === session.turnId;
  if (read.turnStartedAt && session.turnStartedAt) return read.turnStartedAt === session.turnStartedAt;
  return true;
}
export type AgentPanelSelection = { agent: string; accountId?: string; platform?: true; session?: TrackedActivity; closing?: boolean } | undefined;
export type AgentPanelAction = { type: "agent" | "toggle"; agent: string; accountId?: string } | { type: "platform"; agent: string; toggle?: boolean } | { type: "task"; agent: string; session: TrackedActivity; toggle?: boolean } | { type: "back" } | { type: "dismiss" } | { type: "closed" };
export function agentPanelSelection(current: AgentPanelSelection, action: AgentPanelAction): AgentPanelSelection {
  if (action.type === "closed") return undefined;
  if (action.type === "dismiss") return current && { ...current, closing: true };
  if (action.type === "task" && action.toggle && current?.agent === action.agent && current.session?.id === action.session.id) return { ...current, closing: true };
  if (action.type === "platform") return action.toggle && current?.agent === action.agent && current.platform
    ? { ...current, closing: true } : { agent: action.agent, platform: true };
  if (action.type === "back") return current && { agent: current.agent, ...(current.accountId ? { accountId: current.accountId } : {}) };
  if (action.type === "toggle" && !current?.platform && current?.agent === action.agent && current.accountId === action.accountId) return { ...current, closing: true };
  const accountId = action.type === "task" ? action.session.agentAccountId ?? action.session.dispatchSummary?.agentAccountId : action.accountId;
  return { agent: action.agent, ...(accountId ? { accountId } : {}), ...(action.type === "task" ? { session: action.session } : {}) };
}
// Freeze the start order on first observation; changing phases/headlines never moves a task.
export function trackActivity(previous: readonly TrackedActivity[], sessions: readonly AgentActivitySession[], now: number, pinnedId?: string): TrackedActivity[] {
  const old = new Map(previous.map(s => [s.id, s]));
  const live = new Set(sessions.map(s => s.id));
  return [
    ...sessions.map(s => ({ ...s, parentSessionId: s.parentSessionId ?? old.get(s.id)?.parentSessionId, relationKind: s.relationKind ?? old.get(s.id)?.relationKind, observed: true, orderAt: old.get(s.id)?.orderAt ?? (Number.isFinite(Date.parse(s.startedAt ?? "")) ? Date.parse(s.startedAt!) : now) })),
    ...previous.filter(s => !live.has(s.id)).map(s => ({ ...s, observed: false, phase: "idle" as const, interaction: undefined,
      readAt: s.readAt ?? (s.endedAt !== undefined && s.id === pinnedId ? now : undefined) }))
      .filter(s => s.readAt === undefined || s.id === pinnedId || now < s.readAt + activityLayout.hold + activityLayout.fade),
  ].sort((a, b) => Number(!!b.interaction) - Number(!!a.interaction) || a.orderAt - b.orderAt || a.id.localeCompare(b.id));
}
// Attention is a hard partition; manual order applies within each partition.
export function orderActivity(sessions: readonly TrackedActivity[], ids: readonly string[]) {
  const rank = new Map(ids.map((id, index) => [id, index]));
  return [...sessions].sort((a, b) => Number(!!b.interaction) - Number(!!a.interaction)
    || (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity)
    || a.orderAt - b.orderAt || a.id.localeCompare(b.id));
}
export function visibleActivity(sessions: readonly TrackedActivity[], pinnedId?: string, expanded: boolean | string = false) {
  // Overflow keeps unfinished work ahead of completions, regardless of stored order.
  const ordered = sessions.length > 5
    ? [...sessions.filter(s => s.endedAt === undefined), ...sessions.filter(s => s.endedAt !== undefined)] : sessions;
  const family = activityHierarchy(ordered);
  const byId = new Map(family.map(row => [row.task.id, row]));
  const rootId = (id: string) => {
    let row = byId.get(id)!;
    while (row.parentTaskId) row = byId.get(row.parentTaskId)!;
    return row.task.id;
  };
  const roots = [...new Set(ordered.map(session => rootId(session.id)))];
  const visibleRoots = roots.slice(0, expanded === true ? roots.length : roots.length > 5 ? 4 : 5);
  if (pinnedId && byId.has(pinnedId) && !visibleRoots.includes(rootId(pinnedId))) visibleRoots[visibleRoots.length - 1] = rootId(pinnedId);
  const included = new Set(visibleRoots);
  const children = new Map<string, TrackedActivity[]>();
  for (const session of ordered) {
    const parent = byId.get(session.id)?.parentTaskId;
    if (parent) children.set(parent, [...(children.get(parent) ?? []), session]);
  }
  const include = (id: string) => {
    const own = children.get(id) ?? [];
    const visible = expanded === true || expanded === id ? own : own.slice(0, 3);
    for (const child of own) if ((child.interaction || child.id === pinnedId) && !visible.includes(child)) visible.push(child);
    for (const child of visible) { included.add(child.id); include(child.id); }
  };
  for (const id of visibleRoots) include(id);
  for (const session of ordered.filter(row => row.id === pinnedId || row.interaction)) {
    if (!visibleRoots.includes(rootId(session.id))) continue;
    let id: string | undefined = session.id;
    while (id) { included.add(id); id = byId.get(id)?.parentTaskId; }
  }
  const originals = new Map(sessions.map(session => [session.id, session]));
  const shown = family.filter(row => included.has(row.task.id)).map(row => originals.get(row.task.id)!);
  const hiddenGroups = new Map<string | undefined, TrackedActivity[]>();
  for (const row of family.filter(row => !included.has(row.task.id))) {
    let parent = row.parentTaskId;
    while (parent && !included.has(parent)) parent = byId.get(parent)?.parentTaskId;
    hiddenGroups.set(parent, [...(hiddenGroups.get(parent) ?? []), originals.get(row.task.id)!]);
  }
  const hidden = sessions.length - shown.length;
  return { sessions: shown, hidden, count: shown.length + hiddenGroups.size,
    hiddenGroups: [...hiddenGroups].map(([parentId, sessions]) => ({ parentId, sessions })) };
}
export function reorderActivity(sessions: readonly TrackedActivity[], ids: readonly string[], stored: readonly string[], queue: readonly TrackedActivity[] = sessions): string[] | undefined {
  // Use the whole displayed queue, including hidden tasks, before merging its order into the Agent preference.
  const current = orderActivity(sessions, stored);
  const presented = visibleActivity(orderActivity(queue, stored), undefined, true).sessions;
  // Settle cross-completion moves inside their group before detecting a no-op.
  const after = visibleActivity(orderedSubset(presented, ids), undefined, true).sessions;
  if (after.every((session, index) => session === presented[index])) return;
  return orderedSubset(current, after.map(session => session.id)).map(session => session.id);
}
export function activityHierarchy(sessions: readonly TrackedActivity[]) {
  const ids = new Map(sessions.flatMap(session => [[session.id, session.id], ...(session.nativeSessionId ? [[session.nativeSessionId, session.id]] : [])] as [string, string][]));
  return taskHierarchy(sessions.map(session => ({ ...session, parentTaskId: session.parentSessionId ? ids.get(session.parentSessionId) : undefined })));
}
// Resolve the complete family before account grouping or visibility limits.
export function activityFamilyAccounts(sessions: readonly TrackedActivity[], accountGroup: (id: string | null | undefined) => string | undefined) {
  const accounts = new Map<string, string | undefined>();
  for (const { task, parentTaskId } of activityHierarchy(sessions)) {
    accounts.set(task.id, parentTaskId ? accounts.get(parentTaskId) : accountGroup(task.agentAccountId ?? task.dispatchSummary?.agentAccountId));
  }
  return accounts;
}
export function interactionKey(agent: string, session: AgentActivitySession) {
  return JSON.stringify([agent, session.id, session.phaseSince, session.interaction?.respond]);
}
export type ApprovalDecision = "allow" | "deny" | "answer" | "cancel";
export type ApprovalPayload = { op: "agent_respond" | "codex_respond"; args: Record<string, unknown> };
export function permissionResponse(interaction: AgentInteraction, decision: "allow" | "deny"): ApprovalPayload | undefined {
  const { op, args } = interaction.respond;
  if (interaction.kind !== "permission" || interaction.canRespond === false || !op || !args) return;
  if (op === "codex_respond" && interaction.method && !["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(interaction.method)) return;
  if (op === "codex_respond") return { op, args: { ...args, result: { decision: decision === "allow" ? "accept" : "decline" } } };
  if (args.agent === "pi") return { op, args: { ...args, confirmed: decision === "allow" } };
  const options = Array.isArray(interaction.options) ? interaction.options as { kind?: string; optionId?: string }[] : [];
  // Never silently grant a persistent permission for an Allow click.
  const option = options.find(o => o.kind === (decision === "allow" ? "allow_once" : "reject_once"));
  if (option?.optionId) return { op, args: { ...args, optionId: option.optionId } };
  if (decision === "deny") return { op, args: { ...args, cancelled: true } };
}
export interface ApprovalSubmission {
  decision: ApprovalDecision;
  payload: ApprovalPayload;
  status: "submitting" | "submitted" | "pending" | "failed" | "unconfirmed";
  error?: string;
}
export function beginApproval(previous: ApprovalSubmission | undefined, decision: ApprovalDecision,
  payload: ApprovalPayload, requestId: () => string): ApprovalSubmission | undefined {
  if (previous && (previous.decision !== decision || ["submitting", "submitted", "unconfirmed"].includes(previous.status))) return;
  return { decision, payload: previous?.payload ?? { ...payload, args: { ...payload.args, requestId: requestId() } }, status: "submitting" };
}
export function finishApproval(submission: ApprovalSubmission, receipt: { state?: string; error?: unknown; result?: { responded?: boolean; error?: unknown } }): ApprovalSubmission {
  if (receipt.state === "completed" && receipt.result?.responded !== false) return { ...submission, status: "submitted" };
  if (["reserved", "executing"].includes(receipt.state ?? "")) return { ...submission, status: "pending" };
  return { ...submission, status: receipt.state === "unconfirmed" ? "unconfirmed" : "failed",
    error: typeof receipt.error === "string" ? receipt.error : JSON.stringify(receipt.error ?? receipt.result?.error ?? receipt.state ?? "Unknown response") };
}

export function questionResponse(interaction: AgentInteraction, value: string, cancelled = false): ApprovalPayload | undefined {
  const { op, args } = interaction.respond;
  if (interaction.kind !== "question" || interaction.canRespond === false || op !== "agent_respond" || args?.agent !== "pi") return;
  if (!cancelled && interaction.method === "select" && (!Array.isArray(interaction.options) || !interaction.options.includes(value))) return;
  return { op, args: { ...args, ...(cancelled ? { cancelled: true } : { value }) } };
}

// Lexical paths only: display never accesses the filesystem or changes native paths.
export function filePathParts(path: string, project?: string | null) {
  const normalize = (value: string) => {
    const slash = value.replaceAll("\\", "/");
    const root = slash.match(/^(?:[a-z]:\/|\/\/|\/)/i)?.[0] ?? "";
    const parts: string[] = [];
    for (const part of slash.slice(root.length).split("/")) {
      if (!part || part === ".") continue;
      if (part === ".." && parts.length && parts.at(-1) !== "..") parts.pop();
      else if (part !== ".." || !root) parts.push(part);
    }
    return root + parts.join("/");
  };
  const base = project ? normalize(project).replace(/\/$/, "") : "";
  const absolute = /^(?:[a-z]:[\\/]|[\\/])/i.test(path);
  const fullPath = normalize(!absolute && project ? `${project}/${path}` : path);
  const prefix = `${base}/`;
  const windows = /^[a-z]:\//i.test(fullPath) || fullPath.startsWith("//");
  const inside = !!project && (windows ? fullPath.toLowerCase().startsWith(prefix.toLowerCase()) : fullPath.startsWith(prefix));
  const displayPath = inside ? fullPath.slice(prefix.length) : fullPath;
  const split = displayPath.lastIndexOf("/") + 1;
  return { fullPath, displayPath, directory: displayPath.slice(0, split), filename: displayPath.slice(split) };
}

export function activityHeadline(session: Pick<AgentActivitySession, "headline" | "phase" | "interaction" | "project" | "fallbackHeadline" | "title">, empty = "") {
  const path = session.interaction ? session.interaction.path?.trim() || undefined : session.phase === "file" ? session.headline.trim() || undefined : undefined;
  const current = path || session.headline.trim();
  const text = current || session.fallbackHeadline?.trim() || session.title?.trim() || empty;
  return { text, path, fallback: !current, fullText: path ? filePathParts(path, session.project).fullPath : text };
}

export type HomepageTaskGroup = 'needs-me' | 'running' | 'unread' | 'unconfirmed' | 'recent';
export type HomepageTask = {
  key: string; agent: string; session: TrackedActivity; group: HomepageTaskGroup;
  deviceId?: string; controllerDeviceId?: string; upstreamSourceId?: string; sourceIds: string[]; accountId?: string | null;
  activity: ReturnType<typeof import('./taskProjection.ts').taskCardActivity>;
  partial: boolean; freshness?: string; startedAt?: string | null; endedAt?: string | null;
};
export function homepageTaskGroup(session: TrackedActivity, pending: boolean, status?: string): HomepageTaskGroup {
  if (session.observed !== false && session.endedAt === undefined) return pending ? 'needs-me' : 'running';
  if (session.endedAt !== undefined || ['completed', 'failed', 'cancelled', 'interrupted'].includes(status ?? '')) return session.readAt === undefined ? 'unread' : 'recent';
  return 'unconfirmed';
}

const phaseFor = (task: HomepageTask) => task.activity.steps.at(-1)?.kind ?? ({ command: 'command', thinking: 'thinking' } as const)[task.session.phase as 'command' | 'thinking'];
export function nodeTaskState(tasks: HomepageTask[], offline = false): NodeTaskState {
  const running = tasks.filter(task => task.group === 'running');
  return { attention: offline ? 0 : tasks.filter(task => task.group === 'needs-me').length, running: offline ? 0 : running.length,
    unread: offline ? 0 : tasks.filter(task => task.group === 'unread').length,
    unconfirmed: offline || tasks.some(task => task.group === 'unconfirmed') && !tasks.some(task => task.group === 'running' || task.group === 'needs-me'), steps: running.map(phaseFor) };
}

export type NodeTaskState = { attention: number; running: number; unread: number; unconfirmed?: boolean; steps: (TaskStepKind | undefined)[] };

type Item = { kind: 'attention'; count: number } | { kind: 'step'; step?: TaskStepKind } | { kind: 'overflow' } | { kind: 'unconfirmed' };
export function capsuleItems(state: NodeTaskState, compact: boolean): Item[] {
  if (state.unconfirmed) return [{ kind: 'unconfirmed' }];
  const items: Item[] = state.attention ? [{ kind: 'attention', count: state.attention }] : [];
  const room = (compact ? 2 : 5) - items.length;
  const shown = state.running > room ? room - 1 : state.running;
  for (let index = 0; index < shown; index++) items.push({ kind: 'step', step: state.steps[index] });
  if (state.running > shown) items.push({ kind: 'overflow' });
  return items;
}

export function remoteTaskReadKey(task: Pick<HomepageTask, 'key' | 'session'>) {
  return JSON.stringify([task.key, task.session.turnId ?? task.session.turnStartedAt ?? task.session.startedAt ?? task.session.id]);
}
export function projectDeviceTasks(device: import('../devices/state').Device, observation: import('../devices/tasks').DeviceTaskObservation,
  reads: readonly string[]): HomepageTask[] {
  const snapshot = observation.snapshot;
  if (!snapshot) return [];
  const sessions = new Map<string, { agent: string; session: TrackedActivity }>();
  for (const [agent, activity] of Object.entries(snapshot.agents)) {
    for (const session of activity.sessions) sessions.set(JSON.stringify([agent, session.id]), { agent,
      session: { ...session, observed: true, orderAt: Date.parse(session.startedAt ?? snapshot.observedAt) } });
  }
  for (const record of snapshot.records.slice(0, 200)) {
    const agent = record.agent ?? 'codex', id = record.taskId ?? record.threadId ?? record.task.threadId;
    if (!id || sessions.has(JSON.stringify([agent, id]))) continue;
    sessions.set(JSON.stringify([agent, id]), { agent, session: {
      id, source: 'arc-task', title: record.runtime?.title ?? record.task.title ?? record.task.prompt,
      project: record.task.project ?? record.task.directory, agentAccountId: record.agentAccountId,
      headline: '', phase: 'idle', phaseSince: null, timeline: false, observed: false,
      orderAt: Date.parse(record.createdAt), startedAt: record.createdAt, turnId: record.turnId,
      status: record.runtime?.status ?? record.runtime?.runtimeStatus, origin: record.origin ?? record.task.origin,
    } });
  }
  const unconfirmed = device.state === 'offline' || !!observation.error;
  return [...sessions.values()].map(({ agent, session }) => {
    const key = JSON.stringify([device.id, agent, session.id]);
    const read = reads.includes(remoteTaskReadKey({ key, session }));
    const current = { ...session, ...(read ? { readAt: 1 } : {}), ...(unconfirmed ? { observed: false, interaction: undefined } : {}) };
    return { key, agent, deviceId: device.id, controllerDeviceId: session.origin?.deviceId ?? session.dispatchSummary?.controlSource?.deviceId,
      session: current, group: unconfirmed ? 'unconfirmed' : homepageTaskGroup(current, !!current.interaction, current.status ?? undefined),
      sourceIds: session.origin?.peerOrigin?.sourceId ? [session.origin.peerOrigin.sourceId] : [],
      accountId: session.agentAccountId ?? session.dispatchSummary?.agentAccountId,
      activity: { steps: [], plan: undefined, change: undefined }, partial: true, startedAt: unconfirmed ? undefined : session.turnStartedAt,
      freshness: device.lastSeen ?? snapshot.observedAt };
  });
}
