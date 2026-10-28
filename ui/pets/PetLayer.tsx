import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { api } from '../api';
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
import { arcPoint, maySpeak, petIntents, presentPet, relayPose, taskPetRow, type PetIntent, type RelayTask } from './relay';
import { petSize, taskPost, type PetSize } from './geometry';
import { setPetSnapshot } from './snapshot';
import PetActor, { type PetActorHandle } from './PetActor';
import { usePetMotion } from './usePetMotion';
export interface PetGeometry { participant: (p: Participant, accountId?: string, size?: PetSize) => Point | undefined; task: (agent: string, id: string, accountId?: string) => Point | undefined; bounds: Point & { top: number } }
export interface PetLayerHandle { layout: () => void }
export default function PetLayer({ geometry, ref }: { geometry: () => PetGeometry; ref: Ref<PetLayerHandle> }) {
  const enabled = showPets.use(), library = petLibrary.use(), assignments = petAssignments.use(), assets = petAssets.use();
  const agentState = agents.use(), records = tasks.use().records, tracked = trackedActivity.use(), submissions = activityApprovals.use(); connector.use(); taskExecutions.use();
  const motion = usePetMotion(), actors = useRef(new Map<string, PetActorHandle>()), speech = useRef(new Map<string, number>());
  const [now, setNow] = useState(Date.now), [reviews, setReviews] = useState<Record<string, TaskReview>>({});
  const previous = useRef(new Map<string, RelayTask>()), seen = useRef(new Set<string>()), events = useRef<PetIntent[]>([]);
  const engaged = useRef(new Map<string, number>()), cards = useRef<HTMLDivElement>(null), cardElements = useRef(new Map<string, HTMLSpanElement>());
  const cueTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const frame = useRef(0), latestLayout = useRef(() => {});
  const sources = orderedSources();
  const participants: Participant[] = [
    ...sources.map(s => ({ id: `source:${s.id}`, nativeId: s.id, name: s.label, kind: 'source' as const, brand: petBrand(s.product) })),
    ...agentState.items.map(a => ({ id: `agent:${a.agent}`, nativeId: a.agent, name: name(a), kind: 'agent' as const, brand: petBrand(a.agent) })),
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
  const latestDispatch = orderedRecords.find(record => record.agent && record.origin?.sourceId && ['completed', 'submitted', 'running', 'accepted'].includes(record.state));
  const candidates = [...relayTasks];
  if (latestDispatch) candidates.push({ key: latestDispatch.requestId, taskId: '', agent: latestDispatch.agent!, sourceId: latestDispatch.origin!.sourceId, turn: '', state: 'unknown', at: Date.parse(latestDispatch.createdAt) });
  const newest = candidates.filter(task => task.sourceId).sort((a, b) => b.at - a.at)[0];
  const resident = useRef<{ source: string; agent: string; at: number } | undefined>(undefined);
  if (newest && (!resident.current || newest.at >= resident.current.at)) resident.current = { source: `source:${newest.sourceId}`, agent: `agent:${newest.agent}`, at: newest.at };
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
      for (const id of [`agent:${task.agent}`, ...(task.sourceId ? [`source:${task.sourceId}`] : []), `task:${task.key}`]) {
        if (!engaged.current.has(id) || ['running', 'needsYou'].includes(task.state) || before?.state !== task.state || before?.review?.id !== task.review?.id) engaged.current.set(id, changedAt);
      }
    }
    // A timer proposes stable stall intents; the event identity prevents repeated urging for one phase.
    setNow(changedAt); latestLayout.current();
  }, [enabled, dataKey]);
  useEffect(() => {
    if (!enabled || !motion.visible) return;
    const tick = () => {
      const time = Date.now();
      for (const task of relayTasks) {
        if (['running', 'needsYou'].includes(task.state)) for (const id of [`agent:${task.agent}`, `source:${task.sourceId}`, `task:${task.key}`]) engaged.current.set(id, time);
        for (const event of petIntents(task, previous.current.get(task.key), time)) enqueue(event);
      }
      setNow(time); latestLayout.current();
    };
    const timer = setInterval(tick, active ? 1000 : 5000);
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
  const isResident = (id: string) => id === resident.current?.source || id === resident.current?.agent;
  const rendered = enabled ? participants.filter(p => relayTasks.some(task => ['running', 'needsYou'].includes(task.state) && (p.kind === 'source' ? task.sourceId === p.nativeId : task.agent === p.nativeId)) || presentPet(engaged.current.get(p.id) ?? -Infinity, isResident(p.id), now).present).flatMap(p => {
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
  const participantPair = (p: Participant) => {
    const task = [...relayTasks].sort((a, b) => b.at - a.at).find(task => p.kind === 'agent' ? task.agent === p.nativeId : task.sourceId === p.nativeId);
    return task ? pairKey(task) : p.id;
  };
  function layout() {
    if (!enabled) {
      for (const el of cardElements.current.values()) el.remove();
      cardElements.current.clear();
      setPetSnapshot({ petCount: 0, animatedPetCount: 0, taskPetCount: 0, movingCardCount: 0 });
      return;
    }
    const g = geometry(), time = Date.now();
    events.current = events.current.filter(event => time - event.at < 4000);
    const poses = events.current.filter(event => event.at <= time).map(event => ({ event, pose: relayPose(event, time) }));
    const nodePoint = (kind: 'agent' | 'source', task: RelayTask, size: PetSize) => {
      const p = participantFor(kind, kind === 'agent' ? task.agent : task.sourceId);
      return p && g.participant(p, kind === 'agent' ? task.accountId ?? undefined : undefined, size);
    };
    let petCount = 0, taskPetCount = 0;
    for (const { p, pet } of rendered) {
      const actor = actors.current.get(p.id); if (!actor || !assets[pet.key]) continue;
      const latest = [...poses].reverse().find(({ event }) => p.kind === 'source' ? event.task.sourceId === p.nativeId : event.task.agent === p.nativeId);
      const size = petSize('participant', p.brand === 'other');
      const atAgent = motion.animate && latest && p.kind === 'source' && latest.pose.sourceAtAgent && nodePoint('agent', latest.event.task, size);
      const point = atAgent || g.participant(p, undefined, size);
      if (!point) { actor.hide(); continue; }
      actor.place(point, g.bounds); petCount++;
      const activeTask = relayTasks.find(task => task.agent === p.nativeId && ['running', 'needsYou', 'unknown'].includes(task.state));
      actor.cue(latest ? p.kind === 'source' ? latest.pose.sourceRow : latest.pose.agentRow : p.kind === 'agent' && activeTask ? taskPetRow(activeTask.state) : 0,
        motion.visible && latest?.pose.speech && p.kind === 'source' && allowSpeech(pairKey(latest.event.task)) ? t(`pets.${latest.pose.speech}`) : undefined);
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
      actor.place(point, g.bounds, motion.animate ? start : undefined); actor.cue(taskPetRow(task.state), undefined, !motion.animate || !latest?.pose.card); petCount++; taskPetCount++;
    }
    const liveCards = new Set<string>();
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
    setPetSnapshot({ petCount, animatedPetCount: motion.animate ? petCount : 0, taskPetCount, movingCardCount: liveCards.size });
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
    {rendered.map(({ p, pet }) => assets[pet.key] && <PetActor key={p.id} ref={actorRef(p.id)} size={petSize('participant', p.brand === 'other')} pet={pet} url={assets[pet.key]} label={t('pets.participantPet', { name: p.name })} tag={p.brand === 'other' ? p.name : undefined} animate={motion.animate} slow={!active} speak={() => allowSpeech(participantPair(p))} />)}
    {taskPets.map(({ task, session, p, pet }) => assets[pet.key] && <PetActor key={`task:${task.key}:${task.turn}`} ref={actorRef(`task:${task.key}`)} size={petSize('task', p.brand === 'other')} pet={pet} url={assets[pet.key]} row={taskPetRow(task.state)} cardTone={task.state === 'done' ? 'success' : ['failed', 'interrupted'].includes(task.state) ? 'danger' : 'neutral'} label={t('pets.taskPet', { name: session.title ?? p.name })} tag={p.brand === 'other' ? p.name : undefined} animate={motion.animate} slow={!active}
      onClick={() => selectAgentPanel({ type: 'task', agent: task.agent, session })} speak={() => allowSpeech(pairKey(task))} />)}
    <div ref={cards} className="pet-cards" aria-hidden="true" />
  </>;
}
