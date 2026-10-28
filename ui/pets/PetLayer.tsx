import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
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
import { agentActivity, activityApprovals } from '../state/activity';
import { taskExecution, taskExecutions } from '../state/taskExecution';
import { activityState } from '../state/taskExecutionModel';
import { pendingSessions } from '../state/taskInteractions';
import { selectAgentPanel } from '../state/overviewPanels';
import type { TaskReview } from '../state/taskReview';
import { petBrand, selectPet, type Participant, type Point } from './model';
import { petAssignments, petAssets, petAsset, petLibrary, refreshPets, showPets } from './state';
import { arcPoint, maySpeak, petIntents, presentPet, relayPose, taskPetRow, type PetIntent, type RelayTask } from './relay';
import { petSize, taskPost, type PetSize } from './geometry';
import { setPetSnapshot } from './snapshot';
import PetActor, { type PetActorHandle } from './PetActor';
import { usePetMotion } from './usePetMotion';
import { activityPose, type PetPose } from './behavior';
import type { AgentPhase } from '../types';
export interface PetGeometry { participant: (p: Participant, accountId?: string, size?: PetSize) => Point | undefined; task: (agent: string, id: string, accountId?: string) => Point | undefined; bounds: Point & { top: number }; wander: (from: Point, size: PetSize, occupied: (Point & { width: number; height: number })[]) => Point | undefined }
export interface PetLayerHandle { layout: () => void }
export default function PetLayer({ geometry, ref }: { geometry: () => PetGeometry; ref: Ref<PetLayerHandle> }) {
  const enabled = showPets.use(), library = petLibrary.use(), assignments = petAssignments.use(), assets = petAssets.use();
  const agentState = agents.use(), records = tasks.use().records, tracked = trackedActivity.use(), submissions = activityApprovals.use();
  const { status } = connector.use(), activity = agentActivity.use().snapshot; taskExecutions.use();
  const motion = usePetMotion(), actors = useRef(new Map<string, PetActorHandle>()), speech = useRef(new Map<string, number>());
  const [now, setNow] = useState(Date.now), [reviews, setReviews] = useState<Record<string, TaskReview>>({});
  const previous = useRef(new Map<string, RelayTask>()), seen = useRef(new Set<string>()), events = useRef<PetIntent[]>([]);
  const engaged = useRef(new Map<string, number>()), cards = useRef<HTMLDivElement>(null), cardElements = useRef(new Map<string, HTMLSpanElement>());
  const cueTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const frame = useRef(0), latestLayout = useRef(() => {});
  const behaviors = useRef(new Map<string, { key: string; until: number; pose: PetPose }>());
  const walks = useRef(new Map<string, { point: Point; next: number }>());
  const social = useRef<{ source: string; agent: string; at: number; kind: number; sourcePoint: Point; agentPoint: Point; spoken: Set<string> } | undefined>(undefined);
  const nextSocial = useRef(Date.now() + 8000);
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
    return { key, taskId: session.id, agent, sourceId: session.origin?.sourceId ?? record?.origin?.sourceId ?? session.dispatchSummary?.controlSource?.id,
      accountId: accountRows.find(account => account.agentProfiles.some(profile => profile.agent === agent) && accountOwns(account, session.agentAccountId))?.id ?? session.agentAccountId, dispatchId: record?.requestId, turn: session.turnId ?? session.turnStartedAt ?? '', state,
      phaseSince: Date.parse(session.phaseSince ?? ''), at: Date.parse(record?.createdAt ?? session.turnStartedAt ?? session.startedAt ?? '') || 0,
      ...(review ? { review: { id: review.requestId, verdict: review.verdict } } : {}) };
  }));
  // Dispatches can precede the first observed execution. They create participants, never a fake task bubble.
  for (const record of orderedRecords) {
    if (!record.agent || !record.origin?.sourceId || relayTasks.some(task => task.dispatchId === record.requestId) || !['submitted', 'running', 'accepted'].includes(record.state)) continue;
    const taskId = record.taskId ?? record.open?.taskId ?? record.threadId;
    if (!taskId || relayTasks.some(task => task.agent === record.agent && task.taskId === taskId)) continue;
    relayTasks.push({ key: JSON.stringify([record.agent, taskId]), taskId, agent: record.agent, sourceId: record.origin.sourceId,
      dispatchId: record.requestId, turn: record.turnId ?? '', state: 'unknown', at: Date.parse(record.createdAt) });
  }
  // Keep actual activity clocks when a completed task leaves the bubble list.
  // Source and Agent recency are independent; a dispatch is only one signal.
  const lastActivity = useRef(new Map<string, number>());
  const observe = (id: string, at: number) => {
    if (Number.isFinite(at) && at > (lastActivity.current.get(id) ?? 0)) lastActivity.current.set(id, at);
  };
  for (const source of sources) observe(`source:${source.id}`, (source.lastSeenAt ?? 0) * 1000);
  for (const [agent, value] of Object.entries(activity?.agents ?? {})) {
    for (const session of value.sessions) {
      observe(`agent:${agent}`, Math.max(...[session.phaseSince, session.turnStartedAt, session.startedAt].map(value => Date.parse(value ?? '') || 0)));
    }
  }
  for (const task of relayTasks) {
    observe(`agent:${task.agent}`, Math.max(task.at, task.phaseSince || 0));
    if (task.sourceId) observe(`source:${task.sourceId}`, task.at);
  }
  for (const record of records) {
    if (!['completed', 'submitted', 'running', 'accepted'].includes(record.state)) continue;
    if (record.agent) observe(`agent:${record.agent}`, Date.parse(record.updatedAt || record.createdAt));
    if (record.origin?.sourceId) observe(`source:${record.origin.sourceId}`, Date.parse(record.createdAt));
  }
  const activeAgents = new Set(relayTasks.filter(task => ['running', 'needsYou'].includes(task.state)).map(task => `agent:${task.agent}`));
  const resident = new Set(['source', 'agent'].flatMap(kind => {
    const latest = participants.filter(p => p.kind === kind && lastActivity.current.has(p.id))
      .sort((a, b) => Number(activeAgents.has(b.id)) - Number(activeAgents.has(a.id)) || lastActivity.current.get(b.id)! - lastActivity.current.get(a.id)! || a.id.localeCompare(b.id))[0];
    return latest ? [latest.id] : [];
  }));
  const active = relayTasks.some(task => task.state === 'running' || task.state === 'needsYou');
  const dataKey = JSON.stringify(relayTasks);
  function enqueue(event: PetIntent) {
    if (seen.current.has(event.id)) return;
    seen.current.add(event.id);
    const previousEvent = events.current.filter(e => e.task.key === event.task.key && e.at + 4000 > event.at).at(-1);
    if (previousEvent && ['urge', 'praise', 'rework'].includes(event.kind)) event.at = previousEvent.at + 4000;
    else events.current = events.current.filter(e => e.task.key !== event.task.key);
    events.current.push(event);
  }
  useEffect(() => {
    if (!enabled) return;
    const changedAt = Date.now();
    for (const task of relayTasks) {
      const before = previous.current.get(task.key);
      for (const event of petIntents(task, before, changedAt)) {
        enqueue(event);
      }
      previous.current.set(task.key, task);
      const id = `task:${task.key}`;
      if (!engaged.current.has(id) || ['running', 'needsYou'].includes(task.state) || before?.state !== task.state || before?.review?.id !== task.review?.id) engaged.current.set(id, changedAt);
    }
    // A timer proposes stable stall intents; the event identity prevents repeated urging for one phase.
    setNow(changedAt); latestLayout.current();
  }, [enabled, dataKey]);
  useEffect(() => {
    if (!enabled || !motion.visible) return;
    const tick = () => {
      const time = Date.now();
      for (const task of relayTasks) {
        if (['running', 'needsYou'].includes(task.state)) engaged.current.set(`task:${task.key}`, time);
        for (const event of petIntents(task, previous.current.get(task.key), time)) enqueue(event);
      }
      setNow(time); latestLayout.current();
    };
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [enabled, motion.visible, active, dataKey]);
  const reviewIds = [...new Set(relayTasks.filter(task => ['done', 'failed', 'interrupted'].includes(task.state)).map(task => task.taskId))].sort().join('|');
  useEffect(() => {
    if (!enabled || !motion.visible || !reviewIds) return;
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      const result: Record<string, TaskReview> = {};
      for (const id of reviewIds.split('|')) {
        if (stopped) return;
        try { const value = await api<{ reviews: { turnId: string; review: TaskReview }[] }>('tasks/reviews', 'POST', { id });
          for (const row of value.reviews) result[JSON.stringify([id, row.turnId])] = row.review;
        } catch { /* Supplementary review unavailability never changes execution evidence. */ }
      }
      if (!stopped) { setReviews(old => JSON.stringify(old) === JSON.stringify(result) ? old : result); timer = setTimeout(read, 15000); }
    };
    void read(); return () => { stopped = true; clearTimeout(timer); };
  }, [enabled, motion.visible, reviewIds]);
  const participantFor = (kind: 'source' | 'agent', id: string | undefined) => participants.find(p => p.kind === kind && p.nativeId === id);
  const rendered = enabled ? participants.filter(p => resident.has(p.id)).flatMap(p => {
    const pet = selectPet(p, library.packages, assignments); return pet ? [{ p, pet }] : [];
  }) : [];
  const taskPets = enabled ? relayTasks.flatMap(task => {
    const session = tracked[task.agent]?.find(s => s.id === task.taskId), p = participantFor('agent', task.agent), pet = p && selectPet(p, library.packages, assignments);
    return p && pet && session && presentPet(engaged.current.get(`task:${task.key}`) ?? now, false, now).present ? [{ task, session, p, pet }] : [];
  }) : [];
  const keys = [...rendered, ...taskPets].map(r => r.pet.key).join('|');
  useEffect(() => { if (enabled) void refreshPets(); else { events.current = []; previous.current.clear(); seen.current.clear(); engaged.current.clear(); } }, [enabled]);
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
  function layout() {
    if (!enabled) {
      behaviors.current.clear(); walks.current.clear(); social.current = undefined; nextSocial.current = Date.now() + 8000;
      for (const el of cardElements.current.values()) el.remove();
      cardElements.current.clear();
      setPetSnapshot({ petCount: 0, animatedPetCount: 0, taskPetCount: 0, movingCardCount: 0 });
      return;
    }
    const g = geometry(), time = Date.now();
    const visibleIds = new Set([...rendered.map(({ p }) => p.id), ...taskPets.map(({ task }) => `task:${task.key}`)]);
    for (const id of behaviors.current.keys()) if (!visibleIds.has(id)) behaviors.current.delete(id);
    for (const id of walks.current.keys()) if (!visibleIds.has(id)) walks.current.delete(id);
    events.current = events.current.filter(event => time - event.at < 4000);
    const poses = events.current.filter(event => event.at <= time).map(event => ({ event, pose: relayPose(event, time) }));
    const nodePoint = (kind: 'agent' | 'source', task: RelayTask, size: PetSize) => {
      const p = participantFor(kind, kind === 'agent' ? task.agent : task.sourceId);
      return p && g.participant(p, kind === 'agent' ? task.accountId ?? undefined : undefined, size);
    };
    const center = (p: Participant) => actors.current.get(p.id)?.point();
    const topLeft = (point: Point, size: PetSize) => ({ x: point.x - size.width / 2, y: point.y - size.height / 2 });
    const occupied = rendered.flatMap(({ p }) => {
      const point = center(p), size = petSize('participant', p.brand === 'other');
      return point ? [{ id: p.id, ...topLeft(point, size), width: size.width, height: size.height + size.tagHeight }] : [];
    });
    if (!motion.animate || social.current && (time - social.current.at >= 8000 || !visibleIds.has(social.current.source) || !visibleIds.has(social.current.agent)
      || !actors.current.get(social.current.source)?.available() || !actors.current.get(social.current.agent)?.available()
      || poses.some(({ event }) => `source:${event.task.sourceId}` === social.current?.source || `agent:${event.task.agent}` === social.current?.agent))) social.current = undefined;
    if (motion.animate && !social.current && time >= nextSocial.current && !poses.length) {
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
      const atAgent = motion.animate && latest && p.kind === 'source' && latest.pose.sourceAtAgent && nodePoint('agent', latest.event.task, size);
      let point = atAgent || g.participant(p, undefined, size);
      if (!point) { actor.hide(); continue; }
      const encounter = social.current && [social.current.source, social.current.agent].includes(p.id) && !latest ? social.current : undefined;
      if (!actor.available() || latest || encounter) walks.current.delete(p.id);
      else if (motion.animate) {
        let walk = walks.current.get(p.id);
        if (!walk) { walk = { point: center(p) ? topLeft(center(p)!, size) : point, next: time + 4000 + Math.random() * 7000 }; walks.current.set(p.id, walk); }
        if (time >= walk.next) {
          const from = center(p) ? topLeft(center(p)!, size) : walk.point;
          walk.point = g.wander(from, size, occupied.filter(other => other.id !== p.id)) ?? from;
          walk.next = time + 6500 + Math.random() * 8000;
        }
        point = walk.point;
      } else point = walks.current.get(p.id)?.point ?? (center(p) ? topLeft(center(p)!, size) : point);
      if (!actor.available() && center(p)) point = topLeft(center(p)!, size);
      if (encounter) point = topLeft(p.id === encounter.source ? encounter.sourcePoint : encounter.agentPoint, size);
      actor.place(point, g.bounds, undefined, !latest); petCount++;
      const activeTask = relayTasks.find(task => (p.kind === 'agent' ? task.agent === p.nativeId : task.sourceId === p.nativeId) && ['running', 'needsYou', 'unknown'].includes(task.state));
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
      actor.cue(latest ? p.kind === 'source' ? latest.pose.sourceRow : latest.pose.agentRow : pose.row, speech, undefined, pose);
    }
    for (const { task, pet, p } of taskPets) {
      const actor = actors.current.get(`task:${task.key}`); if (!actor || !assets[pet.key]) continue;
      const latest = [...poses].reverse().find(({ event }) => event.task.key === task.key);
      const size = petSize('task', p.brand === 'other');
      const start = g.participant(p, task.accountId ?? undefined, size);
      const returning = presentPet(engaged.current.get(`task:${task.key}`) ?? now, false, time).returning;
      const anchor = g.task(task.agent, task.taskId, task.accountId ?? undefined);
      const point = (motion.animate && latest?.pose.taskAtAgent) || returning ? start : anchor && taskPost(anchor, size);
      if (!point) { actor.hide(); continue; }
      const pose = behavior(`task:${task.key}`, task, false, time);
      actor.place(point, g.bounds, motion.animate ? start : undefined); actor.cue(latest?.pose.taskRow ?? pose.row, undefined, !motion.animate || !latest?.pose.card, pose); petCount++; taskPetCount++;
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
    if (motion.animate && enabled) for (const { event, pose } of poses) {
      if (!pose.card) continue;
      // Missing installed participants do not manufacture a relay card.
      const source = actors.current.get(`source:${event.task.sourceId}`)?.point(), agent = actors.current.get(`agent:${event.task.agent}`)?.point();
      const task = g.task(event.task.agent, event.task.taskId, event.task.accountId ?? undefined);
      const from = pose.card.from === 'source' ? source : pose.card.from === 'agent' ? agent : task;
      const to = pose.card.to === 'source' ? source : agent;
      if (!from || !to || !cards.current) continue;
      let el = cardElements.current.get(event.id);
      if (!el) { el = document.createElement('span'); el.className = 'pet-card'; el.setAttribute('aria-hidden', 'true'); cards.current.append(el); cardElements.current.set(event.id, el); }
      const point = arcPoint(from, to, pose.card.progress);
      el.style.transform = `translate(${point.x}px, ${Math.max(g.bounds.top, point.y)}px) rotate(${pose.card.progress * 12 - 6}deg)`; el.dataset.tone = pose.card.tone;
      liveCards.add(event.id);
    }
    for (const [id, el] of cardElements.current) if (!liveCards.has(id)) { el.remove(); cardElements.current.delete(id); }
    setPetSnapshot({ petCount, animatedPetCount: motion.animate ? petCount : 0, taskPetCount, movingCardCount: liveCards.size - Number(liveCards.has('social')) });
    clearTimeout(cueTimer.current);
    if (motion.animate && liveCards.size && !frame.current) frame.current = requestAnimationFrame(() => { frame.current = 0; latestLayout.current(); });
    else if (motion.visible && events.current.length) {
      const deadlines = events.current.flatMap(event => [150, 650, 800, 900, 1000, 1300, 1700, 2100, 2500, 4000].map(offset => event.at + offset - time)).filter(delay => delay > 0);
      if (deadlines.length) cueTimer.current = setTimeout(() => latestLayout.current(), Math.min(...deadlines));
    }
  }
  latestLayout.current = layout;
  useImperativeHandle(ref, () => ({ layout }));
  useEffect(() => { layout(); return () => { cancelAnimationFrame(frame.current); clearTimeout(cueTimer.current); frame.current = 0; }; });
  useEffect(() => () => { setPetSnapshot({ petCount: 0, animatedPetCount: 0, taskPetCount: 0, movingCardCount: 0 }); }, []);
  const actorRef = (id: string) => (handle: PetActorHandle | null) => { if (handle) actors.current.set(id, handle); else actors.current.delete(id); };
  return <>
    {rendered.map(({ p, pet }) => assets[pet.key] && <PetActor key={p.id} ref={actorRef(p.id)} size={petSize('participant', p.brand === 'other')} pet={pet} url={assets[pet.key]} label={t('pets.participantPet', { name: p.name })} tag={p.brand === 'other' ? p.name : undefined} animate={motion.animate} slow={!active} roam />)}
    {taskPets.map(({ task, session, p, pet }) => assets[pet.key] && <PetActor key={`task:${task.key}:${task.turn}`} ref={actorRef(`task:${task.key}`)} size={petSize('task', p.brand === 'other')} pet={pet} url={assets[pet.key]} row={taskPetRow(task.state)} cardTone={task.state === 'done' ? 'success' : ['failed', 'interrupted'].includes(task.state) ? 'danger' : 'neutral'} label={t('pets.taskPet', { name: session.title ?? p.name })} tag={p.brand === 'other' ? p.name : undefined} animate={motion.animate} slow={!active}
      onClick={() => selectAgentPanel({ type: 'task', agent: task.agent, session })} />)}
    <div ref={cards} className="pet-cards" aria-hidden="true" />
  </>;
}
