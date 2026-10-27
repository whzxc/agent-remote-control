export interface NofileLimits {
  state: "available" | "unknown" | "not_applicable";
  soft: number | "unlimited" | null;
  hard: number | "unlimited" | null;
  source: "self-measured" | "inherited-at-spawn" | "child-measured" | "unavailable";
  observedAt: string | null;
  error: string | null;
  measurementError?: string;
}
export interface ResourceSnapshot {
  state: "ok" | "degraded" | "pressure" | "unknown" | "not_applicable";
  nofile: NofileLimits;
  startup?: {
    targetSoft: number;
    original: NofileLimits;
    actual: NofileLimits;
    attemptedSoft: number | null;
    platformCeiling: number | null;
    state: string;
    reasons: string[];
    observedAt: string;
  };
  fd?: { state: string; count: number | null; sampledAt: string | null; attemptedAt: string | null; error: string | null };
  usageRatio?: number | null;
  warningRatio?: number;
}
export interface CoreSnapshot {
  chatgpt?: { code: string; verifiedAt: string | null; challengeVerifiedAt?: string | null };
  desktop?: { supported: boolean; state: string; message: string };
  eventStorageError?: string | null;
  version: string;
  pid: number;
  package: { sha: string; version: string };
  backendSession: string;
  activeTurns: number;
  activeWrites: number;
  pendingInteractions: number;
  liveProcesses: number;
  uncertain: boolean;
  draining: boolean;
  resources: ResourceSnapshot;
  appServer: {
    state: string;
    pid: number | null;
    startedAt: string | null;
    resources: ResourceSnapshot;
    observedAt: string | null;
    evidence: string;
    stale: boolean;
    error?: { code: string; stage: string };
  };
  account: { state: string; observedAt: string | null };
  transport?: { state: string; error?: string };
  logs?: string[];
  lastInbound: string | null;
  toolCount: number;
  registered: boolean;
  schemaDiscovered: string;
  operationVerified: string;
}

export type AgentPhase = "thinking" | "command" | "file" | "tool" | "text" | "interaction" | "idle";
export interface DispatchSummary {
  controlSource?: { id?: string; accountId?: string; label?: string; kind?: string };
  agentAccountId?: string;
  model?: string;
  effort?: string;
  serviceTier?: string;
}
export interface AgentInteraction {
  kind: "permission" | "question";
  summary: string;
  respond: { via?: "act"; op?: "agent_respond" | "codex_respond"; args?: Record<string, unknown>; hint?: string };
  command?: string | null;
  path?: string | null;
  title?: string | null;
  options?: unknown;
  canRespond?: boolean;
  method?: string;
  reason?: string;
  cwd?: string;
  preview?: string;
  questions?: { id: string; question: string; isOther?: boolean; isSecret?: boolean; multiSelect?: boolean; options?: { label: string; description?: string }[] }[];
}
export interface AgentActivitySession {
  turnCount?: number;
  projectName?: string | null;
  dispatchSummary?: DispatchSummary;
  origin?: { ingressId?: string; sourceId?: string; accountId?: string; controlSource?: string };
  agentAccountId?: string | null;
  id: string;
  source: "arc-task" | "codex-thread" | "transcript";
  turnId?: string | null;
  nativeSessionId?: string;
  title?: string;
  project?: string | null;
  phase: AgentPhase;
  headline: string;
  fallbackHeadline?: string;
  recentContent?: string[];
  recentSteps?: Exclude<AgentPhase, "idle">[];
  startedAt?: string | null;
  turnStartedAt?: string | null;
  phaseSince: string | null;
  interaction?: AgentInteraction;
  timeline: boolean;
  open?: { taskId: string };
}
export interface AgentActivitySnapshot {
  observedAt: string;
  activeAgents: string[];
  agents: Record<string, { sessions: AgentActivitySession[] }>;
}
export interface AgentConversation {
  agentAccountId?: string | null;
  dispatchSummary?: DispatchSummary | null;
  turnCount?: number | null;
  projectName?: string | null;
  id: string;
  source: "arc-task" | "codex-thread" | "native";
  status?: string | null;
  title?: string | null;
  project?: string | null;
  createdAt: string | null;
  nativeSessionId?: string | null;
  open?: AgentActivitySession["open"];
}
export interface AgentConversationPage {
  data: AgentConversation[];
  nextCursor: string | null;
  scope: "native-unarchived" | "arc-tasks";
}
export interface AgentTimelineEntry {
  inputOrigin?: "human";
  response?: { skipped?: boolean; result?: { answer?: string; answers?: Record<string, { answers: string[] }>; decision?: string }; error?: unknown; origin: { controlSource?: string; sourceLabel?: string; sourceId?: string }; resolvedAt: string };
  controlSource?: DispatchSummary["controlSource"];
  phase?: string;
  id: string;
  type: "user" | "text" | "thinking" | "command" | "file" | "tool" | "plan" | "interaction" | "error" | "notice";
  status: "pending" | "running" | "completed" | "failed" | "cancelled" | "unknown";
  startedAt: string | null;
  updatedAt: string;
  position?: number;
  durationMs?: number;
  endedAt?: string | null;
  cursor: number;
  turnId: string;
  text?: string;
  title?: string;
  command?: string;
  cwd?: string;
  paths?: string[];
  edits?: { oldText?: AgentTrackingExcerpt; newText?: AgentTrackingExcerpt }[];
  notice?: ({ kind: "retry" | "compaction"; stage: "start" | "end" } | { kind: "warning"; stage: "message" }) & { title?: string; message?: string; severity?: string; nativeStatus?: string; attempt?: number; maxAttempts?: number; trigger?: string; tokensBefore?: number; tokensAfter?: number; success?: boolean; aborted?: boolean };
  summary?: AgentTrackingExcerpt;
  error?: AgentTrackingExcerpt;
  path?: string | null;
  operation?: "read" | "write" | "edit" | "create" | "delete";
  commandActions?: { type: string; path?: string }[];
  exitCode?: number;
  exitCodeSource?: "rawOutput" | "output";
  input?: AgentTrackingExcerpt;
  output?: AgentTrackingExcerpt;
  plan?: { content: AgentTrackingExcerpt; status: string; priority?: string | null }[];
  changes?: { path: string; operation?: "create" | "edit" | "delete" | null; added?: number; removed?: number; diff?: AgentTrackingExcerpt }[];
  interaction?: AgentInteraction;
  truncated?: boolean;
}
export interface AgentTrackingExcerpt {
  state: "available";
  text: string;
  truncated: boolean;
  sha256: string;
  hashScope: "excerpt";
}
export interface TurnTiming {
  startedAt?: string | null;
  endedAt?: string | null;
}
export interface TaskOwnership {
  owner?: string;
  currentOwner?: string;
  state?: string;
  observedAt?: string;
  history?: { eventId: string; from: string; to: string; observedAt: string }[];
}

