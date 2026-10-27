import type { AgentConversation } from '../types.ts';
import type { TrackedActivity } from '../state/activityModel.ts';
import type { Orientation } from './orientation.ts';

export const PANEL_MIN_WIDTH = 400;
export const LINGER_MS = 180_000;
export interface Candidate {
  id: string; side: 'cloud' | 'local'; label: string; agent?: string; accountId?: string; sourceIds: string[];
}
export interface Session { agent: string; session: TrackedActivity }
export interface ArenaNode {
  id: string; candidateId?: string; agent?: string; session?: TrackedActivity; conversation?: AgentConversation; label: string;
  kind: 'executor' | 'agent' | 'remote' | 'unattributed' | 'floating'; depth: number;
  x: number; y: number; width: number; height: number;
}
export interface ArenaEdge { id: string; from: string; to: string; throughRing: boolean; state: 'running' | 'waiting' | 'ended' }
export interface ArenaLoop {
  id: string; color: number; nodes: ArenaNode[]; edges: ArenaEdge[]; depth: number;
  lingering: boolean; lastActivity: number; expiresAt: number | null;
}
export interface ArenaLayout {
  orientation: Orientation; width: number; height: number; candidateHeight: number;
  candidates: (Candidate & { x: number; y: number; colors: number[]; unread: boolean })[];
  ring: { x: number; y: number; radius: number }; loops: ArenaLoop[]; floating: ArenaNode[];
}
export const conversationKey = (agent: string, id: string) => JSON.stringify(['conversation', agent, id]);
const time = (value?: string | null) => Number.isFinite(Date.parse(value ?? '')) ? Date.parse(value!) : 0;

