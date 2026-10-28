import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { scenarioName } from '../scenarioMode';
import { api } from '../api';
import { controlSourcePlatform } from '../controlSources';
import { isPendingSource } from '../sourcePresentation';
import { t } from '../i18n';
import { connector, orderedSources } from '../state/connector';
import { agents, name } from '../state/agents';
import { tasks } from '../state/tasks';
import { accounts } from '../state/accounts';
import { accountOwns } from '../accountPresentation';
import { trackedActivity } from '../state/activityBubbles';
import { activityApprovals } from '../state/activity';
import { taskExecution, taskExecutions } from '../state/taskExecution';
import { activityState } from '../state/taskExecutionModel';
import { pendingSessions } from '../state/taskInteractions';
import { selectAgentPanel } from '../state/overviewPanels';
import type { TaskReview } from '../state/taskReview';
import { petBrand, selectPet, type Participant, type Point } from './model';
import { petAssignments, petAssets, petAsset, petLibrary, refreshPets, showPets } from './state';
import { arcPoint, maySpeak, petIntents, presentPet, relayPose, taskPetRow, selectLoopPair, taskColor, queuePetIntent, visiblePetIntent, retainPetIntents, stepRelayQueue, pendingRelayUntil, selectCompanions, RELAY_MS, RELAY_CUES, type LoopPair, type PetIntent, type RelayTask, type RelayClock } from './relay';
import { petSize, taskPost, bubbleWander, boundPet, overlaps, type Rect, type PetSize } from './geometry';
import { setPetSnapshot } from './snapshot';
import PetActor, { type PetActorHandle } from './PetActor';
import { usePetMotion } from './usePetMotion';
import { activityPose, type PetPose } from './behavior';
import { mascotAnchors } from './mascotGeometry';
import type { AgentPhase } from '../types';
export type PetInteraction = 'sit' | 'swing' | 'pull';
export interface PetGeometry {
  interaction?: (p: Participant, kind: PetInteraction, size: PetSize, anchors?: (facing: -1 | 1) => { seat: Point; grip: Point }) => { point: Point; pivot?: Point; targetId?: string; facing?: -1 | 1 } | undefined;
  feedback?: (targetId: string, amount: number) => void;
  taskFrame: (agent: string, id: string) => Rect | undefined;
  taskPresent: (agent: string, id: string) => boolean;
  route: (from: Point, to: Point, size: PetSize, occupied?: Rect[]) => Point[] | undefined;
  participant: (p: Participant, accountId?: string, size?: PetSize) => Point | undefined; task: (agent: string, id: string, accountId?: string) => Point | undefined; bounds: Point & { top: number }; wander: (from: Point, size: PetSize, occupied: (Point & { width: number; height: number })[]) => Point | undefined }
