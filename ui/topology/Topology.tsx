import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useMedia } from '../state/hooks';
import { appEnvironment } from '../state/appEnvironment';
import { activityBubbleSnapshot } from '../state/activityBubbles';
import { topologyLayout, bubbleDensity, bubbleWidth, bubbleAutoCompact } from '../subscriptions/displayPreferences';
import { bubbleWidths, bubbleHeights } from '../state/activityModel';
import { selectAgentPanel } from '../state/overviewPanels';
import { conversationActivity } from '../components/objects/task/projection';
import type { AgentConversation } from '../types';
import { t } from '../i18n';
import { ActivityBubble } from '../components/ActivityBubbles';
import { DispatcherNode } from '../components/objects/task/DispatcherNode';
import { observeTopology } from '../runtimeSnapshot';
import { resolveOrientation, type Orientation } from './orientation';
import { solve, conversationKey, type Session, type ArenaNode, type ArenaLoop, type ArenaLayout } from './solve';
import type { CandidateView } from './accountViews';
import { TopologyAnimator } from './animate';
import { TopologyPainter } from './render';

export default function Topology({ candidates, sessions, conversations = [], now, brand, onRead }: {
  candidates: CandidateView[]; sessions: Session[]; conversations?: { agent: string; conversation: AgentConversation }[]; now: number; brand: ReactNode; onRead: (agent: string, id: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null), stage = useRef<HTMLDivElement>(null), canvas = useRef<HTMLDivElement>(null);
  const candidateRows = useRef(new Map<string, HTMLDivElement>());
  const svg = useRef<SVGSVGElement>(null), hub = useRef<HTMLDivElement>(null);
  const elements = useRef(new Map<string, HTMLDivElement>()), animator = useRef(new TopologyAnimator());
  const painter = useRef<TopologyPainter | null>(null), frame = useRef(0), lastTime = useRef(0);
  const reduced = useMedia('(prefers-reduced-motion: reduce)'), preference = topologyLayout.use();
  appEnvironment.use();
  const density = bubbleDensity.use(), width = bubbleWidth.use(), compact = bubbleAutoCompact.use();
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const orientation = useRef<Orientation>('landscape');
  orientation.current = resolveOrientation(orientation.current, preference, viewport.width, viewport.height);
  // Read operations can remove a tracked completion immediately. Keep its graph
  // until the whole loop has returned, using the same durable acknowledgement.
  const history = useRef(new Map<string, Session>()), colors = useRef<Record<string, number>>({});
  const acknowledgements = activityBubbleSnapshot();
  for (const row of sessions) history.current.set(conversationKey(row.agent, row.session.nativeSessionId ?? row.session.id), row);
  const currentKeys = new Set(sessions.map(row => conversationKey(row.agent, row.session.nativeSessionId ?? row.session.id)));
  const allSessions = [...history.current.entries()].map(([key, row]) => {
    const read = acknowledgements.find(a => a.agent === row.agent && a.id === row.session.id && a.completed && a.readAt !== null);
    return { ...row, session: { ...row.session,
      ...(!currentKeys.has(key) && row.session.endedAt === undefined ? { endedAt: now } : {}),
      ...(read ? { readAt: read.readAt! } : {}) } };
  });
  const effectiveDensity = density === 'detailed' && compact && sessions.length > 4 ? 'standard' : density;
  const layout = solve({ sessions: allSessions, candidates: candidates.map(({ content: _content, ...c }) => c), ...viewport,
    orientation: orientation.current, now, conversations, colors: colors.current, nodeWidth: bubbleWidths[width], nodeHeight: bubbleHeights[effectiveDensity] });
  for (const loop of layout.loops) colors.current[loop.id] = loop.color;
  const nodes = [...layout.loops.flatMap(l => l.nodes), ...layout.floating];
  const [retained, setRetained] = useState<ArenaNode[]>([]), retainedLoops = useRef<ArenaLoop[]>([]);
  const allNodes = [...new Map([...retained, ...nodes].map(n => [n.id, n])).values()];
  const loops = [...new Map([...retainedLoops.current, ...layout.loops].map(l => [l.id, l])).values()];
  const latest = useRef({ layout, nodes, allNodes, loops, reduced });
  latest.current = { layout, nodes, allNodes, loops, reduced };
  const candidateOrigin = useCallback((node: ArenaNode, layout: ArenaLayout) => {
    const candidate = layout.candidates.find(c => c.id === node.candidateId);
    const scrollLeft = candidate && layout.orientation === 'portrait' ? candidateRows.current.get(candidate.side)?.scrollLeft ?? 0 : 0;
    return candidate ? { x: candidate.x - scrollLeft - node.width / 2, y: candidate.y - layout.candidateHeight - node.height / 2 }
      : { x: layout.ring.x - node.width / 2, y: layout.ring.y - node.height / 2 };
  }, []);
  const scrollFades = useCallback(() => {
    const element = stage.current;
    if (!element) return;
    if (latest.current.layout.orientation === 'portrait') element.scrollLeft = 0;
    element.style.setProperty('--stage-fade-top', element.scrollTop > 1 ? '24px' : '0px');
    element.style.setProperty('--stage-fade-bottom', element.scrollHeight - element.scrollTop - element.clientHeight > 1 ? '32px' : '0px');
  }, []);
  const paint = useCallback(() => {
    const { layout, allNodes, loops, reduced } = latest.current, a = animator.current, ring = a.values('ring');
    if (!ring) return;
    for (const node of allNodes) {
      const element = elements.current.get(node.id), value = a.values(node.id);
      if (!element) continue;
      element.inert = !a.live.get(node.id)?.alive;
      if (!value) { element.style.opacity = '0'; continue; }
      element.style.width = `${value.width}px`; element.style.height = `${value.height}px`;
      element.style.transform = `translate(${value.x}px, ${value.y}px) scale(${value.scale})`;
      element.style.opacity = String(Math.max(0, value.opacity));
    }
    if (hub.current) {
      const size = ring.radius * 92 / 32;
      hub.current.style.width = hub.current.style.height = `${size}px`;
      hub.current.style.transform = `translate(${ring.x - size / 2}px, ${ring.y - size / 2}px)`;
      hub.current.style.setProperty('--hub-dot-size', `${size * 20 / 92}px`);
      hub.current.style.setProperty('--hub-rotation', `${ring.rotation}deg`);
      const angle = ring.rotation * Math.PI / 180;
      for (const [side, sign] of [['source', -1], ['agent', 1]] as const) {
        hub.current.style.setProperty(`--${side}-dot-x`, `${50 + sign * Math.cos(angle) * 32 / 92 * 100}%`);
        hub.current.style.setProperty(`--${side}-dot-y`, `${50 + sign * Math.sin(angle) * 32 / 92 * 100}%`);
      }
    }
    painter.current?.paint(a, layout, loops, reduced);
  }, []);
  const tick = useCallback((time: number) => {
    frame.current = 0;
    const moving = animator.current.step(Math.min(.064, lastTime.current ? (time - lastTime.current) / 1000 : 1 / 60), latest.current.reduced);
    lastTime.current = time; paint();
    if (moving) frame.current = requestAnimationFrame(tick);
    else {
      lastTime.current = 0;
      setRetained(old => {
        const next = old.filter(n => animator.current.live.has(n.id));
        return next.length === old.length ? old : next;
      });
      retainedLoops.current = latest.current.loops.filter(l => l.nodes.some(n => animator.current.live.has(n.id)));
    }
  }, [paint]);
  const wake = useCallback(() => { if (!frame.current) frame.current = requestAnimationFrame(tick); }, [tick]);
  useLayoutEffect(() => {
    if (!host.current || !svg.current) return;
    painter.current = new TopologyPainter(svg.current);
    const resize = () => {
      const rect = host.current!.getBoundingClientRect();
      if (rect.width && rect.height) setViewport(old => old.width === rect.width && old.height === rect.height ? old : { width: rect.width, height: rect.height });
    };
    const observer = new ResizeObserver(resize); observer.observe(host.current); resize();
    return () => { observer.disconnect(); cancelAnimationFrame(frame.current); frame.current = 0; painter.current?.dispose(); };
  }, []);
  const signature = JSON.stringify(layout);
  useLayoutEffect(() => {
    if (!viewport.width || !viewport.height) return;
    const a = animator.current;
    a.target('ring', { ...layout.ring, rotation: layout.orientation === 'portrait' ? 90 : 0 });
    const active = new Set(nodes.map(n => n.id));
    for (const node of allNodes) {
      if (active.has(node.id)) {
        const loop = layout.loops.find(l => l.nodes.some(n => n.id === node.id));
        a.target(node.id, { x: node.x, y: node.y, width: node.width, height: node.height, opacity: loop?.lingering ? .62 : 1, scale: 1, draw: 1 },
          { ...candidateOrigin(node, layout), opacity: 0, scale: .5, draw: 0 });
      } else if (a.live.has(node.id)) a.retire(node.id, candidateOrigin(node, layout));
    }
    retainedLoops.current = loops;
    setRetained(old => {
      const next = allNodes.filter(n => active.has(n.id) || a.live.has(n.id));
      return old.length === next.length && old.every((n, i) => n === next[i]) ? old : next;
    });
    if (canvas.current) { canvas.current.style.width = `${layout.width}px`; canvas.current.style.height = `${layout.height}px`; }
    if (stage.current) stage.current.style.top = `${layout.candidateHeight}px`;
    a.step(0, reduced); paint(); scrollFades(); wake();
  // The pure layout is compared by value; animated values never drive React.
  }, [signature, reduced, paint, wake, candidateOrigin, scrollFades]);
  useEffect(() => observeTopology(() => {
    const { layout, nodes } = latest.current;
    return { ...layout, kind: 'arena', candidateRows: layout.candidateRows.map(row => ({ ...row, scrollLeft: candidateRows.current.get(row.side)?.scrollLeft ?? 0 })), lingering: layout.loops.filter(l => l.lingering).map(l => l.id),
      loops: layout.loops.map(loop => ({ ...loop, nodes: loop.nodes.map(({ session, ...node }) => ({ ...node, taskId: session?.id, position: animator.current.values(node.id) })) })),
      floating: layout.floating.map(({ session, ...node }) => ({ ...node, taskId: session?.id, position: animator.current.values(node.id) })),
      returning: latest.current.allNodes.filter(n => !nodes.some(row => row.id === n.id) && animator.current.live.has(n.id)).map(n => ({ id: n.id, candidateId: n.candidateId, position: animator.current.values(n.id) })),
      ring: { ...layout.ring, position: animator.current.values('ring') } };
  }), []);
  const colorFor = (index: number) => `var(--chart-${index + 1})`;
  return <div ref={host} className="relative h-full w-full overflow-hidden" data-orientation={layout.orientation}>
    <div className="absolute inset-x-0 top-0 z-10" aria-label={t('accounts.title')}>
      {layout.candidateRows.map(row => <div key={row.side} data-candidate-row={row.side}
        className={`absolute inset-x-0 ${layout.orientation === 'portrait' ? 'overflow-x-auto overflow-y-hidden overscroll-x-contain' : 'pointer-events-none overflow-visible'}`}
        ref={element => {
          if (!element) { candidateRows.current.delete(row.side); return; }
          candidateRows.current.set(row.side, element);
          element.style.top = `${row.y}px`; element.style.height = `${row.height}px`;
        }} onScroll={() => {
          for (const node of latest.current.allNodes) if (animator.current.live.get(node.id)?.alive === false) animator.current.retire(node.id, candidateOrigin(node, latest.current.layout));
          wake();
        }}>
        <div className="relative" ref={element => { if (element) { element.style.width = `${row.width}px`; element.style.height = `${row.height}px`; } }}>
          {layout.candidates.filter(c => c.side === row.side).map(candidate => <div key={candidate.id} className="topology-node pointer-events-auto"
            data-compact={layout.orientation === 'portrait' || undefined} data-agent-node={candidate.agent} data-account-id={candidate.accountId} data-source-node={candidate.sourceIds[0]} ref={element => {
              if (element) {
                element.style.transform = `translate(${candidate.x - candidate.diameter / 2}px, ${candidate.y - row.y - candidate.diameter / 2}px)`;
                element.style.setProperty('--candidate-label-width', `${candidate.labelWidth}px`);
              }
            }}>{candidates.find(c => c.id === candidate.id)?.content}
            <span className={`pointer-events-none absolute flex gap-1 ${layout.orientation === 'portrait' ? 'right-0 top-0' : '-right-1 -top-1'}`} aria-label={candidate.unread ? t('activity.unread') : undefined}>
              {candidate.colors.map(color => <span key={color} className="topology-loop-dot" ref={el => { if (el) el.style.backgroundColor = colorFor(color); }} />)}
              {candidate.unread && <span className="size-2 rounded-full bg-success" />}
            </span>
          </div>)}
        </div>
      </div>)}
    </div>
    <div ref={stage} className={`topology-stage absolute inset-x-0 bottom-0 ${layout.orientation === 'portrait' ? 'overflow-x-hidden overflow-y-auto' : 'overflow-auto'}`} onScroll={scrollFades}>
      <div ref={canvas} className={`relative${layout.orientation === 'portrait' ? ' overflow-x-clip' : ''}`} data-arena-stage>
        <svg ref={svg} className="topology-wires" aria-hidden="true" />
        <div ref={hub} className="topology-hub">{brand}{!layout.loops.length && <time className="pointer-events-none absolute inset-0 grid place-items-center text-sm tabular-nums text-muted-foreground">{new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>}</div>
        {allNodes.map(node => <div key={node.id} ref={element => { if (element) elements.current.set(node.id, element); else elements.current.delete(node.id); }}
          className={`activity-slot${node.kind === 'floating' ? ' topology-floating' : ''}`} data-arena-node={node.id}>
          {node.session && node.agent
            ? <ActivityBubble agent={node.agent} session={node.session} now={now} density={node.kind === 'floating' ? 'compact' : effectiveDensity} onRead={() => onRead(node.agent!, node.session!.id)} />
            : <DispatcherNode agent={node.agent} platform={candidates.find(c => c.id === node.candidateId)?.platform} source={node.source}
              title={node.conversation?.title || undefined} account={candidates.find(c => c.id === node.candidateId)?.accountLabel}
              onOpen={node.agent ? () => selectAgentPanel({ type: 'task', agent: node.agent!, session: conversationActivity(node.conversation ?? { id: JSON.parse(node.id)[2], source: 'native', createdAt: null }) }) : undefined} />}
        </div>)}
      </div>
    </div>
  </div>;
}