// Pure graph, lifecycle and geometry projection. No viewport reads or storage access.
export function solve({ sessions, candidates, width, height, orientation, now, conversations = [], colors = {}, nodeWidth = 264, nodeHeight = 76 }: {
  sessions: Session[]; conversations?: { agent: string; conversation: AgentConversation }[]; candidates: Candidate[]; width: number; height: number; orientation: Orientation; now: number;
  colors?: Record<string, number>; nodeWidth?: number; nodeHeight?: number;
}): ArenaLayout {
  width = Math.max(1, width); height = Math.max(1, height);
  const vertical = orientation === 'portrait';
  const local = candidates.filter(c => c.side === 'local'), cloud = candidates.filter(c => c.side === 'cloud');
  const twoRows = width < (candidates.length + 1) * 68;
  const capacity = Math.max(1, Math.floor((width - 24) / 60));
  const cloudRows = Math.max(1, Math.ceil(cloud.length / capacity));
  const localRows = Math.max(1, Math.ceil(local.length / capacity));
  const positionCandidates = (rows: Candidate[], right: boolean) => rows.map((c, i) => {
    const row = twoRows ? Math.floor(i / capacity) : 0;
    const count = twoRows ? Math.min(capacity, rows.length - row * capacity) : rows.length;
    const gap = Math.min(76, (width - 24) / Math.max(1, twoRows ? count : candidates.length + 1));
    const slot = twoRows ? i % capacity : i;
    return { ...c, x: right ? width - 12 - gap * (count - slot - .5) : 12 + gap * (slot + .5),
      y: 36 + (right && twoRows ? cloudRows + row : row) * 76, colors: [] as number[], unread: false };
  });
  const placedCandidates = [...positionCandidates(cloud, false), ...positionCandidates(local, true)];
  const candidateHeight = twoRows ? (cloudRows + localRows) * 76 + 20 : 96;
  height = Math.max(1, height - candidateHeight);
  const nodes = new Map<string, ArenaNode>(), edges = new Map<string, ArenaEdge>();
  const findAgent = (agent: string, s?: Pick<TrackedActivity, 'agentAccountId' | 'dispatchSummary'>) => placedCandidates.find(c => c.agent === agent && !!s?.agentAccountId && c.accountId === s.agentAccountId)
    ?? placedCandidates.find(c => c.agent === agent && !!s?.dispatchSummary?.agentAccountId && c.accountId === s.dispatchSummary.agentAccountId)
    ?? placedCandidates.find(c => c.agent === agent && !c.accountId);
  const ordered = [...sessions].sort((a, b) => a.session.orderAt - b.session.orderAt || a.agent.localeCompare(b.agent) || a.session.id.localeCompare(b.session.id));
  // Native conversation identity unifies a dispatcher with its own executor bubble.
  for (const { agent, session } of ordered) {
    const id = conversationKey(agent, session.nativeSessionId ?? session.id), candidate = findAgent(agent, session);
    nodes.set(id, { id, candidateId: candidate?.id, agent, session, label: session.title || session.headline || agent,
      kind: session.dispatchSummary ? 'executor' : 'floating', depth: 0, x: 0, y: 0, width: nodeWidth, height: nodeHeight });
    if (candidate && session.endedAt !== undefined && session.readAt === undefined) candidate.unread = true;
  }
  for (const { agent, session } of ordered) {
    const summary = session.dispatchSummary;
    if (!summary) continue;
    const to = conversationKey(agent, session.nativeSessionId ?? session.id);
    let from: string;
    if (summary.caller) {
      const caller = summary.caller;
      from = conversationKey(caller.agent, caller.conversationId);
      const conversation = conversations.find(row => row.agent === caller.agent && (row.conversation.nativeSessionId === caller.conversationId || row.conversation.id === caller.conversationId))?.conversation;
      if (!nodes.has(from)) nodes.set(from, { id: from, candidateId: findAgent(caller.agent, conversation ? { ...conversation, dispatchSummary: conversation.dispatchSummary ?? undefined } : undefined)?.id, agent: caller.agent, conversation,
        label: conversation?.title || caller.agent, kind: 'agent', depth: 0, x: 0, y: 0, width: nodeWidth, height: nodeHeight });
      else if (nodes.get(from)!.kind === 'floating') nodes.get(from)!.kind = 'agent';
    } else {
      const source = summary.controlSource;
      const candidate = placedCandidates.find(c => !!source?.accountId && c.accountId === source.accountId && c.sourceIds.length)
        ?? placedCandidates.find(c => !!source?.id && c.sourceIds.includes(source.id));
      const remote = candidate?.side === 'cloud' || !!source?.kind && !['local', 'local-cli', 'local-ui', 'stdio', 'ARC'].includes(source.kind);
      from = JSON.stringify(['dispatcher', source?.id ?? source?.accountId ?? source?.kind ?? 'ARC']);
      if (!nodes.has(from)) nodes.set(from, { id: from, candidateId: candidate?.id, label: candidate?.label ?? source?.label ?? source?.kind ?? 'ARC',
        kind: remote ? 'remote' : 'unattributed', depth: 0, x: 0, y: 0, width: nodeWidth, height: nodeHeight });
    }
    if (from === to) continue;
    const id = JSON.stringify([from, to]);
    edges.set(id, { id, from, to, throughRing: false, state: session.endedAt !== undefined ? 'ended' : session.interaction ? 'waiting' : 'running' });
  }
  const adjacent = new Map<string, Set<string>>();
  for (const e of edges.values()) {
    for (const [a, b] of [[e.from, e.to], [e.to, e.from]]) {
      if (!adjacent.has(a)) adjacent.set(a, new Set());
      adjacent.get(a)!.add(b);
    }
  }
  const visited = new Set<string>(), loops: ArenaLoop[] = [];
  for (const id of adjacent.keys()) {
    if (visited.has(id)) continue;
    const component: string[] = [], queue = [id];
    for (let i = 0; i < queue.length; i++) {
      const key = queue[i]; if (visited.has(key)) continue;
      visited.add(key); component.push(key); queue.push(...adjacent.get(key) ?? []);
    }
    const members = component.map(key => nodes.get(key)!), links = [...edges.values()].filter(e => component.includes(e.from));
    const incoming = new Map(members.map(n => [n.id, links.filter(e => e.to === n.id).length]));
    const roots = members.filter(n => incoming.get(n.id) === 0);
    // Native dispatch graphs are acyclic. A malformed cycle is bounded and remains visible.
    const pending = roots.length ? [...roots] : [members[0]], assigned = new Set<string>();
    for (let i = 0; i < pending.length; i++) {
      const node = pending[i]; if (assigned.has(node.id)) continue;
      assigned.add(node.id);
      for (const e of links.filter(e => e.from === node.id)) {
        incoming.set(e.to, incoming.get(e.to)! - 1);
        const child = nodes.get(e.to)!;
        if (!assigned.has(child.id)) { child.depth = Math.max(child.depth, node.depth + 1); if (incoming.get(child.id)! <= 0) pending.push(child); }
      }
    }
    const executors = members.filter(n => n.kind === 'executor' && n.session);
    const lingering = executors.every(n => n.session!.endedAt !== undefined);
    const lastActivity = Math.max(0, ...executors.map(n => n.session!.endedAt ?? Math.max(n.session!.orderAt, time(n.session!.phaseSince), time(n.session!.turnStartedAt))));
    const lastDispatch = Math.max(0, ...executors.map(n => Math.max(n.session!.orderAt, time(n.session!.turnStartedAt))));
    const read = executors.some(n => n.session!.endedAt !== undefined && (n.session!.readAt ?? -1) >= lastDispatch);
    if (read || lingering && now >= lastActivity + LINGER_MS) continue;
    const root = (roots.length ? roots : members).map(n => n.id).sort()[0];
    const used = new Set(loops.map(l => l.color));
    const color = colors[root] ?? members.map(n => colors[n.id]).find(c => c !== undefined) ?? Array.from({ length: 8 }, (_, i) => i).find(c => !used.has(c)) ?? loops.length % 8;
    // A completed intermediate executor still carries light to its active descendants.
    for (const edge of [...links].sort((a, b) => nodes.get(b.from)!.depth - nodes.get(a.from)!.depth)) {
      if (edge.state === 'ended') {
        const downstream = links.filter(next => next.from === edge.to);
        if (downstream.some(next => next.state === 'waiting')) edge.state = 'waiting';
        else if (downstream.some(next => next.state === 'running')) edge.state = 'running';
      }
      edge.throughRing = nodes.get(edge.from)!.depth === 0;
    }
    loops.push({ id: root, color: color % 8, nodes: members, edges: links, depth: Math.max(...members.map(n => n.depth)), lingering, lastActivity, expiresAt: lingering ? lastActivity + LINGER_MS : null });
    for (const n of members) {
      const candidate = placedCandidates.find(c => c.id === n.candidateId);
      if (candidate && !candidate.colors.includes(color % 8)) candidate.colors.push(color % 8);
    }
  }
  const floating = [...nodes.values()].filter(n => n.kind === 'floating' && !visited.has(n.id) && n.session?.endedAt === undefined);
  const floatRows = new Map<string, number>();
  let floatBottom = 0;
  for (const node of floating) {
    const candidate = placedCandidates.find(c => c.id === node.candidateId);
    const bucket = candidate?.id ?? node.agent ?? '', row = floatRows.get(bucket) ?? 0;
    floatRows.set(bucket, row + 1);
    node.width = Math.min(200, width - 16); node.height = 44;
    node.x = Math.max(8, Math.min(width - node.width - 8, (candidate?.x ?? width / 2) - node.width / 2));
    node.y = row * 52 + 8;
    floatBottom = Math.max(floatBottom, node.y + node.height + 16);
  }
  const top = floatBottom + 24, margin = vertical ? 12 : 24, depth = Math.max(1, ...loops.map(l => l.depth));
  const bandGap = vertical ? 12 : 24;
  const bandSizes = loops.map(l => Math.max(1, ...Array.from({ length: l.depth + 1 }, (_, d) => l.nodes.filter(n => n.depth === d).length)));
  const crossCount = Math.max(1, bandSizes.reduce((a, b) => a + b, 0));
  const availableFlow = vertical ? height - top - margin : width - margin * 2;
  const radius = 46 + Math.min(loops.length, 4) * 4;
  const nw = vertical ? Math.max(56, Math.min(nodeWidth, (width - margin * 2 - Math.max(0, loops.length - 1) * bandGap) / crossCount - 8))
    : Math.max(176, Math.min(nodeWidth, (availableFlow - radius * 2 - 64 - (depth - 1) * 28) / (depth + 1)));
  const flowSize = vertical ? nodeHeight : nw, crossSize = vertical ? nw : nodeHeight;
  const firstHop = flowSize + radius * 2 + 64, laterHop = flowSize + 32;
  const minFlow = margin * 2 + flowSize + firstHop + (depth - 1) * laterHop;
  const extent = Math.max(availableFlow, minFlow);
  const spare = Math.max(0, availableFlow - minFlow);
  const start = margin + flowSize / 2 + spare / 2;
  const flowOf = (d: number) => start + (d ? firstHop + (d - 1) * laterHop : 0);
  const crossGap = vertical ? 8 : 16;
  const totalCross = crossCount * (crossSize + crossGap) + Math.max(0, loops.length - 1) * bandGap;
  const crossExtent = Math.max(vertical ? width : height - top, totalCross + margin * 2);
  const crossMid = crossExtent / 2;
  const ringFlow = start + firstHop / 2;
  const ring = vertical ? { x: crossMid, y: top + ringFlow, radius } : { x: ringFlow, y: top + crossMid, radius };
  let cross = crossMid - totalCross / 2;
  loops.forEach((loop, li) => {
    const unit = crossSize + crossGap, band = bandSizes[li] * unit;
    for (let d = 0; d <= loop.depth; d++) {
      const column = loop.nodes.filter(n => n.depth === d);
      column.forEach((node, i) => {
        const c = cross + band / 2 + (i - (column.length - 1) / 2) * unit, f = flowOf(d);
        node.width = nw; node.height = nodeHeight;
        node.x = vertical ? c - nw / 2 : f - nw / 2;
        node.y = vertical ? top + f - nodeHeight / 2 : top + c - nodeHeight / 2;
      });
    }
    cross += band + bandGap;
  });
  return { orientation, candidateHeight, candidates: placedCandidates, ring, loops, floating,
    width: vertical ? crossExtent : extent, height: vertical ? top + extent : top + crossExtent };
}
