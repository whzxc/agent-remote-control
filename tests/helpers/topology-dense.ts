import { readFileSync } from 'node:fs';
import { installDenseTopologyAccounts } from '../../ui/topology/scenarioAccounts.ts';
import { accountNodeId, sourcePlatformNodeId } from '../../ui/topology/accounts.ts';
import { visibleAgents } from '../../ui/topology/visibleAgents.ts';
import { bubbleHeights, bubbleWidths } from '../../ui/state/activityModel.ts';
import type { ActivityEntity } from '../../ui/topology/compact.ts';
import type { AgentActivitySnapshot, AgentActivitySession } from '../../ui/types.ts';
import type { Status } from '../../ui/state/types.ts';

// Use the browser fixture's inventory, account installation and task attribution.
export function denseTopologyScene(maxVisibleAgents?: number) {
  const fixture = JSON.parse(readFileSync(new URL('../../tooling/acceptance/scenarios/topology-accounts-dense.json', import.meta.url), 'utf8'));
  const inventory = fixture.agents.map((agent: string) => ({ agent, installed: true, enabled: true }));
  const observedAt = '2026-01-01T00:00:00Z';
  const activity: AgentActivitySnapshot = { observedAt, activeAgents: fixture.agents,
    agents: Object.fromEntries(fixture.agents.map((agent: string) => [agent, { sessions: [] }])) };
  fixture.tasks.forEach((task: { agent: string; phase: AgentActivitySession['phase']; title: string; headline: string }, i: number) => {
    activity.agents[task.agent].sessions.push({ id: `fixture-task-${i}`, source: 'codex-thread', phase: task.phase, phaseSince: observedAt, title: task.title, headline: task.headline, timeline: true });
  });
  const status = { ingresses: [{ id: 'fixture-source', sources: [{ id: 'fixture-source', ingressId: 'fixture-source' }] }] } as unknown as Status;
  const accounts = installDenseTopologyAccounts(status, activity);
  const roots: ActivityEntity[] = inventory.map(({ agent }: { agent: string }) => {
    const linked = accounts.filter(a => a.agentProfiles.some(p => p.agent === agent));
    const tasks = activity.agents[agent].sessions.map(session => ({ id: session.id, agentAccountId: session.agentAccountId,
      width: bubbleWidths.medium, height: bubbleHeights.standard,
      state: fixture.tasks[Number(session.id.split('-').at(-1))].completed ? 'done' : 'running' }));
    return { id: agent, tasks: linked.length > 1 ? tasks.filter(t => !linked.some(a => a.id === t.agentAccountId)) : tasks,
      children: linked.length > 1 ? linked.map(account => ({ id: accountNodeId(agent, account.id),
        tasks: tasks.filter(t => t.agentAccountId === account.id) })) : [] };
  });
  const selected = new Set(visibleAgents(inventory, maxVisibleAgents ?? fixture.maxVisibleAgents).map(agent => agent.agent));
  const sourceRoots = ['anthropic', 'openai'].map(platform => ({ id: sourcePlatformNodeId(platform), tasks: [],
    children: status.ingresses[0].sources!.filter(s => (s.product === 'chatgpt' ? 'openai' : 'anthropic') === platform).map(s => ({ id: s.id, tasks: [] })) }));
  const scene = { vw: fixture.viewports[0].width, vh: fixture.viewports[0].height, left: sourceRoots, right: roots.filter(n => selected.has(n.id)) };
  return { fixture, roots, scene };
}