export interface AgentTimeline {
  srcConversation?: import("./srcConversations").SrcConversationRef | null;
  ownership?: TaskOwnership;
  turnTimings?: Record<string, TurnTiming>;
  projectName?: string | null;
  dispatchSummary?: DispatchSummary;
  turnDispatchSummaries?: Record<string, DispatchSummary>;
  turnStatuses?: Record<string, string>;
  readOnly?: boolean;
  status?: string;
  sessionId: string;
  entries: AgentTimelineEntry[];
  cursor: number;
  coverage: { state: "complete" | "partial"; truncated: boolean; reason?: string; omittedSidechainRecords?: number };
  executionEvidence: boolean | "partial";
}

export interface AccountAgentProfile {
  agent: string;
  profileId: string;
  kind: "cli-profile" | "codex-home" | "api-key";
  state: "signed-in" | "signed-out" | "unfinished" | "invalid";
  default: boolean;
}
export interface AccountNotifications {
  reachable?: boolean;
  state: "verified" | "not-bound" | "mcp-events" | "n/a" | "removed";
  sessions: Array<{
    sourceId?: string;
    accountId?: string | null;
    channel?: string;
    target: string;
    state: string;
    registered?: boolean;
    verified?: boolean;
    lastDelivery?: { at: number; status: string } | null;
    lastVerificationDelivery?: string;
  }>;
}
export interface SourceIdentityResolution {
  state: "unresolved" | "resolved" | "conflict";
  accountId?: string;
  code?: "ACCOUNT_IDENTITY_CONFLICT";
  reason?: string;
  authorization?: { kind: "authorization"; identityKey: string; observedAt: string };
  evidence?: { kind: "claude-session-handshake"; sourceId: string; target: string; profileId: string; accountId: string; identityKey: string; confirmedAt: string };
  previousEvidence?: SourceIdentityResolution["evidence"];
  confirmation?: { kind: "user-confirmed-merge"; confirmedAt: string };
}
export interface ProviderAccount {
  id: string;
  provider: string;
  identityKey: string;
  alias: string;
  email?: string | null;
  orgName?: string | null;
  plan?: string | null;
  createdAt: string;
  observedAt: string;
  sources: string[];
  sourceIdentities?: Record<string, SourceIdentityResolution>;
  agentProfiles: AccountAgentProfile[];
  notifications: AccountNotifications;
  quota: {
    state: string;
    windows: Array<{ id: string; poolId: string; label: string; usedPercent: number; resetsAt?: string; exhausted?: boolean }>;
    observedAt?: string;
    error?: unknown;
    accountBlocked?: boolean | null;
    blockedPoolIds?: string[];
  };
  health: { state: "ready" | "attention" | "removed" };
  removedAt?: string;
  mergedInto?: string;
  mergedAccountIds?: string[];
  quotaProviderId?: string | null;
  displayName?: string;
}
export interface AccountLogin {
  loginId: string;
  kind: "claude" | "codex" | "api-key" | "detect";
  state: string;
  accountId?: string;
  loginUrl?: string | null;
  browserId?: string;
  browserError?: string | null;
  error?: string | null;
  errors?: string[];
  next?: { message: string };
}
export interface AccountsResult { accounts: ProviderAccount[]; login: AccountLogin | null }
export type AccountIdentity = { sourceId: string; platform: string } & (
  (Pick<ProviderAccount, "id" | "alias" | "provider" | "email" | "orgName" | "plan" | "agentProfiles" | "notifications"> & { identityResolution: SourceIdentityResolution })
  | { id: null; authority: "local"; identityResolution: { state: "not-applicable" }; agentProfiles: []; notifications: { state: "n/a"; sessions: [] } }
);
