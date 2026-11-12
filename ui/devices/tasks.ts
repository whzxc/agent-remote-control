import { api } from '../api';
import { createStore } from '../state/store';
import type { Agent } from '../state/agents';
import type { AgentActivitySnapshot } from '../types';
import type { TaskRecord } from '../state/tasks';
import type { DeviceSnapshot } from './state';

export type DeviceTaskSnapshot = AgentActivitySnapshot & {
  availableAgents: Agent[];
  records: TaskRecord[];
  omittedRecords: number;
};
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function optionalStrings(value: Record<string, unknown>, keys: string[]) {
  return keys.every(key => value[key] == null || typeof value[key] === 'string');
}
export function deviceTaskSnapshot(value: unknown): DeviceTaskSnapshot {
  const valid = object(value) && typeof value.observedAt === 'string' && Array.isArray(value.activeAgents)
    && value.activeAgents.every(agent => typeof agent === 'string') && object(value.agents)
    && Object.values(value.agents).every(activity => object(activity) && Array.isArray(activity.sessions)
      && activity.sessions.every(session => object(session) && typeof session.id === 'string'
        && typeof session.headline === 'string' && typeof session.phase === 'string'
        && optionalStrings(session, ['title', 'fallbackHeadline', 'startedAt', 'turnStartedAt', 'turnId', 'agentAccountId'])
        && (session.interaction == null || object(session.interaction) && typeof session.interaction.summary === 'string'
          && object(session.interaction.respond))
        && (session.origin == null || object(session.origin) && optionalStrings(session.origin, ['sourceId', 'sourceLabel', 'deviceId']))
        && (session.dispatchSummary == null || object(session.dispatchSummary) && optionalStrings(session.dispatchSummary, ['model', 'effort', 'serviceTier', 'agentAccountId'])
          && (session.dispatchSummary.controlSource == null || object(session.dispatchSummary.controlSource) && optionalStrings(session.dispatchSummary.controlSource, ['id', 'label', 'kind', 'deviceId'])))))
    && Array.isArray(value.availableAgents) && value.availableAgents.every(agent => object(agent) && typeof agent.agent === 'string' && optionalStrings(agent, ['displayName', 'version']))
    && Array.isArray(value.records) && value.records.every(record => object(record) && object(record.task)
      && typeof record.createdAt === 'string' && optionalStrings(record, ['agent', 'taskId', 'threadId', 'turnId', 'agentAccountId'])
      && optionalStrings(record.task, ['title', 'prompt', 'threadId'])
      && (record.runtime == null || object(record.runtime) && optionalStrings(record.runtime, ['title', 'status', 'runtimeStatus'])))
    && Number.isInteger(value.omittedRecords) && Number(value.omittedRecords) >= 0;
  if (!valid) throw new Error('Invalid device/tasks response. Refresh the device after updating its Core.');
  return value as unknown as DeviceTaskSnapshot;
}
export type DeviceTaskObservation = { snapshot?: DeviceTaskSnapshot; error?: string };
export const deviceTasks = createStore<Record<string, DeviceTaskObservation>>({});
const pending = new Map<string, Promise<void>>();
const lastRead = new Map<string, number>();
let generation = 0;
let activeDevices = new Set<string>();
export function resetDeviceTasks() {
  generation++; activeDevices.clear();
  pending.clear(); lastRead.clear(); deviceTasks.set({});
}
export async function refreshDeviceTasks(devices: DeviceSnapshot) {
  const paired = new Set(devices.members.map(member => member.deviceId));
  activeDevices = paired;
  deviceTasks.set(old => Object.keys(old).some(id => !paired.has(id))
    ? Object.fromEntries(Object.entries(old).filter(([id]) => paired.has(id))) : old);
  const online = devices.devices?.filter(device => paired.has(device.id) && device.state === 'online') ?? [];
  const version = generation;
  for (let index = 0; index < online.length && version === generation; index += 4) {
    await Promise.allSettled(online.slice(index, index + 4).map(device => {
      if (pending.has(device.id) || performance.now() - (lastRead.get(device.id) ?? -Infinity) < 10000) return pending.get(device.id);
      lastRead.set(device.id, performance.now());
      const read = api<unknown>('device/tasks', 'POST', { device: device.id }).then(value => {
        const snapshot = deviceTaskSnapshot(value);
        if (version !== generation || !activeDevices.has(device.id)) return;
        deviceTasks.set(old => ({ ...old, [device.id]: { snapshot } }));
      }).catch(error => {
        if (version === generation && activeDevices.has(device.id)) deviceTasks.set(old => ({ ...old, [device.id]: { ...old[device.id], error: String(error) } }));
      }).finally(() => { if (pending.get(device.id) === read) pending.delete(device.id); });
      pending.set(device.id, read);
      return read;
    }));
  }
}
