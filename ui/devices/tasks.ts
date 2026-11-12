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
      const read = api<DeviceTaskSnapshot>('device/tasks', 'POST', { device: device.id }).then(snapshot => {
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