const requestedAction = import.meta.env.DEV && scenarioName ? new URLSearchParams(location.search).get('petAction') : null;
const fixtureAction = requestedAction && ['sit', 'swing', 'pull'].includes(requestedAction) ? requestedAction as PetInteraction : undefined;
export interface PetLayerHandle { layout: () => void }
export default function PetLayer({ geometry, ref }: { geometry: () => PetGeometry; ref: Ref<PetLayerHandle> }) {
  const enabled = showPets.use(), library = petLibrary.use(), assignments = petAssignments.use(), assets = petAssets.use();
  const agentState = agents.use(), records = tasks.use().records, tracked = trackedActivity.use(), submissions = activityApprovals.use();
  const { status } = connector.use(); taskExecutions.use();
  const motion = usePetMotion(), actors = useRef(new Map<string, PetActorHandle>()), speech = useRef(new Map<string, number>());
  const [now, setNow] = useState(Date.now), [reviews, setReviews] = useState<Record<string, TaskReview & { baseline: boolean }>>({});
  const reviewReads = useRef(new Set<string>()), liveTurns = useRef(new Set<string>());
  const previous = useRef(new Map<string, RelayTask>()), seen = useRef(new Set<string>()), events = useRef<PetIntent[]>([]);
  const relayClock = useRef<RelayClock | undefined>(undefined);
  const engaged = useRef(new Map<string, number>()), cards = useRef<HTMLDivElement>(null), cardElements = useRef(new Map<string, HTMLSpanElement>());
  const cueTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const frame = useRef(0), latestLayout = useRef(() => {});
  const behaviors = useRef(new Map<string, { key: string; until: number; pose: PetPose }>());
  const taskWalks = useRef(new Map<string, { home: Point; path: Point[]; next: number; docked: boolean; obstacles: string }>());
  const walks = useRef(new Map<string, { point: Point; next: number }>());
  const social = useRef<{ source: string; agent: string; at: number; kind: number; sourcePoint: Point; agentPoint: Point; spoken: Set<string> } | undefined>(undefined);
  const nextSocial = useRef(Date.now() + 8000);
  const pair = useRef<LoopPair | undefined>(undefined), companions = useRef<string[]>([]);
  const cachedGeometry = useRef<PetGeometry | undefined>(undefined), tugs = useRef(new Map<string, number>());
  const counts = useRef({ petCount: 0, animatedPetCount: 0, taskPetCount: 0, movingCardCount: 0 });
  const scenes = useRef(new Map<string, { next: number; index: number; action?: { kind: PetInteraction; deadline: number; arrived?: number; path: Point[]; target: Point } }>());
  const feedbackTargets = useRef(new Set<string>());
  const sources = orderedSources().filter(source => source.state !== 'revoked' && !isPendingSource(source, status?.ingresses ?? []));
  const participants: Participant[] = [
    ...sources.map(s => ({ id: `source:${s.id}`, nativeId: s.id, name: s.label, platform: controlSourcePlatform(s.product).id, kind: 'source' as const, brand: petBrand(s.product) })),
    ...agentState.items.filter(a => a.installed && a.enabled).map(a => ({ id: `agent:${a.agent}`, nativeId: a.agent, name: name(a), platform: controlSourcePlatform(a.agent).id, kind: 'agent' as const, brand: petBrand(a.agent) })),
  ];
  const accountRows = accounts.use().items;
  const orderedRecords = [...records].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const relayTasks: RelayTask[] = Object.entries(tracked).flatMap(([agent, sessions]) => sessions.map(session => {
    const record = orderedRecords.find(r => r.agent === agent && [r.taskId, r.threadId, r.open?.taskId].includes(session.id) && (!session.turnId || !r.turnId || r.turnId === session.turnId));
    const execution = taskExecution(agent, session.id);
    const state = activityState(session, execution, pendingSessions(agent, session, execution?.interactions ?? [], submissions).length > 0);
    const key = JSON.stringify([agent, session.id]), review = reviews[JSON.stringify([session.id, session.turnId])];
    return { key, title: session.title, taskId: session.id, agent, sourceId: session.origin?.sourceId ?? record?.origin?.sourceId ?? session.dispatchSummary?.controlSource?.id,
      accountId: accountRows.find(account => account.agentProfiles.some(profile => profile.agent === agent) && accountOwns(account, session.agentAccountId))?.id ?? session.agentAccountId, dispatchId: record?.requestId, turn: session.turnId ?? session.turnStartedAt ?? '', state,
      phaseSince: Date.parse(session.phaseSince ?? ''), at: Date.parse(record?.createdAt ?? session.turnStartedAt ?? session.startedAt ?? '') || 0,
      ...(review ? { review: { id: review.requestId, verdict: review.verdict, baseline: review.baseline } } : {}) };
  }));
  // Dispatches can precede the first observed execution. They create participants, never a fake task bubble.
  for (const record of orderedRecords) {
    if (!record.agent || !record.origin?.sourceId || relayTasks.some(task => task.dispatchId === record.requestId) || !['submitted', 'running', 'accepted'].includes(record.state)) continue;
    const taskId = record.taskId ?? record.open?.taskId ?? record.threadId;
    if (!taskId || relayTasks.some(task => task.agent === record.agent && task.taskId === taskId)) continue;
    relayTasks.push({ key: JSON.stringify([record.agent, taskId]), taskId, agent: record.agent, sourceId: record.origin.sourceId,
      dispatchId: record.requestId, turn: record.turnId ?? '', state: 'unknown', at: Date.parse(record.createdAt) });
  }
  const historyPairs: RelayTask[] = orderedRecords.flatMap(record => record.agent && record.origin?.sourceId && ['submitted', 'running', 'accepted', 'completed'].includes(record.state) ? [{
    key: record.requestId, taskId: record.taskId ?? record.threadId ?? record.requestId, agent: record.agent,
    sourceId: record.origin.sourceId, turn: record.turnId ?? '', state: 'done', at: Date.parse(record.createdAt) || 0,
  }] : []);
  pair.current = selectLoopPair([...relayTasks, ...historyPairs], pair.current,
    new Set(sources.map(source => source.id)), new Set(participants.filter(p => p.kind === 'agent').map(p => p.nativeId)));
  const attentionTask = relayTasks.find(task => task.state === 'needsYou');
  const episode = !attentionTask ? events.current.find(event => (event.id === relayClock.current?.head || event.at <= now && now - event.at < RELAY_MS) && (!event.task.sourceId || participants.some(p => p.id === `source:${event.task.sourceId}`)) && participants.some(p => p.id === `agent:${event.task.agent}`)) : undefined;
  const workingTask = attentionTask ?? episode?.task;
  const attributedTask = workingTask?.sourceId && participants.some(p => p.id === `source:${workingTask.sourceId}`) ? workingTask : undefined;
  const visiblePair = attributedTask ? { sourceId: attributedTask.sourceId!, agent: attributedTask.agent } : workingTask ? undefined : pair.current;
  companions.current = selectCompanions(participants, companions.current);
  const resident = new Set(visiblePair ? [`source:${visiblePair.sourceId}`, `agent:${visiblePair.agent}`] : workingTask ? [...companions.current.filter(id => id.startsWith('source:')), `agent:${workingTask.agent}`] : companions.current);
  const active = relayTasks.some(task => task.state === 'running' || task.state === 'needsYou');
  const dataKey = JSON.stringify(relayTasks);
  function enqueue(event: PetIntent) {
    if (seen.current.has(event.id)) return;
    seen.current.add(event.id);
    const visible = visiblePetIntent(event, new Set(participants.filter(p => p.kind === 'source').map(p => p.nativeId)));
    if (visible) events.current = queuePetIntent(events.current, visible, Date.now());
  }
  useEffect(() => {
    if (!enabled) return;
    const changedAt = Date.now();
    const attention = relayTasks.some(task => task.state === 'needsYou');
    if (!motion.animate || attention) { events.current = []; relayClock.current = undefined; }
    if (!motion.visible) { reviewReads.current.clear(); liveTurns.current.clear(); }
    for (const task of relayTasks) {
      // Dispatch evidence may arrive before its execution bubble. Do not consume
      // the handoff until a real task actor can receive and carry the card.
      if (!tracked[task.agent]?.some(session => session.id === task.taskId)) continue;
      const before = previous.current.get(task.key);
      if (motion.visible && (!['done', 'failed', 'interrupted'].includes(task.state) || before && (before.turn !== task.turn || before.state !== task.state))) liveTurns.current.add(JSON.stringify([task.taskId, task.turn]));
      for (const event of petIntents(task, before, changedAt)) {
        if (motion.animate && !attention) enqueue(event);
      }
      previous.current.set(task.key, task);
      const id = `task:${task.key}`;
      if (!engaged.current.has(id) || ['running', 'needsYou'].includes(task.state) || before?.state !== task.state || before?.review?.id !== task.review?.id) engaged.current.set(id, changedAt);
    }
    // A timer proposes stable stall intents; the event identity prevents repeated urging for one phase.
    setNow(changedAt); latestLayout.current();
  }, [enabled, motion.animate, dataKey]);
  useEffect(() => {
    if (!enabled || !motion.visible) return;
    const tick = () => {
      const time = Date.now();
      const attention = relayTasks.some(task => task.state === 'needsYou');
      for (const task of relayTasks) {
        if (!tracked[task.agent]?.some(session => session.id === task.taskId)) continue;
        if (['running', 'needsYou'].includes(task.state)) engaged.current.set(`task:${task.key}`, time);
        for (const event of petIntents(task, previous.current.get(task.key), time)) if (motion.animate && !attention) enqueue(event);
      }
      setNow(time); latestLayout.current();
    };
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [enabled, motion.visible, motion.animate, active, dataKey]);
  const reviewIds = [...new Set(relayTasks.filter(task => ['done', 'failed', 'interrupted'].includes(task.state)).map(task => task.taskId))].sort().join('|');
  useEffect(() => {
    if (!enabled || !motion.visible || !reviewIds) return;
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      const result: Record<string, TaskReview & { baseline: boolean }> = {};
      for (const id of reviewIds.split('|')) {
        if (stopped) return;
        try { const value = await api<{ reviews: { turnId: string; review: TaskReview }[] }>('tasks/reviews', 'POST', { id });
          if (stopped) return;
          for (const row of value.reviews) {
            const key = JSON.stringify([id, row.turnId]);
            result[key] = { ...row.review, baseline: !reviewReads.current.has(key) && !liveTurns.current.has(key) };
            reviewReads.current.add(key);
          }
          // A successful empty read is also a baseline: a later review is new.
          for (const task of previous.current.values()) if (task.taskId === id) reviewReads.current.add(JSON.stringify([id, task.turn]));
        } catch { /* Supplementary review unavailability never changes execution evidence. */ }
      }
      if (!stopped) { setReviews(old => { const next = { ...old, ...result }; return JSON.stringify(old) === JSON.stringify(next) ? old : next; }); timer = setTimeout(read, 15000); }
    };
    void read(); return () => { stopped = true; clearTimeout(timer); };
  }, [enabled, motion.visible, reviewIds]);
  const participantFor = (kind: 'source' | 'agent', id: string | undefined) => participants.find(p => p.kind === kind && p.nativeId === id);
  const rendered = enabled ? participants.filter(p => resident.has(p.id)).flatMap(p => {
    const pet = selectPet(p, library.packages, assignments); return pet ? [{ p, pet }] : [];
  }) : [];
  const taskPets = enabled ? relayTasks.flatMap(task => {
    const session = tracked[task.agent]?.find(s => s.id === task.taskId), p = participantFor('agent', task.agent), pet = p && selectPet(p, library.packages, assignments);
    return p && pet && session && presentPet(engaged.current.get(`task:${task.key}`) ?? now, false, now, pendingRelayUntil(task, events.current)).present ? [{ task, session, p, pet }] : [];
  }) : [];
  const keys = [...rendered, ...taskPets].map(r => r.pet.key).join('|');
  useEffect(() => { if (enabled) void refreshPets(); else { events.current = []; relayClock.current = undefined; previous.current.clear(); seen.current.clear(); engaged.current.clear(); reviewReads.current.clear(); liveTurns.current.clear(); } }, [enabled]);
  useEffect(() => { for (const { pet } of [...rendered, ...taskPets]) void petAsset(pet.key).catch(() => {}); }, [keys]);
  const allowSpeech = (pair: string) => { const time = Date.now(); if (!maySpeak(speech.current.get(pair), time)) return false; speech.current.set(pair, time); return true; };
  const pairKey = (task: RelayTask) => JSON.stringify([task.sourceId ?? '', task.agent]);
  function behavior(id: string, task: RelayTask | undefined, participant: boolean, time: number) {
    const phase: AgentPhase = task ? tracked[task.agent]?.find(session => session.id === task.taskId)?.phase ?? 'idle' : 'idle';
    const state = task?.state ?? 'done', key = `${phase}:${state}`;
    let current = behaviors.current.get(id);
    if (!current || current.key !== key || time >= current.until) {
      current = { key, until: time + 3500 + Math.random() * 5000, pose: activityPose(phase, state, participant) }; behaviors.current.set(id, current);
    }
    return current.pose;
  }
  function layout(invalidate = false) {
    if (invalidate || !cachedGeometry.current) cachedGeometry.current = geometry();
    const g = cachedGeometry.current, time = Date.now();
    for (const id of feedbackTargets.current) g.feedback?.(id, 0);
    feedbackTargets.current.clear(); tugs.current.clear();
    if (!enabled) {
      behaviors.current.clear(); walks.current.clear(); taskWalks.current.clear(); scenes.current.clear(); social.current = undefined; nextSocial.current = Date.now() + 8000;
      for (const el of cardElements.current.values()) el.remove();
      cardElements.current.clear();
      counts.current = { petCount: 0, animatedPetCount: 0, taskPetCount: 0, movingCardCount: 0 };
      setPetSnapshot({ petCount: 0, animatedPetCount: 0, taskPetCount: 0, movingCardCount: 0 });
      return;
    }
    const visibleIds = new Set([...rendered.map(({ p }) => p.id), ...taskPets.map(({ task }) => `task:${task.key}`)]);
    for (const id of behaviors.current.keys()) if (!visibleIds.has(id)) behaviors.current.delete(id);
    for (const id of walks.current.keys()) if (!visibleIds.has(id)) walks.current.delete(id);
    for (const id of scenes.current.keys()) if (!visibleIds.has(id)) scenes.current.delete(id);
    const visibleTurns = new Map(taskPets.filter(({ task }) => g.taskPresent(task.agent, task.taskId)).map(({ task }) => [task.key, task.turn]));
    const scheduled = stepRelayQueue(events.current.filter(event => visibleTurns.get(event.task.key) === event.task.turn), relayClock.current, time, event => {
      const task = event.task;
      return !!g.taskFrame(task.agent, task.taskId) && !!actors.current.get(`task:${task.key}`)?.hand() && !!actors.current.get(`agent:${task.agent}`)?.hand()
        && (!task.sourceId || !!actors.current.get(`source:${task.sourceId}`)?.hand());
    });
    if (scheduled.clock?.head !== relayClock.current?.head) setNow(time);
    relayClock.current = scheduled.clock;
    events.current = retainPetIntents(scheduled.events, visibleTurns, time);
    const poses = events.current.filter(event => event.at <= time).map(event => ({ event, pose: relayPose(event, time) }));
    for (const { event } of poses) engaged.current.set(`task:${event.task.key}`, time);
    const center = (p: Participant) => actors.current.get(p.id)?.point();
    const topLeft = (point: Point, size: PetSize) => ({ x: point.x - size.width / 2, y: point.y - size.height / 2 });
    const occupied = rendered.flatMap(({ p }) => {
      const point = center(p), size = petSize('participant', p.brand === 'other');
      return point ? [{ id: p.id, ...topLeft(point, size), width: size.width, height: size.height + size.tagHeight }] : [];
    });
    const needsAttention = relayTasks.some(task => task.state === 'needsYou' && (resident.has(`agent:${task.agent}`) || resident.has(`source:${task.sourceId}`)));
    if (!motion.animate || needsAttention || social.current && (time - social.current.at >= 8000 || !visibleIds.has(social.current.source) || !visibleIds.has(social.current.agent)
      || !actors.current.get(social.current.source)?.available() || !actors.current.get(social.current.agent)?.available()
      || poses.some(({ event }) => `source:${event.task.sourceId}` === social.current?.source || `agent:${event.task.agent}` === social.current?.agent))) social.current = undefined;
    if (motion.animate && !needsAttention && !fixtureAction && !social.current && ![...scenes.current.values()].some(scene => scene.action) && time >= nextSocial.current && !poses.length) {
      const sources = rendered.filter(({ p }) => p.kind === 'source' && center(p) && actors.current.get(p.id)?.available());
      const agents = rendered.filter(({ p }) => p.kind === 'agent' && center(p) && actors.current.get(p.id)?.available());
      const source = sources[Math.floor(Math.random() * sources.length)]?.p, agent = agents[Math.floor(Math.random() * agents.length)]?.p;
      nextSocial.current = time + 24000 + Math.random() * 18000;
      if (source && agent) social.current = { source: source.id, agent: agent.id, sourcePoint: center(source)!, agentPoint: center(agent)!, at: time, kind: Math.floor(Math.random() * 3), spoken: new Set() };
    }
    let petCount = 0, taskPetCount = 0;
    for (const { p, pet } of rendered) {
      const actor = actors.current.get(p.id); if (!actor || !assets[pet.key]) continue;
      const latest = [...poses].reverse().find(({ event }) => p.kind === 'source' ? event.task.sourceId === p.nativeId : event.task.agent === p.nativeId);
      const size = petSize('participant', p.brand === 'other');
      let point = g.participant(p, undefined, size);
      if (!point) { actor.hide(); continue; }
      const relatedTasks = relayTasks.filter(task => p.kind === 'agent' ? task.agent === p.nativeId : task.sourceId === p.nativeId);
      const activeTask = relatedTasks.find(task => task.state === 'needsYou') ?? relatedTasks.find(task => ['running', 'unknown'].includes(task.state));
      const encounter = social.current && [social.current.source, social.current.agent].includes(p.id) && !latest ? social.current : undefined;
      if (!actor.available() || latest || encounter || activeTask?.state === 'needsYou') walks.current.delete(p.id);
      else if (motion.animate) {
        let walk = walks.current.get(p.id);
        if (!walk) { walk = { point: center(p) ? topLeft(center(p)!, size) : point, next: time + 4000 + Math.random() * 7000 }; walks.current.set(p.id, walk); }
        if (time >= walk.next) {
          const from = center(p) ? topLeft(center(p)!, size) : walk.point;
          walk.point = g.wander(from, size, occupied.filter(other => other.id !== p.id)) ?? g.route(from, point, size)?.[0] ?? from;
          walk.next = time + 6500 + Math.random() * 8000;
        }
        point = walk.point;
      } else point = walks.current.get(p.id)?.point ?? (center(p) ? topLeft(center(p)!, size) : point);
      if ((!actor.available() || latest || activeTask?.state === 'needsYou') && center(p)) point = topLeft(center(p)!, size);
      if (encounter) point = topLeft(p.id === encounter.source ? encounter.sourcePoint : encounter.agentPoint, size);
      let contact: PetInteraction | undefined, pivot: Point | undefined, facing: -1 | 1 | undefined;
      const interaction = (kind: PetInteraction) => g.interaction?.(p, kind, size, pet.mascot ? direction => mascotAnchors(pet.mascot!, undefined, kind, direction) : undefined);
      let scene = scenes.current.get(p.id);
      if (!scene) { scene = { next: fixtureAction ? time : time + (p.kind === 'source' ? 5000 : 11000), index: p.kind === 'source' ? 0 : 1 }; scenes.current.set(p.id, scene); }
      if (!motion.animate || !actor.available() || latest || encounter || activeTask?.state === 'needsYou') {
        scene.action = undefined; scene.next = time + (fixtureAction ? 0 : 8000);
      } else if (g.interaction) {
        if (!scene.action && time >= scene.next) {
          const kind = fixtureAction ?? (['sit', 'swing', 'pull'] as const)[scene.index++ % 3];
          const spot = interaction(kind);
          const reserved = spot && [...scenes.current].some(([id, other]) => id !== p.id && other.action && Math.abs(other.action.target.x - spot.point.x) < size.width && Math.abs(other.action.target.y - spot.point.y) < size.height + size.tagHeight);
          if (spot && !reserved) {
            const from = center(p) ? topLeft(center(p)!, size) : point;
            const path = fixtureAction ? [] : g.route(from, spot.point, size);
            if (path) scene.action = { kind, deadline: time + 35000, path, target: spot.point };
          }
          scene.next = time + 15000;
        }
        const action = scene.action;
        if (action) {
          const spot = interaction(action.kind), current = center(p), from = current ? topLeft(current, size) : point;
          if (!spot || !fixtureAction && (time >= action.deadline || action.arrived && time - action.arrived >= (action.kind === 'sit' ? 10000 : 6000))) {
            scene.action = undefined; scene.next = time + 12000;
          } else {
            walks.current.delete(p.id);
            if (Math.hypot(spot.point.x - action.target.x, spot.point.y - action.target.y) > 12) {
              const path = fixtureAction ? [] : g.route(from, spot.point, size);
              if (!path) { scene.action = undefined; scene.next = time + 12000; }
              else { action.path = path; action.target = spot.point; action.arrived = undefined; }
            }
            while (action.path.length && Math.hypot(action.path[0].x - from.x, action.path[0].y - from.y) < 5) action.path.shift();
            point = scene.action ? action.path[0] ?? spot.point : from;
            if (scene.action && Math.hypot(from.x - spot.point.x, from.y - spot.point.y) < 8) {
              action.arrived ??= time; contact = action.kind; pivot = spot.pivot; facing = spot.facing;
              if (contact === 'pull' && spot.targetId) {
                tugs.current.set(spot.targetId, action.arrived);
              }
            }
          }
        }
      }
      actor.place(point, g.bounds, undefined, !latest && !fixtureAction); actor.contact(contact, pivot, facing); petCount++;
      let pose = behavior(p.id, activeTask, true, time);
      let speech = motion.visible && latest?.pose.speech && p.kind === 'source' && allowSpeech(pairKey(latest.event.task)) ? t(`pets.${latest.pose.speech}`) : undefined;
      if (encounter) {
        const first = p.id === encounter.source, elapsed = time - encounter.at, replying = elapsed >= 2200;
        pose = { row: first ? replying ? 0 : 3 : replying ? encounter.kind === 2 ? 4 : 3 : 8, gesture: encounter.kind === 2 ? 'hop' : first === !replying ? 'sway' : 'lean', tempo: first ? 1.1 : .9 };
        if ((first || replying) && !encounter.spoken.has(p.id)) {
          encounter.spoken.add(p.id);
          speech = t(`pets.social.${['wave', 'play', 'cheer'][encounter.kind]}.${first ? 'start' : 'reply'}`);
        }
      }
      if (contact) pose = { row: contact === 'sit' ? 0 : contact === 'swing' ? 3 : 7, gesture: 'still', tempo: 1.4 };
      if (latest) pose = { ...pose, gesture: 'still', action: p.kind === 'source' ? latest.pose.sourceAction : latest.pose.agentAction };
      actor.cue(latest ? p.kind === 'source' ? latest.pose.sourceRow : latest.pose.agentRow : pose.row, speech, !!latest && latest.pose.holding === p.kind, pose);
    }
    const currentTaskKeys = new Set(taskPets.map(({ task }) => task.key));
    for (const key of taskWalks.current.keys()) if (!currentTaskKeys.has(key)) taskWalks.current.delete(key);
    const taskObstacles: Rect[] = [...occupied];
    for (const { event, pose } of poses) {
      if (pose.holding !== 'source' && pose.holding !== 'agent') continue;
      const holder = actors.current.get(pose.holding === 'source' ? `source:${event.task.sourceId}` : `agent:${event.task.agent}`)?.hand();
      if (holder) taskObstacles.push({ x: holder.x - 68, y: holder.y - 18, width: 136, height: 36 });
    }
    const taskFootprint = (point: Point, size: PetSize, sideCard: boolean): Rect => {
      const hand = point.x + size.width * .58;
      const cardLeft = sideCard ? hand + 68 > g.bounds.x ? hand - 68 : hand : hand - 34;
      const x = Math.min(point.x, cardLeft), right = Math.max(point.x + size.width, cardLeft + 68);
      return { x, y: point.y, width: right - x, height: size.height + size.tagHeight };
    };
    const freePost = (target: Point, size: PetSize, sideCard: boolean) => {
      const candidates = [target, ...taskObstacles.flatMap(rect => [
        { x: rect.x - size.width - 68 - 12, y: target.y }, { x: rect.x + rect.width + 12, y: target.y },
        { x: target.x, y: rect.y - size.height - size.tagHeight - 12 }, { x: target.x, y: rect.y + rect.height + 12 },
      ])].map(point => boundPet(point, g.bounds.x, g.bounds.y, g.bounds.top, size));
      return candidates.sort((a, b) => Math.hypot(a.x - target.x, a.y - target.y) - Math.hypot(b.x - target.x, b.y - target.y))
        .find(point => taskObstacles.every(rect => !overlaps(taskFootprint(point, size, sideCard), rect)));
    };
    for (const { task, pet, p } of taskPets) {
      const actor = actors.current.get(`task:${task.key}`); if (!actor || !assets[pet.key]) continue;
      const latest = [...poses].reverse().find(({ event }) => event.task.key === task.key);
      const size = petSize('task', p.brand === 'other');
      const main = actors.current.get(p.id)?.point();
      const returning = presentPet(engaged.current.get(`task:${task.key}`) ?? now, false, time, pendingRelayUntil(task, events.current)).returning;
      const anchor = g.task(task.agent, task.taskId, task.accountId ?? undefined);
      const mainSize = petSize('participant', p.brand === 'other');
      const neighbor = main ? { x: anchor && anchor.x < main.x ? main.x - mainSize.width / 2 - size.width - 16 : main.x + mainSize.width / 2 + 16,
        y: main.y + mainSize.height / 2 - size.height } : g.participant(p, task.accountId ?? undefined, size);
      const start = neighbor && freePost(neighbor, size, !!pet.mascot);
      const feet = pet.mascot ? mascotAnchors(pet.mascot).feet.y : 1;
      const dock = anchor && taskPost({ x: anchor.x, y: anchor.y + size.height * (1 - feet) }, size);
      const desired = (motion.animate && latest?.pose.taskAtAgent) || returning ? start : dock;
      let point = desired && freePost(desired, size, !!pet.mascot);
      if (!point) { actor.hide(); taskWalks.current.delete(task.key); continue; }
      const freeToWalk = motion.animate && task.state !== 'needsYou' && actor.available();
      if (freeToWalk) {
        const center = actor.point(), from = center ? topLeft(center, size) : start ?? point;
        let walk = taskWalks.current.get(task.key);
        const obstacles = taskObstacles.map(rect => [Math.round(rect.x / 16), Math.round(rect.y / 16), rect.width, rect.height].join(',')).join('|');
        if (!walk || Math.hypot(walk.home.x - point.x, walk.home.y - point.y) > 16) {
          walk = { home: point, path: [], next: 0, docked: false, obstacles }; taskWalks.current.set(task.key, walk);
        } else if (walk.path.length && walk.obstacles !== obstacles) {
          walk.path = g.route(from, walk.path[walk.path.length - 1], size, taskObstacles) ?? [];
          walk.obstacles = obstacles;
        }
        while (walk.path.length && Math.hypot(walk.path[0].x - from.x, walk.path[0].y - from.y) < 4) {
          walk.path.shift(); if (!walk.path.length) { walk.docked = true; walk.next = time + 3000 + Math.random() * 5000; }
        }
        if (!walk.path.length && time >= walk.next) {
          const bubble = g.taskFrame(task.agent, task.taskId);
          const destination = latest || returning || !walk.docked || !bubble ? point : freePost(bubbleWander(bubble, g.bounds, size), size, !!pet.mascot) ?? point;
          walk.path = g.route(from, destination, size, taskObstacles) ?? [];
          walk.obstacles = obstacles;
          walk.next = time + 2000;
        }
        point = walk.path[0] ?? from;
      } else {
        taskWalks.current.delete(task.key);
        const current = actor.point();
        if (motion.animate && !latest && !returning && current) point = topLeft(current, size);
      }
      const pose = { ...behavior(`task:${task.key}`, task, false, time) };
      if (latest) pose.action = latest.pose.taskAction;
      else if (freeToWalk && taskWalks.current.get(task.key)?.path.length) pose.action = 'carry';
      actor.place(point, g.bounds, motion.animate ? start : undefined, freeToWalk); actor.cue(latest?.pose.taskRow ?? pose.row, undefined, !latest || latest.pose.holding === 'task', pose); petCount++; taskPetCount++;
      const placed = actor.point();
      if (placed) taskObstacles.push(taskFootprint(topLeft(placed, size), size, !!pet.mascot));
    }
    counts.current = { petCount, animatedPetCount: motion.animate ? petCount : 0, taskPetCount, movingCardCount: 0 };
    paintVisuals();
    clearTimeout(cueTimer.current);
    if (motion.visible) {
      const deadlines = events.current.flatMap(event => RELAY_CUES.map(offset => event.at + offset - time)).filter(delay => delay > 0);
      if (social.current) deadlines.push(...[600, 3100, 5600, 8000].map(offset => social.current!.at + offset - time).filter(delay => delay > 0));
      if (motion.animate && ([...taskWalks.current.values()].some(walk => walk.path.length) || [...scenes.current.values()].some(scene => scene.action && !scene.action.arrived))) deadlines.push(100);
      if (relayClock.current?.waitingSince !== undefined) deadlines.push(100);
      if (deadlines.length) {
        const delay = Math.min(...deadlines);
        const switchPair = events.current.some(event => event.at - time === delay || event.at + RELAY_MS - time === delay);
        cueTimer.current = setTimeout(() => { if (switchPair) setNow(Date.now()); latestLayout.current(); }, delay);
      }
    }
  }
  function paintVisuals() {
    const g = cachedGeometry.current;
    if (!g) return;
    const time = Date.now();
    const poses = events.current.filter(event => event.at <= time && time - event.at < RELAY_MS).map(event => ({ event, pose: relayPose(event, time) }));
    for (const [id, since] of tugs.current) {
      const elapsed = time - since;
      g.feedback?.(id, motion.animate ? Math.sin(elapsed / 290) * Math.min(1, elapsed / 400) : 0);
      feedbackTargets.current.add(id);
    }
    const liveCards = new Set<string>();
    const encounter = social.current;
    if (motion.animate && encounter && encounter.kind === 1 && cards.current) {
      const elapsed = time - encounter.at;
      if (elapsed >= 600 && elapsed < 5600) {
        const returning = elapsed >= 3100;
        const point = arcPoint(returning ? encounter.agentPoint : encounter.sourcePoint, returning ? encounter.sourcePoint : encounter.agentPoint, ((elapsed - 600) % 2500) / 2500);
        const id = 'social'; let el = cardElements.current.get(id);
        if (!el) { el = document.createElement('span'); el.className = 'pet-play-token'; el.textContent = '✦'; el.setAttribute('aria-hidden', 'true'); cards.current.append(el); cardElements.current.set(id, el); }
        el.style.transform = `translate(${point.x}px, ${Math.max(g.bounds.top, point.y)}px) rotate(${elapsed / 4}deg)`; liveCards.add(id);
      }
    }
    if (motion.animate && enabled && relayClock.current?.waitingSince === undefined) for (const { event, pose } of poses) {
      if (!pose.card) continue;
      // Missing installed participants do not manufacture a relay card.
      const sourceActor = actors.current.get(`source:${event.task.sourceId}`), agentActor = actors.current.get(`agent:${event.task.agent}`), taskActor = actors.current.get(`task:${event.task.key}`);
      const source = sourceActor?.hand(), agent = agentActor?.hand();
      const task = taskActor?.hand();
      const from = pose.card.from === 'source' ? source : pose.card.from === 'agent' ? agent : task;
      const to = pose.card.to === 'source' ? source : pose.card.to === 'agent' ? agent : task;
      if (!from || !to || !cards.current) continue;
      let el = cardElements.current.get(event.id);
      if (!el) { el = document.createElement('span'); el.className = 'pet-card'; el.setAttribute('aria-hidden', 'true'); cards.current.append(el); cardElements.current.set(event.id, el); }
      const title = event.task.title || tracked[event.task.agent]?.find(session => session.id === event.task.taskId)?.title || event.task.agent;
      if (el.textContent !== title) el.textContent = title;
      el.style.setProperty('--pet-task-color', taskColor(event.task.key));
      const point = arcPoint(from, to, pose.card.progress);
      el.style.transform = `translate(${Math.max(0, Math.min(g.bounds.x - 112, point.x - 56))}px, ${Math.max(g.bounds.top, point.y - 14)}px) rotate(${pose.card.progress * 12 - 6}deg)`; el.dataset.tone = pose.card.tone;
      liveCards.add(event.id);
    }
    for (const [id, el] of cardElements.current) if (!liveCards.has(id)) { el.remove(); cardElements.current.delete(id); }
    setPetSnapshot({ ...counts.current, movingCardCount: liveCards.size - Number(liveCards.has('social')) });
    if (motion.animate && (liveCards.size || tugs.current.size) && !frame.current) frame.current = requestAnimationFrame(() => { frame.current = 0; latestVisuals.current(); });
  }
  const latestVisuals = useRef(paintVisuals); latestVisuals.current = paintVisuals;
  latestLayout.current = layout;
  useImperativeHandle(ref, () => ({ layout: () => layout(true) }));
  useEffect(() => { layout(true); return () => { cancelAnimationFrame(frame.current); clearTimeout(cueTimer.current); frame.current = 0; }; });
  useEffect(() => () => { for (const id of feedbackTargets.current) geometry().feedback?.(id, 0); setPetSnapshot({ petCount: 0, animatedPetCount: 0, taskPetCount: 0, movingCardCount: 0 }); }, []);
  const actorRef = (id: string) => (handle: PetActorHandle | null) => { if (handle) actors.current.set(id, handle); else actors.current.delete(id); };
  return <>
    {rendered.map(({ p, pet }) => assets[pet.key] && <PetActor key={p.id} ref={actorRef(p.id)} size={petSize('participant', p.brand === 'other')} pet={pet} url={assets[pet.key]} taskTitle={episode?.task.title} taskColor={episode ? taskColor(episode.task.key) : undefined} cardTone={episode?.task.state === 'done' ? 'success' : episode && ['failed', 'interrupted'].includes(episode.task.state) ? 'danger' : undefined} label={t('pets.participantPet', { name: p.name })} tag={p.brand === 'other' ? p.name : undefined} animate={motion.animate} slow={!active} roam />)}
    {taskPets.map(({ task, session, p, pet }) => assets[pet.key] && <PetActor key={`task:${task.key}:${task.turn}`} ref={actorRef(`task:${task.key}`)} size={petSize('task', p.brand === 'other')} pet={pet} url={assets[pet.key]} row={taskPetRow(task.state)} taskTitle={session.title ?? p.name} taskColor={taskColor(task.key)} cardTone={task.state === 'done' ? 'success' : ['failed', 'interrupted'].includes(task.state) ? 'danger' : 'neutral'} label={t('pets.taskPet', { name: session.title ?? p.name })} tag={p.brand === 'other' ? p.name : undefined} animate={motion.animate} slow={!active} roam manualPause={2000}
      onClick={() => selectAgentPanel({ type: 'task', agent: task.agent, session })} />)}
    <div ref={cards} className="pet-cards" aria-hidden="true" />
  </>;
}
