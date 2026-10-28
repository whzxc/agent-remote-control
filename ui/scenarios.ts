import { installPetFixture } from "./pets/scenario";
import { srcConversationsScenario } from './scenarioSrcConversations';
import { installTopologyAccounts } from './topology/scenarioAccounts';
import { accountScenario } from "./scenarioAccounts";
import { beginScenario, finishScenario, missingScenarioRoute, scenarioReadiness } from "./state/scenarioReadiness";
import { updates, acceptUpdateSnapshot } from './state/updates';
import type { UpdateSnapshot } from './state/updateModel';
import { onboarding, connectionSetup, type SourceSetup, type ConnectionSetup } from './state/onboarding';
import { navigation, type Page } from './state/navigation';
import type { RelayProgress } from './state/relay';
import { connector } from './state/connector';
import { agents, type Agent } from './state/agents';
import { acceptActivity, resetActivityCore } from './state/activity';
import { tasks } from './state/tasks';
import { permissions } from './state/permissions';
import { subscriptions } from './state/subscriptions';
import { acceptPreferences } from './state/store';
import { openSnapshotPanel, settledViewModel, type PanelRequest } from './acceptance';
import type { AccountsResult, AgentActivitySnapshot, AgentActivitySession, AgentConversation, AgentInteraction, AgentTimeline, AgentTimelineEntry } from './types';
import type { Snapshot } from './subscriptions/types';
import { selectAgentPanel } from './state/overviewPanels';
import type { Status } from './state/types';
import config from '../native/src/ingress/config.json';
import { acceptTaskExecution, resetTaskExecutions } from './state/taskExecution';
import { taskScenario } from './scenarioTasks';
import type { RequestRouting } from './state/requestRouting';
import { taskPanelSnapshot } from './state/taskPanel';

