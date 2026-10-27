import type { AgentConversation, DispatchSummary } from '../types.ts';
import type { TrackedActivity } from '../state/activityModel.ts';
import type { Orientation } from './orientation.ts';

export const PANEL_MIN_WIDTH = 400;
export const LINGER_MS = 180_000;
export const MIN_BUBBLE_WIDTH = 232;
export const isArcDispatch = (summary?: DispatchSummary): summary is DispatchSummary => !!(summary?.controlSource || summary?.caller);
export interface Candidate {
  id: string; side: 'cloud' | 'local'; label: string; agent?: string; accountId?: string; sourceIds: string[];
  platform?: string; platformLabel?: string; accountLabel?: string; accessibleLabel?: string;
}
export interface Session { agent: string; session: TrackedActivity }
export interface ArenaNode {
  id: string; candidateId?: string; agent?: string; session?: TrackedActivity; conversation?: AgentConversation; label: string;
  source?: DispatchSummary["controlSource"];
  kind: 'executor' | 'agent' | 'remote' | 'unattributed' | 'floating'; depth: number;
  x: number; y: number; width: number; height: number;
}
export interface ArenaEdge { id: string; from: string; to: string; throughRing: boolean; state: 'running' | 'waiting' | 'ended' }
export interface ArenaLoop {
  id: string; color: number; nodes: ArenaNode[]; edges: ArenaEdge[]; depth: number;
  lingering: boolean; lastActivity: number; expiresAt: number | null;
}
export interface CandidateRow { side: 'cloud' | 'local'; y: number; height: number; width: number }
export interface ArenaLayout {
  orientation: Orientation; width: number; height: number; candidateHeight: number; candidateRows: CandidateRow[];
  candidates: (Candidate & { x: number; y: number; diameter: number; labelWidth: number; colors: number[]; unread: boolean })[];
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
  const groups = [{ side: 'cloud' as const, items: cloud }, { side: 'local' as const, items: local }];
  const twoRows = width < (candidates.length + 1) * 88;
  const capacity = Math.max(1, Math.floor((width - 24) / 88));
  const cloudRows = Math.max(1, Math.ceil(cloud.length / capacity));
  const localRows = Math.max(1, Math.ceil(local.length / capacity));
  const candidateHeight = vertical ? groups.filter(g => g.items.length).length * 40 : twoRows ? (cloudRows + localRows) * 88 + 12 : 96;
  const candidateRows: CandidateRow[] = [];
  const placedCandidates = groups.flatMap(({ side, items }) => {
    if (vertical && !items.length) return [];
    const rowY = vertical ? candidateRows.length * 40 : 0;
    const contentWidth = vertical ? Math.max(width, items.length * 40 + 16) : width;
    candidateRows.push({ side, y: rowY, height: vertical ? 40 : candidateHeight, width: contentWidth });
    return items.map((c, i) => {
      if (vertical) {
        const left = side === 'local' ? Math.max(8, contentWidth - 8 - items.length * 40) : 8;
        return { ...c, x: left + i * 40 + 20, y: rowY + 20, diameter: 40, labelWidth: 28, colors: [] as number[], unread: false };
      }
      const row = twoRows ? Math.floor(i / capacity) : 0;
      const count = twoRows ? Math.min(capacity, items.length - row * capacity) : items.length;
      const gap = Math.min(104, (width - 24) / Math.max(1, twoRows ? count : candidates.length + 1));
      const slot = twoRows ? i % capacity : i;
      return { ...c, x: side === 'local' ? width - 12 - gap * (count - slot - .5) : 12 + gap * (slot + .5),
        y: 36 + (side === 'local' && twoRows ? cloudRows + row : row) * 88, diameter: 44, labelWidth: gap - 12, colors: [] as number[], unread: false };
    });
  });
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
      kind: isArcDispatch(session.dispatchSummary) ? 'executor' : 'floating', depth: 0, x: 0, y: 0, width: nodeWidth, height: nodeHeight });
    if (candidate && session.endedAt !== undefined && session.readAt === undefined) candidate.unread = true;
  }
  for (const { agent, session } of ordered) {
    const summary = session.dispatchSummary;
    if (!isArcDispatch(summary)) continue;
    const to = conversationKey(agent, session.nativeSessionId ?? session.id);
    let from: string;
    if (summary.caller) {
      const caller = summary.caller;
      from = conversationKey(caller.agent, caller.conversationId);
      const conversation = conversations.find(row => row.agent === caller.agent && (row.conversation.nativeSessionId === caller.conversationId || row.conversation.id === caller.conversationId))?.conversation;
      const callerAccount = findAgent(caller.agent, conversation ? { ...conversation, dispatchSummary: conversation.dispatchSummary ?? undefined } : undefined);
      if (!nodes.has(from)) nodes.set(from, { id: from, candidateId: callerAccount?.id, agent: caller.agent, conversation,
        label: conversation?.title || [callerAccount?.platformLabel ?? caller.agent, callerAccount?.accountLabel].filter(Boolean).join(' · '), kind: 'agent', depth: 0, x: 0, y: 0, width: nodeWidth, height: nodeHeight });
      else {
        const node = nodes.get(from)!;
        node.conversation = conversation;
        if (!node.candidateId && conversation) node.candidateId = findAgent(caller.agent, { ...conversation, dispatchSummary: conversation.dispatchSummary ?? undefined })?.id;
        if (!node.session?.title && conversation?.title) {
          node.label = conversation.title;
          if (node.session) node.session = { ...node.session, title: conversation.title };
        }
        if (node.kind === 'floating') node.kind = 'agent';
      }
    } else {
      const source = summary.controlSource;
      const candidate = placedCandidates.find(c => !!source?.accountId && c.accountId === source.accountId && c.sourceIds.length)
        ?? placedCandidates.find(c => !!source?.id && c.sourceIds.includes(source.id));
      const remote = candidate?.side === 'cloud' || !!source?.kind && !['local', 'local-cli', 'local-ui', 'stdio', 'ARC'].includes(source.kind);
      from = JSON.stringify(['dispatcher', source?.id ?? source?.accountId ?? source?.kind ?? 'ARC']);
      if (!nodes.has(from)) nodes.set(from, { id: from, candidateId: candidate?.id, label: [candidate?.platformLabel ?? source?.kind ?? 'ARC', candidate?.accountLabel ?? source?.label].filter(Boolean).join(' · '),
        source, kind: remote ? 'remote' : 'unattributed', depth: 0, x: 0, y: 0, width: nodeWidth, height: nodeHeight });
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
    const read = members.some(n => n.session?.endedAt !== undefined && (n.session.readAt ?? -1) >= lastDispatch);
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
  const placedFloating: ArenaNode[] = [];
  let floatBottom = 0;
  for (const node of floating) {
    const candidate = placedCandidates.find(c => c.id === node.candidateId);
    node.width = MIN_BUBBLE_WIDTH; node.height = 54;
    node.x = Math.max(8, Math.min(width - node.width - 8, (candidate?.x ?? width / 2) - node.width / 2));
    node.y = 8;
    while (placedFloating.some(other => other.x < node.x + node.width + 12 && node.x < other.x + other.width + 12
      && other.y < node.y + node.height + 12 && node.y < other.y + other.height + 12)) node.y += node.height + 12;
    placedFloating.push(node);
    floatBottom = Math.max(floatBottom, node.y + node.height + 16);
  }
  const top = floatBottom + 24, margin = 24, depth = Math.max(1, ...loops.map(l => l.depth));
  if (vertical) return portraitLayout({ loops, floating, width, height, top, nodeWidth, nodeHeight, candidateHeight, candidateRows, candidates: placedCandidates });
  const bandGap = 24;
  const bandSizes = loops.map(l => Math.max(1, ...Array.from({ length: l.depth + 1 }, (_, d) => l.nodes.filter(n => n.depth === d).length)));
  const crossCount = Math.max(1, bandSizes.reduce((a, b) => a + b, 0));
  const availableFlow = width - margin * 2;
  const radius = 46 + Math.min(loops.length, 4) * 4;
  const nw = Math.max(MIN_BUBBLE_WIDTH, Math.min(nodeWidth, (availableFlow - radius * 2 - 64 - (depth - 1) * 28) / (depth + 1)));
  const flowSize = nw, crossSize = nodeHeight;
  const firstHop = flowSize + radius * 2 + 64, laterHop = flowSize + 32;
  const minFlow = margin * 2 + flowSize + firstHop + (depth - 1) * laterHop;
  const extent = Math.max(availableFlow, minFlow);
  const spare = Math.max(0, availableFlow - minFlow);
  const start = margin + flowSize / 2 + spare / 2;
  const flowOf = (d: number) => start + (d ? firstHop + (d - 1) * laterHop : 0);
  const crossGap = 16;
  const totalCross = crossCount * (crossSize + crossGap) + Math.max(0, loops.length - 1) * bandGap;
  const crossExtent = Math.max(height - top, totalCross + margin * 2);
  const crossMid = crossExtent / 2;
  const ringFlow = start + firstHop / 2;
  const ring = { x: ringFlow, y: top + crossMid, radius };
  let cross = crossMid - totalCross / 2;
  loops.forEach((loop, li) => {
    const unit = crossSize + crossGap, band = bandSizes[li] * unit;
    for (let d = 0; d <= loop.depth; d++) {
      const column = loop.nodes.filter(n => n.depth === d);
      column.forEach((node, i) => {
        const c = cross + band / 2 + (i - (column.length - 1) / 2) * unit, f = flowOf(d);
        node.width = node.session ? nw : MIN_BUBBLE_WIDTH; node.height = node.session ? nodeHeight : 54;
        node.x = f - node.width / 2;
        node.y = top + c - node.height / 2;
      });
    }
    cross += band + bandGap;
  });
  return { orientation, candidateHeight, candidateRows, candidates: placedCandidates, ring, loops, floating,
    width: extent, height: top + crossExtent };
}

// Portrait depths are vertical blocks. Siblings wrap inside their block, and the
// next depth begins below every row of the previous depth. No stage x overflow.
function portraitLayout({ loops, floating, width, height, top, nodeWidth, nodeHeight, candidateHeight, candidateRows, candidates }: {
  loops: ArenaLoop[]; floating: ArenaNode[]; width: number; height: number; top: number; nodeWidth: number; nodeHeight: number;
  candidateHeight: number; candidateRows: CandidateRow[]; candidates: ArenaLayout['candidates'];
}): ArenaLayout {
  const margin = 12, gap = 16, available = Math.max(1, width - 2 * margin);
  const cardWidth = Math.min(available, Math.max(MIN_BUBBLE_WIDTH, nodeWidth));
  const columns = Math.max(1, Math.floor((available + gap) / (cardWidth + gap)));
  const radius = 46 + Math.min(loops.length, 4) * 4;
  const visualRadius = radius * 46 / 32;
  let cursor = top;
  const placeDepth = (depth: number) => {
    for (const loop of loops) {
      const nodes = loop.nodes.filter(node => node.depth === depth);
      for (let start = 0; start < nodes.length; start += columns) {
        const row = nodes.slice(start, start + columns);
        const rowHeight = Math.max(...row.map(node => node.session ? nodeHeight : 54));
        const rowWidth = row.length * cardWidth + (row.length - 1) * gap;
        row.forEach((node, index) => {
          node.width = node.session ? cardWidth : Math.min(MIN_BUBBLE_WIDTH, cardWidth);
          node.height = node.session ? nodeHeight : 54;
          node.x = (width - rowWidth) / 2 + index * (cardWidth + gap) + (cardWidth - node.width) / 2;
          node.y = cursor + (rowHeight - node.height) / 2;
        });
        cursor += rowHeight + gap;
      }
    }
  };
  placeDepth(0);
  const ring = { x: width / 2, y: cursor + visualRadius + 8, radius };
  cursor = ring.y + visualRadius + 24;
  for (let depth = 1; depth <= Math.max(1, ...loops.map(loop => loop.depth)); depth++) placeDepth(depth);
  let extent = cursor + 8;
  if (loops.length) {
    const offset = Math.max(0, (height - extent) / 2);
    for (const loop of loops) for (const node of loop.nodes) node.y += offset;
    ring.y += offset;
  } else { ring.y = top + Math.max(visualRadius, (height - top) / 2); extent = ring.y + visualRadius + 24; }
  return { orientation: 'portrait', width, height: Math.max(height, extent), candidateHeight, candidateRows, candidates, ring, loops, floating };
}
