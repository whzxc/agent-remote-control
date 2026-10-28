import { useEffect, useImperativeHandle, useRef, type Ref } from 'react';
import { connector, orderedSources } from '../state/connector';
import { agents, name } from '../state/agents';
import { tasks } from '../state/tasks';
import { trackedActivity } from '../state/activityBubbles';
import { petBrand, selectPet, type Participant, type Point } from './model';
import { petAssignments, petAssets, petAsset, petLibrary, refreshPets, showPets } from './state';
import PetActor, { type PetActorHandle } from './PetActor';
import { usePetMotion } from './usePetMotion';
export interface PetGeometry { participant: (p: Participant, accountId?: string) => Point | undefined; task: (agent: string, id: string) => Point | undefined; bounds: Point & { top: number } }
export interface PetLayerHandle { layout: () => void }
export default function PetLayer({ geometry, ref }: { geometry: () => PetGeometry; ref: Ref<PetLayerHandle> }) {
  const enabled = showPets.use(), library = petLibrary.use(), assignments = petAssignments.use(), assets = petAssets.use();
  const agentState = agents.use(), records = tasks.use().records, tracked = trackedActivity.use(); connector.use();
  const motion = usePetMotion(), actors = useRef(new Map<string, PetActorHandle>()), speech = useRef(new Map<string, number>());
  const sources = orderedSources();
  const participants: Participant[] = [
    ...sources.map(s => ({ id: `source:${s.id}`, nativeId: s.id, name: s.label, kind: 'source' as const, brand: petBrand(s.product) })),
    ...agentState.items.map(a => ({ id: `agent:${a.agent}`, nativeId: a.agent, name: name(a), kind: 'agent' as const, brand: petBrand(a.agent) })),
  ];
  const latest = records.filter(r => r.agent).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const active = new Set(Object.entries(tracked).flatMap(([agent, sessions]) => sessions.flatMap(s => [`agent:${agent}`, ...(s.origin?.sourceId ? [`source:${s.origin.sourceId}`] : [])])));
  if (latest) { active.add(`agent:${latest.agent}`); if (latest.origin?.sourceId) active.add(`source:${latest.origin.sourceId}`); }
  const rendered = enabled ? participants.filter(p => active.has(p.id)).flatMap(p => { const pet = selectPet(p, library.packages, assignments); return pet ? [{ p, pet }] : []; }) : [];
  useEffect(() => { if (enabled) void refreshPets(); }, [enabled]);
  const keys = rendered.map(r => r.pet.key).join('|');
  useEffect(() => { for (const { pet } of rendered) void petAsset(pet.key).catch(() => {}); }, [keys]);
  function layout() {
    const g = geometry();
    for (const { p } of rendered) { const point = g.participant(p); if (point) actors.current.get(p.id)?.place({ x: point.x - 36, y: point.y - 78 }, g.bounds); }
  }
  useImperativeHandle(ref, () => ({ layout }));
  useEffect(layout);
  const running = Object.values(tracked).some(s => s.some(x => !x.endedAt));
  return <>{rendered.map(({ p, pet }) => assets[pet.key] && <PetActor key={p.id} ref={handle => { if (handle) actors.current.set(p.id, handle); else actors.current.delete(p.id); }}
    pet={pet} url={assets[pet.key]} label={p.name} tag={p.brand === 'other' ? p.name : undefined} animate={motion.animate} slow={!running}
    speak={() => { const pair = latest ? `${latest.origin?.sourceId}:${latest.agent}` : p.id, now = Date.now(); if (now - (speech.current.get(pair) ?? -Infinity) < 30000) return false; speech.current.set(pair, now); return true; }} />)}</>;
}