type Fixture = { studio?: 'day' | 'night' | 'auto'; pets?: boolean; mascots?: boolean; historyRows?: number; metadataOnlyHistory?: boolean; maxVisibleAgents?: number; topologyAccounts?: boolean; reviewUnavailable?: boolean; dispatchHistory?: boolean; update?: UpdateSnapshot; updatePanel?: boolean; panelHistory?: boolean; quota?: boolean; quotaDisplay?: 'remaining' | 'used'; resetDisplay?: 'countdown' | 'time' } & { timeline?: 'multi-turn'; detailTask?: number; bubbles?: { density?: 'compact' | 'standard' | 'detailed'; width?: 'narrow' | 'medium' | 'wide'; autoCompact?: boolean }; theme: 'light' | 'dark'; language: 'en' | 'zh-CN'; agents: string[]; tasks: { agent: string; parent?: number; direct?: boolean; unconfirmed?: boolean; phase: AgentActivitySession['phase']; title: string; headline: string; approval?: boolean; question?: boolean; interaction?: AgentInteraction; completed?: boolean; outcome?: 'failed' | 'cancelled'; finalAnswer?: AgentTimelineEntry['text']; elapsedSeconds?: number; ownership?: AgentTimeline['ownership']; requestRouting?: RequestRouting['state'] }[]; panel?: PanelRequest; remoteLink?: { empty?: boolean; pending?: boolean; connected?: boolean; joined?: boolean; local?: boolean }; remoteSourceId?: string; sourceSetup?: SourceSetup; connectionSetup?: ConnectionSetup; page?: Page; connectionsOpen?: boolean; remoteConnectionId?: string; relayProgress?: RelayProgress };
const fixtures = import.meta.glob('../tooling/acceptance/scenarios/*.json', { import: 'default' });
let responses: Record<string, unknown> = {};
let conversations: Record<string, AgentConversation[]> = {};
let accountResponse: ReturnType<typeof accountScenario> | undefined;
let taskResponse: ReturnType<typeof taskScenario> | undefined;
let srcConversationResponse = srcConversationsScenario();
export function scenarioResponse(path: string, method: string, body?: unknown): unknown {
  try { return respondToScenario(path, method, body); }
  catch (error) {
    if (/SCENARIO_(ROUTE|ACTION|TIMELINE)_UNAVAILABLE/.test(String(error))) missingScenarioRoute(path, method);
    throw error;
  }
}
function respondToScenario(path: string, method: string, body?: unknown): unknown {
  if (path === 'app/env' && method === 'GET') {
    const now = Date.now();
    return { active: false, expiresAt: null, realNowMs: now, overrides: {}, clock: { value: { nowMs: now, speed: 1 }, source: 'system' } } satisfies import('./state/appEnvModel').EnvSample;
  }
  const srcResult = srcConversationResponse(path, method, body);
  if (srcResult !== undefined) return structuredClone(srcResult);
  const accountResult = accountResponse?.(path, method, body);
  if (accountResult !== undefined) return structuredClone(accountResult);
  if (path === 'pets' && method === 'GET') return responses.pets ?? { packages: [], errors: [] };
  if (path === 'pets/remove' && method === 'POST') {
    const library = responses.pets as { packages: import('./pets/model').PetPackage[]; errors: { key: string; error: string }[] };
    const key = (body as { key: string }).key, pet = library?.packages.find(p => p.key === key);
    if (!pet) throw new Error('INVALID_ARGUMENT: pet not installed; refresh pets');
    if (pet.origin !== 'arc') throw new Error('INVALID_ARGUMENT: Codex pets are read-only; remove them in their owning application');
    return responses.pets = { ...library, packages: library.packages.filter(p => p.key !== key) };
  }
  if (path === 'preferences' || path === 'preferences/import') return responses.preferences;
  if (path === 'updates/request' && method === 'POST') {
    const request = body as { action: string; seconds?: number }, snapshot = structuredClone(updates.get().snapshot);
    if (request.action === 'cancel') { snapshot.state = 'cancelled'; snapshot.canSchedule = false; }
    else if (request.action === 'now') { snapshot.when = 'now'; snapshot.state = 'swapping'; snapshot.canSchedule = false; }
    else if (request.action === 'defer') { snapshot.when = 'defer'; snapshot.state = 'settling'; snapshot.deferUntil = new Date(Date.now() + (request.seconds ?? 3600) * 1000).toISOString(); }
    else throw new Error('SCENARIO_ACTION_UNAVAILABLE: update submit');
    responses['updates/status'] = snapshot; acceptUpdateSnapshot(snapshot); return { accepted: true };
  }
  if (path === 'updates/install' && method === 'POST') {
    const snapshot = { ...updates.get().snapshot, id: 'fixture-submitted', state: 'settling' as const, when: (body as { when: UpdateSnapshot['when'] }).when, canSchedule: true, backupReady: true };
    responses['updates/status'] = snapshot; acceptUpdateSnapshot(snapshot); return { accepted: true };
  }
  if (path === 'updates/cancel' && method === 'POST') {
    const snapshot = { ...updates.get().snapshot, state: 'idle' as const };
    responses['updates/status'] = snapshot; acceptUpdateSnapshot(snapshot); return {};
  }
  if (path === 'updates/check' && method === 'POST') return {};

  if (path === 'agents/dispatch-catalog' && method === 'POST') return {
    authoritative: true, source: 'fixture', models: [{ model: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol' }, { model: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol' }],
  };
  if (path === 'agents/conversations/timeline' && method === 'POST') {
    const timeline = responses[`agents/timeline/${(body as { id: string }).id}`];
    if (timeline) return structuredClone(timeline);
    throw new Error('SCENARIO_TIMELINE_UNAVAILABLE');
  }
  if (path === 'agents/conversations' && method === 'POST') {
    const { agent, cursor, limit = 20 } = body as { agent: string; cursor?: string; limit?: number };
    const start = Number(cursor?.replace('fixture-page-', '') ?? 0);
    const rows = conversations[agent] ?? [], size = Math.max(1, Math.min(50, limit));
    return { data: structuredClone(rows.slice(start, start + size)), nextCursor: start + size < rows.length ? `fixture-page-${start + size}` : null,
      scope: agent === 'codex' ? 'native-unarchived' : 'arc-tasks' };
  }
  if (path === 'tasks/reviews' && responses.reviewUnavailable) throw new Error('SCENARIO_REVIEW_UNAVAILABLE');
  if (method === 'POST') {
    const result = taskResponse?.(path, body);
    if (result !== undefined) return structuredClone(result);
  }
  if (method !== 'GET') throw new Error(`SCENARIO_ACTION_UNAVAILABLE: ${path}`);
  if (path.startsWith('accounts/')) {
    const account = (responses.accounts as AccountsResult | undefined)?.accounts.find(account => account.id === decodeURIComponent(path.slice('accounts/'.length)));
    if (account) return structuredClone(account);
  }
  const route = path.split('?')[0];
  if (Object.hasOwn(responses, route)) return structuredClone(responses[route]);
  if (path.startsWith('tasks/runtime/')) {
    const id = path.slice('tasks/runtime/'.length);
    return { title: Object.values(conversations).flat().find(row => row.id === id)?.title,
      runtimeStatus: ['running','inProgress'].includes((responses[`agents/timeline/${id}`] as AgentTimeline)?.status ?? '') ? 'active' : 'idle', observedAt: new Date().toISOString() };
  }
  throw new Error(`SCENARIO_ROUTE_UNAVAILABLE: ${path}`);
}
export async function installScenario(name: string) {
  const load = fixtures[`../tooling/acceptance/scenarios/${name}.json`];
  if (!load) throw new Error(`Unknown acceptance scenario: ${name}`);
  const fixture = await load() as Fixture;
  beginScenario(name, fixture.detailTask === undefined ? undefined : `fixture-task-${fixture.detailTask}`);
  localStorage.setItem('arc-page', 'overview');
  const preferences = { 'arc.display.enabled': String(!!fixture.studio), 'arc.display.phase': fixture.studio ?? 'auto', 'update-outcome-seen': '', 'update-skipped-version': '', 'arc.privacy': 'true', theme: fixture.theme, language: fixture.language, 'arc.agent-order': JSON.stringify(fixture.agents), 'agents-max-visible': String(fixture.maxVisibleAgents ?? 4), 'quota-display': fixture.quotaDisplay ?? 'remaining', 'quota-reset-display': fixture.resetDisplay ?? 'countdown', 'task-bubble-density': fixture.bubbles?.density ?? 'standard', 'task-bubble-width': fixture.bubbles?.width ?? 'medium', 'task-bubble-auto-compact': fixture.bubbles?.autoCompact === false ? 'off' : 'on' };
  acceptPreferences(preferences);
  const now = new Date().toISOString();
  const defaults = Object.fromEntries(Object.entries(config.fields).map(([key, field]) => [key, field.default]));
  const status = {
    diagnostics: { findings: [] }, ingresses: [{ sources: [{ id: 'fixture-source', ingressId: 'fixture-source', credential: { type: 'local' }, product: 'claude', platform: 'anthropic', label: 'Claude', createdAt: now, connectedAt: 1, lastSeenAt: 1, state: 'connected' }], id: 'fixture-source', name: 'Claude', controlSource: 'claude', transport: 'local', state: 'ready', running: true, error: '', enabled: true, auth: 'local', toolPolicy: 'all', config: { ...defaults, configured: true }, url: '', oauth: { pending: [], grants: [] }, verification: { verifiedAt: now } }],
    ingressSummary: { running: 1, ready: 1, total: 1 }, taskApprovalEnabled: true, autoOpenCodex: true, notificationsEnabled: false,
    core: { backendSession: 'acceptance-fixture', version: 'fixture', desktop: { state: 'ready', supported: true, message: '' }, appServer: { state: 'ready', resources: {} }, account: { state: 'ready' }, resources: {}, activeTurns: fixture.tasks.filter(task => !task.completed && !task.outcome).length, activeWrites: 0, pendingInteractions: 0, logs: [] },
    deviceName: 'Acceptance', platform: 'darwin', version: 'fixture', connector: { state: 'ready' }, tunnel: { state: 'ready' }, config: defaults, logs: [],
  } as unknown as Status;
  if (fixture.remoteLink) {
    const base = status.ingresses[0];
    const remote = fixture.remoteLink;
    const source = { ...base.sources![0], id: 'source-personal', ingressId: 'relay-main', credential: { type: 'oauth-grant' as const, grantId: 'grant-personal' }, label: 'Claude · Personal' };
    const pendingSource = { ...source, id: 'source-new', label: 'Claude', credential: { type: 'oauth-grant' as const, grantId: 'request-new' }, connectedAt: remote.connected ? 1 : null, lastSeenAt: remote.connected ? 1 : null };
    status.ingresses = remote.empty ? [] : [
      { ...base, id: 'relay-main', transport: 'relay', auth: 'oauth', name: 'My relay', url: 'https://relay.example.com/mcp', sources: [source, ...(remote.pending || remote.connected ? [pendingSource] : [])],
        oauth: { grants: [{ id: 'grant-personal', clientName: 'Claude', clientId: 'client-personal', connectedAt: 1, registeredAt: 1 }], pending: remote.pending ? [{ id: 'request-new', sourceId: 'source-new', product: 'claude', clientName: 'Claude', redirectUri: 'https://claude.ai/api/mcp/auth_callback', resource: 'https://relay.example.com/mcp', pairingCode: '4F7K', status: 'pending' }] : [] } },
      { ...base, id: 'secure-tunnel', name: 'ChatGPT tunnel', transport: 'openai-tunnel', controlSource: 'chatgpt', auth: 'openai', url: '', sources: [] },
    ];
    if (remote.local) status.ingresses = [{ ...base, id: 'local-claude-code', name: 'Claude Code', sources: [{ ...base.sources![0], id: 'local-source', ingressId: 'local-claude-code', connectedAt: null, lastSeenAt: null }] }];
  }
  const sources = status.ingresses.flatMap(i => i.sources ?? []);
  const inventory: Agent[] = fixture.agents.map(agent => ({ agent, installed: true, available: true, enabled: true, status: 'ready', version: 'fixture' }));
  const activity: AgentActivitySnapshot = { observedAt: now, activeAgents: fixture.agents, agents: Object.fromEntries(fixture.agents.map(a => [a, { sessions: [] }])) };
  fixture.tasks.forEach((task, index) => {
    activity.agents[task.agent].sessions.push({ id: `fixture-task-${index}`, ...(task.parent === undefined ? {} : { parentSessionId: `fixture-task-${task.parent}` }), source: task.direct ? 'transcript' : task.agent === 'codex' ? 'codex-thread' : 'arc-task', title: task.title, headline: task.headline, phase: task.phase,
      turnId: `fixture-turn-${index}-${fixture.timeline ? 2 : 1}`, project: '/workspace/acceptance', phaseSince: now, turnStartedAt: new Date(Date.parse(now) - (task.elapsedSeconds ?? 83) * 1000).toISOString(), startedAt: now, timeline: true, recentSteps: ['thinking', 'command', 'file'],
      recentContent: ['Reviewed project files', task.headline],
      dispatchSummary: { ...(!task.direct ? { controlSource: { id: 'fixture-source', label: 'Claude', kind: 'claude' } } : {}), model: 'gpt-6.1-sol', effort: 'high', serviceTier: 'priority' },
      ...(task.approval ? { interaction: { kind: 'permission' as const, summary: 'Read README.md', command: 'cat README.md', canRespond: true, respond: { via: 'act' as const, op: 'codex_respond' as const, args: { id: `fixture-interaction-${index}`, backendSession: 'fixture' } } } } : {}),
      ...(task.question ? { interaction: { kind: 'question' as const, method: 'item/tool/requestUserInput', summary: 'Select a fixture option', questions: [{id:'choice',question:'Choose an option',options:[{label:'Alpha'},{label:'Beta'}]}], canRespond:true, respond:{op:'codex_respond' as const,args:{id:`fixture-interaction-${index}`,backendSession:'fixture'}} } } : {}),
      ...(task.interaction ? { interaction: task.interaction } : {}),
    });
  });
  const topologyAccounts = (fixture.topologyAccounts || name === 'topology-accounts') ? installTopologyAccounts(status, activity) : [];
  if (topologyAccounts.length) sources.splice(0, sources.length, ...status.ingresses.flatMap(i => i.sources ?? []));
  const timelines: Record<string, AgentTimeline> = {};
  fixture.tasks.forEach((task, taskIndex) => {
    const session = activity.agents[task.agent].sessions.find(session => session.id === `fixture-task-${taskIndex}`)!;
    const entries: AgentTimelineEntry[] = [];
    const summaries: NonNullable<AgentTimeline['turnDispatchSummaries']> = {};
    const turnStatuses: Record<string, string> = {};
    const count = fixture.timeline ? 2 : 1;
    for (let turnIndex = 1; turnIndex <= count; turnIndex++) {
      const turnId = `fixture-turn-${taskIndex}-${turnIndex}`;
      const outcome = turnIndex === count ? task.outcome : undefined;
      const live = !task.completed && !outcome && turnIndex === count;
      turnStatuses[turnId] = task.unconfirmed ? 'unknown' : outcome ?? (live ? 'running' : 'completed');
      const start = Date.parse(session.turnStartedAt!) - (count - turnIndex) * 180000;
      const rows: (Pick<AgentTimelineEntry, 'type' | 'status'> & Partial<AgentTimelineEntry>)[] = [
        { type: 'user', status: 'completed', text: turnIndex === 1 ? 'Review the project and check the configuration.\n\nKeep the existing behavior while making the requested changes.' : 'Apply the changes and run the project checks.' },
        { type: 'thinking', status: 'completed', text: 'I will read the current configuration and preserve its documented behavior.', durationMs: 3200 },
        { type: 'command', status: 'completed', command: 'cat package.json', cwd: '/workspace/acceptance', output: { state: 'available', text: '{ "scripts": { "check": "tsc --noEmit" } }', truncated: false, sha256: 'fixture', hashScope: 'excerpt' }, durationMs: 300, exitCode: 0 },
        { type: 'thinking', status: 'completed', text: 'The existing check command covers the changed TypeScript files.', durationMs: 2800 },
        { type: 'text', status: 'completed', text: 'The project configuration is ready. I am applying the change next.' },
        { type: 'file', status: 'completed', path: '/workspace/acceptance/config.json', operation: 'edit', changes: [{ path: '/workspace/acceptance/config.json', operation: 'edit' }], durationMs: 1400 },
        { type: 'tool', status: 'completed', title: 'Read project metadata', durationMs: 600 },
        { type: 'plan', status: 'completed', plan: [{ content: { state: 'available', text: 'Verify project changes', truncated: false, sha256: 'fixture', hashScope: 'excerpt' }, status: live ? 'in_progress' : 'completed' }] },
        (task.approval || task.question || task.interaction) && live
          ? { type: 'interaction', status: 'pending', interaction: session.interaction }
          : { type: 'command', status: outcome ?? (live ? 'running' : 'completed'), command: 'npm run check', cwd: '/workspace/acceptance', ...(live ? {} : { durationMs: 1700, ...(outcome === 'failed' ? { exitCode: 1 } : outcome ? {} : { exitCode: 0 }) }) },
      ];
      if (outcome === 'failed') rows.push({ type: 'error', status: 'failed', text: 'The sample verification command failed.' });
      if (!live && !outcome) rows.push({ type: 'text', status: 'completed', phase: 'final_answer', text: task.finalAnswer ?? 'The requested changes are complete.\n\n| Check | Result |\n| --- | --- |\n| Configuration | Updated |\n| TypeScript | Passed |\n\n- Preserved existing behavior.\n- Verified the changed files.' });
      for (const [index, row] of rows.entries()) {
        const at = new Date(start + index * 4000).toISOString();
        entries.push({ id: `${turnId}-entry-${index}`, turnId, cursor: entries.length + 1, position: entries.length,
          startedAt: at, updatedAt: at, ...(['completed', 'failed', 'cancelled'].includes(row.status) ? { endedAt: new Date(Date.parse(at) + (row.durationMs ?? 1000)).toISOString() } : {}), ...row });
      }
      summaries[turnId] = turnIndex === 1 && count > 1
        ? { controlSource: { kind: 'local-cli' }, model: 'gpt-5.6-sol', effort: 'medium' }
        : session.dispatchSummary!;
    }
    timelines[`agents/timeline/${session.id}`] = { sessionId: session.id, status: task.unconfirmed ? 'unknown' : task.outcome ?? (task.completed ? 'completed' : 'running'), entries,
      cursor: entries.length, executionEvidence: true, coverage: { state: 'complete', truncated: false },
      dispatchSummary: session.dispatchSummary, turnDispatchSummaries: summaries, turnStatuses, ownership: task.ownership };
  });
  conversations = Object.fromEntries(fixture.agents.map(agent => {
    const current = activity.agents[agent].sessions.map(session => ({ id: session.id, source: session.source as AgentConversation['source'], title: session.title,
      project: session.project, createdAt: session.startedAt ?? null }));
    const today = new Date(now); today.setHours(0, 0, 0, 0);
    const history: AgentConversation[] = fixture.panelHistory ? Array.from({ length: fixture.historyRows ?? 24 }, (_, index) => {
      const id = `fixture-history-${agent}-${index}`, title = `Review project change ${index + 1}`;
      const start = index < 3 ? Math.max(today.getTime(), Date.parse(now) - (index + 1) * 60000) : today.getTime() - (index - 2) * 86400000;
      const createdAt = new Date(start).toISOString(), endedAt = new Date(start + 83000).toISOString(), turnId = `${id}-turn`;
      if (!fixture.metadataOnlyHistory) timelines[`agents/timeline/${id}`] = { sessionId: id, status: 'completed', entries: [
        { id: `${id}-prompt`, turnId, type: 'user', status: 'completed', startedAt: createdAt, updatedAt: createdAt, text: title, cursor: 1, position: 0 },
        { id: `${id}-answer`, turnId, type: 'text', status: 'completed', phase: 'final_answer', startedAt: endedAt, updatedAt: endedAt, endedAt, text: 'The project changes have been reviewed.', cursor: 2, position: 1 },
      ], cursor: 2, executionEvidence: true, coverage: { state: 'complete', truncated: false }, turnStatuses: { [turnId]: 'completed' } };
      return { id, source: agent === 'codex' ? 'codex-thread' : 'arc-task', title, project: '/workspace/acceptance', createdAt,
        ...(fixture.metadataOnlyHistory ? { status: ['completed', 'failed', 'cancelled', null][index % 4] } : {}) };
    }) : [];
    return [agent, [...current, ...history]];
  }));
  const records = fixture.tasks.flatMap((task, index) => {
    if (task.direct) return [];
    const session = activity.agents[task.agent].sessions.find(s => s.id === `fixture-task-${index}`)!;
    return [{ agent: task.agent, turnId: session.turnId ?? undefined, requestId: `fixture-request-${index}`, threadId: `fixture-task-${index}`, state: task.approval ? 'awaiting-approval' : 'completed', createdAt: now, updatedAt: now,
    origin: { ingressId: 'fixture-source', sourceId: 'fixture-source', ...(topologyAccounts.length ? session.origin : {}) },
    ...(topologyAccounts.length ? { agentAccountId: session.agentAccountId } : {}), approval: { decision: 'automatic', source: 'remote', at: now }, task: { kind: 'create', title: task.title, prompt: task.headline, input: [], directory: '/workspace/acceptance', settings: {} } }];
  });
  if (fixture.dispatchHistory && records[0]) {
    records.push({ ...records[0], requestId: 'fixture-historical-dispatch', turnId: 'fixture-turn-0-1', createdAt: new Date(Date.parse(now) - 86400000).toISOString(),
      task: { ...records[0].task, title: 'Earlier completed dispatch' } });
    for (const [index, state] of ['awaiting-approval', 'reserved', 'not-executed', 'unconfirmed', 'failed'].entries()) {
      records.push({ ...records[0], requestId: `fixture-submission-${index}`, turnId: undefined, state,
        task: { ...records[0].task, title: `Submission ${state}` } });
    }
  }
  const routingByTask: Record<string, RequestRouting> = Object.fromEntries(fixture.tasks.flatMap((task, index) => task.requestRouting ? [[`fixture-task-${index}`, {
    state: task.requestRouting, deferUntil: task.requestRouting === 'deferred' ? Date.parse(now) + 15000 : null,
    pausedBy: task.requestRouting === 'paused' ? 'user' : null,
    reason: { deferred: 'user-present', paused: 'explicit-or-dock-interaction', routed: 'handoff-now', 'not-routable': 'no-source-binding' }[task.requestRouting],
  }]] : []));
  taskResponse = taskScenario(timelines, activity, records, () => {
    activity.observedAt = new Date().toISOString();
    const update = responses['updates/status'] as UpdateSnapshot | undefined;
    if (update) {
      const nextUpdate = structuredClone(update);
      const answered = nextUpdate.work.blocking.filter(item => item.taskId && item.question && !activity.agents[item.agent ?? 'codex']?.sessions.find(session => session.id === item.taskId)?.interaction);
      nextUpdate.work.blocking = nextUpdate.work.blocking.filter(item => !answered.includes(item));
      nextUpdate.work.willResume.push(...answered.map(item => ({ ...item, question: undefined })));
      responses['updates/status'] = nextUpdate; acceptUpdateSnapshot(nextUpdate);
    }
    const visible = { ...activity, agents: Object.fromEntries(Object.entries(activity.agents).map(([agent, group]) => [agent, {
      sessions: group.sessions.filter(session => ['running', 'inProgress'].includes(timelines[`agents/timeline/${session.id}`]?.status ?? '')),
    }])) };
    responses['agents/activity'] = visible;
    acceptActivity(structuredClone(visible));
  }, routingByTask);
  const permissionData = { items: [], observedAt: now };
  const subscriptionData: Snapshot = { instanceId: 'fixture', revision: 1, settings: { enabled: !!fixture.quota, refreshMinutes: 30, agentProviders: {} }, providers: fixture.quota ? [{
    providerId: 'codex', agentId: 'codex', agentIds: ['codex'], name: 'ChatGPT', eligible: true, state: 'ready', refreshing: false,
    observedAt: new Date(Date.parse(now) - 120000).toISOString(), blockedPoolIds: [], hasCredential: true, acceptsKey: false, displayWindowId: 'weekly',
    windows: [
      { id: 'five-hour', poolId: 'main', label: 'five_hour', usedPercent: 73, resetsAt: new Date(Date.parse(now) + 2 * 3600000).toISOString() },
      { id: 'weekly', poolId: 'main', label: 'weekly', usedPercent: 68, resetsAt: new Date(Date.parse(now) + 3 * 86400000).toISOString() },
    ],
  }] : [] };
  acceptPreferences({ 'arc.pets.show': 'false', 'arc.pets.assignments': '{}' });
  const initialActivity = { ...activity, agents: Object.fromEntries(Object.entries(activity.agents).map(([agent, group]) => [agent, {
    sessions: group.sessions.filter(session => { const task = fixture.tasks[Number(session.id.replace('fixture-task-', ''))]; return !task?.outcome && !task?.unconfirmed; }),
  }])) };
  responses = { reviewUnavailable: fixture.reviewUnavailable, ...timelines, status, source: { sources }, agents: { agents: inventory }, 'agents/activity': initialActivity, tasks: { records }, permissions: permissionData, subscriptions: subscriptionData, preferences, 'relay/list': { relays: fixture.remoteLink && !fixture.remoteLink.empty && !fixture.remoteLink.local ? [{ id: 'relay-host', ingressId: 'relay-main', name: 'My relay', url: 'https://relay.example.com', owner: !fixture.remoteLink.joined, workerVersion: 'fixture' }] : [], version: 'fixture' }, 'relay/progress': fixture.relayProgress ?? { phase: 'idle' }, 'codex/login': { state: 'authenticated' }, 'local-access/status': { codeAvailable: true, desktopAvailable: true } };
  if (fixture.pets) {
    responses.pets = installPetFixture(!!fixture.mascots);
    acceptPreferences({ 'arc.pets.show': 'true', 'arc.pets.assignments': JSON.stringify(fixture.mascots ? {} : {
      'source:fixture-source': 'fixture:claude-maiden',
      'agent:codex': 'fixture:gpt-dragon-girl--legeling',
      'agent:dsh': 'fixture:maid-deepseek-whale',
    }) });
  }
  responses['accounts'] = { accounts: topologyAccounts, login: null } satisfies AccountsResult;
  srcConversationResponse = srcConversationsScenario();
  accountResponse = ['accounts', 'source-panel'].includes(name) ? accountScenario(status, sources) : undefined;
  responses['updates/status'] = { state: 'idle', when: 'settled', work: { blocking: [], willResume: [], unaffected: [] } };
  responses['service'] = { supported: true, enabled: false };
  connector.set({ status, sources, sourcesLoaded: true, busy: '', loading: false, error: '', feedback: { text: '', error: false } });
  agents.set({ items: inventory, loaded: true, loading: false, saving: '', error: '' });
  if (status.core.backendSession) resetActivityCore(status.core.backendSession);
  resetTaskExecutions();
  acceptActivity(activity);
  acceptActivity(initialActivity);
  for (const [agent, data] of Object.entries(activity.agents)) for (const session of data.sessions) acceptTaskExecution(agent, session.id, timelines[`agents/timeline/${session.id}`]);
  tasks.set({ records, loading: false, error: '' });
  permissions.set({ data: permissionData, loading: false, error: '' });
  subscriptions.set({ snapshot: subscriptionData, error: '' });
  return async () => {
    if (fixture.tasks.some(task => task.completed)) {
      await settledViewModel();
      const finished = { ...activity, agents: Object.fromEntries(Object.entries(activity.agents).map(([agent, data]) => [agent, {
        sessions: data.sessions.filter(session => {
          const task = fixture.tasks[Number(session.id.replace('fixture-task-', ''))];
          return !task?.completed && !task?.outcome && !task?.unconfirmed;
        }),
      }])) };
      responses['agents/activity'] = finished;
      acceptActivity(finished);
      for (const [agent, data] of Object.entries(activity.agents)) for (const session of data.sessions) acceptTaskExecution(agent, session.id, timelines[`agents/timeline/${session.id}`]);
    }
    openSnapshotPanel(fixture.panel);
    if (fixture.detailTask !== undefined) {
      await settledViewModel();
      const task = fixture.tasks[fixture.detailTask];
      const session = activity.agents[task.agent].sessions.find(session => session.id === `fixture-task-${fixture.detailTask}`)!;
      selectAgentPanel({ type: 'task', agent: task.agent, session: { ...session, orderAt: Date.parse(session.startedAt!), observed: !task.completed && !task.outcome && !task.unconfirmed, ...(task.outcome || task.completed ? { status: task.outcome ?? "completed", endedAt: Date.parse(now) } : {}) } });
    }
    if (fixture.sourceSetup) onboarding.set(fixture.sourceSetup);
    if (fixture.connectionSetup) connectionSetup.set(fixture.connectionSetup);
    if (fixture.page) navigation.set({ page: fixture.page, connectionsOpen: fixture.connectionsOpen, remoteConnectionId: fixture.remoteConnectionId, remoteSourceId: fixture.remoteSourceId });
    if (fixture.update) {
      const snapshot = structuredClone(fixture.update);
      if (snapshot.state === 'countdown') snapshot.restartAt = new Date(Date.now() + 10000).toISOString();
      responses['updates/status'] = snapshot;
      acceptUpdateSnapshot(snapshot);
      updates.set(old => ({ ...old, panelOpen: fixture.updatePanel !== false }));
    }
    await settledViewModel();
    finishScenario();
    for (let frame = 0; frame < 120; frame++) {
      const state = scenarioReadiness(taskPanelSnapshot());
      if (state?.error) throw new Error(state.error);
      if (state?.ready) { document.documentElement.dataset.scenarioReady = name; return; }
      await new Promise(requestAnimationFrame);
    }
    throw new Error('Fixture task detail did not finish loading');
  };
}
