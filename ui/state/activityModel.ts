import type { AgentActivitySession, AgentActivitySnapshot, AgentInteraction } from "../types.ts";

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
export type AgentPanelAction = { type: "agent" | "toggle"; agent: string; accountId?: string } | { type: "platform"; agent: string; toggle?: boolean } | { type: "task"; agent: string; session: TrackedActivity } | { type: "back" } | { type: "dismiss" } | { type: "closed" };
export function agentPanelSelection(current: AgentPanelSelection, action: AgentPanelAction): AgentPanelSelection {
  if (action.type === "closed") return undefined;
  if (action.type === "dismiss") return current && { ...current, closing: true };
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
    ...sessions.map(s => ({ ...s, observed: true, orderAt: old.get(s.id)?.orderAt ?? (Number.isFinite(Date.parse(s.startedAt ?? "")) ? Date.parse(s.startedAt!) : now) })),
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
export function visibleActivity(sessions: readonly TrackedActivity[], pinnedId?: string, expanded = false) {
  // Overflow hides finished work first, preserving order within each group.
  const ordered = sessions.length > 5
    ? [...sessions.filter(s => s.endedAt === undefined), ...sessions.filter(s => s.endedAt !== undefined)] : sessions;
  const visible = ordered.slice(0, expanded ? ordered.length : ordered.length > 5 ? 4 : 5);
  const pinned = sessions.find(s => s.id === pinnedId);
  if (pinned && !visible.includes(pinned)) visible[visible.length - 1] = pinned;
  const hidden = sessions.length - visible.length;
  return { sessions: visible, hidden, count: visible.length + Number(hidden > 0) };
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
  if (["pending", "running", "reserved"].includes(receipt.state ?? "")) return { ...submission, status: "pending" };
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
