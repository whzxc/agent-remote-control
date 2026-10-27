import { solve } from '../topology/solve';
import { dispatchSpecFixtures } from './dispatchFixtures';
import configSchema from '../../native/src/ingress/config.json';
import { installTopologyAccounts } from './topologyAccounts';
import { accountQuotaProvider } from '../subscriptions/accountQuota';
import type { Config, ControlSource, Ingress, Status } from '../state/types';
import type { Agent } from '../state/agents';
import type { AgentActivitySnapshot, AgentPhase } from '../types';
import type { TrackedActivity } from '../state/activityModel';
import type { ProviderSnapshot } from '../subscriptions/types';

const scene = {
  agents: ['claude', 'codex', 'dsh', 'opencode'],
  tasks: [
    { agent: 'claude', phase: 'thinking', title: 'Review navigation', headline: 'Checking the account routes' },
    { agent: 'claude', phase: 'command', title: 'Validate workspace', headline: 'Waiting for permission', approval: true },
    { agent: 'claude', phase: 'text', title: 'Update documentation', headline: 'Documentation updated', completed: true },
    { agent: 'codex', phase: 'command', title: 'Check configuration', headline: 'Running the configuration check' },
    { agent: 'dsh', phase: 'thinking', title: 'Review changes', headline: 'Reading the project changes' },
  ],
};
const now = Date.UTC(2026, 9, 26, 12);
const observedAt = new Date(now).toISOString();
const defaults = configSchema.fields;
const config: Config = {
  proxyMode: 'system', proxyUrl: defaults.proxyUrl.default, connectionMode: 'tunnel', httpsProvider: 'cloudflare',
  hasNgrokAuthtoken: false, ngrokMode: 'quick', ngrokEndpoint: defaults.ngrokEndpoint.default,
  pinggyMode: 'quick', hasPinggyToken: false, hasLocalxposeAccessToken: false, localxposeMode: 'named', localxposeRegion: 'us',
  cloudflareMode: 'quick', hasCloudflareToken: false, cloudflareAuth: 'token', cloudflareTunnelId: defaults.cloudflareTunnelId.default,
  httpsUrl: defaults.httpsUrl.default, httpsHost: defaults.httpsHost.default, httpsPort: defaults.httpsPort.default,
  configured: true, tunnelId: defaults.tunnelId.default, tunnelBinary: defaults.tunnelBinary.default,
  codexBinary: defaults.codexBinary.default, autoStart: defaults.autoStart.default, hasApiKey: false,
};
const source: ControlSource = { id: 'fixture-source', ingressId: 'fixture-connection', product: 'claude', platform: 'anthropic',
  label: 'Claude', credential: { type: 'local' }, createdAt: observedAt, connectedAt: now / 1000, lastSeenAt: now / 1000, state: 'connected' };
const ingresses: Ingress[] = [{ id: source.ingressId, name: 'Design connection', controlSource: 'claude', transport: 'local',
  state: 'ready', running: true, error: '', enabled: true, auth: 'local', toolPolicy: 'all', config,
  url: 'https://arc.example.com/mcp', sources: [source], oauth: { pending: [], grants: [] } }];
const agents: Agent[] = scene.agents.map(agent => ({ agent, installed: true, available: true, enabled: true, status: 'ready', version: 'fixture' }));
const activitySessions: (TrackedActivity & { agent: string })[] = scene.tasks.map((task, index) => ({
  agent: task.agent, id: `fixture-task-${index}`, source: task.agent === 'codex' ? 'codex-thread' : 'arc-task',
  title: task.title, headline: task.headline, phase: task.phase as AgentPhase, phaseSince: observedAt,
  orderAt: now - index * 1000, startedAt: observedAt, turnStartedAt: new Date(now - 83000).toISOString(),
  turnId: `fixture-turn-${index}`, project: '/workspace/example', timeline: true, recentSteps: ['thinking', 'command', 'file'],
  recentContent: ['Reviewed project files', task.headline],
  dispatchSummary: { model: 'gpt-6.1-sol', effort: 'high', serviceTier: 'priority' },
  ...(task.completed ? { endedAt: now, status: 'completed' } : {}),
  ...(task.approval ? { interaction: { kind: 'permission' as const, summary: 'Read README.md', command: 'cat README.md', canRespond: false, respond: { hint: 'Synthetic design record; no native response.' } } } : {}),
}));
const activity: AgentActivitySnapshot = { observedAt, activeAgents: scene.agents,
  agents: Object.fromEntries(scene.agents.map(agent => [agent, { sessions: activitySessions.filter(session => session.agent === agent) }])) };
// Populate design-only account records and their source/activity associations.
const accounts = installTopologyAccounts({ ingresses } as Status, activity);
accounts[0].email = 'alex@example.com';
for (const ingress of ingresses) for (const source of ingress.sources ?? []) {
  source.platform = accounts.find(account => account.sources.includes(source.id))!.provider;
}
const quotaSnapshots: ProviderSnapshot[] = accounts.filter(account => account.quota.windows.length).map(account => ({
  ...accountQuotaProvider('claude', account.quota), providerId: account.id, name: 'Claude', plan: 'Max',
  creditBalance: 120, availableResetCount: 2, resetCredits: [{ count: 2, expiresAt: new Date(now + 86400000 * 7).toISOString() }],
}));
const ready = quotaSnapshots[0];
const quotaStates = {
  ready,
  stale: { ...ready, state: 'stale', observedAt: new Date(now - 7200000).toISOString() },
  refreshing: { ...ready, refreshing: true },
  unavailable: { ...ready, state: 'unavailable', windows: [], error: { code: 'unavailable', message: 'Synthetic provider unavailable' } },
  blocked: { ...ready, accountBlocked: true, blockedPoolIds: ['main'] },
  exhausted: { ...ready, windows: ready.windows.map(window => ({ ...window, usedPercent: 100, exhausted: true })) },
  unknownReset: { ...ready, windows: ready.windows.map(({ resetsAt: _reset, ...window }) => window) },
  expiredCredit: { ...ready, resetCredits: [{ count: 2, expiresAt: new Date(now - 86400000).toISOString() }] },
  empty: { ...ready, windows: [] },
} satisfies Record<string, ProviderSnapshot>;
const tunnelFrames = Object.fromEntries((['landscape', 'portrait'] as const).map(orientation => [orientation, {
  layout: solve({ width: 720, height: 400, orientation, now, candidates: [], sessions: [{ agent: 'codex', session: activitySessions[0] }] }),
}]));
export const baseFixtures = {
  tunnelFrames,
  dispatchSpecs: dispatchSpecFixtures,
  now, accounts, agents, sources: ingresses.flatMap(ingress => ingress.sources ?? []), ingresses,
  quotaSnapshots, quotaStates, activitySessions, activity,
  choices: [{ value: 'claude', label: 'Claude' }, { value: 'codex', label: 'Codex' }],
  labels: { button: 'Refresh', notice: 'Synthetic provider unavailable', empty: 'No activity', loading: 'Loading', status: 'Connected', tag: 'Claude' },
};
