import { createStore } from './store';

export type HomepageMode = 'topology' | 'tasks';
export type NodeTaskFocus = { id: string; label: string; agent?: string; accountId?: string; sourceIds?: string[]; upstreamSourceId?: string; deviceId?: string };
function savedMode(): HomepageMode {
  try { return JSON.parse(localStorage.getItem('arc.homepage-mode') ?? 'null') === 'tasks' ? 'tasks' : 'topology'; }
  catch { return 'topology'; }
}
export const homepageMode = createStore<HomepageMode>(savedMode());
homepageMode.subscribe(() => { try { localStorage.setItem('arc.homepage-mode', JSON.stringify(homepageMode.get())); } catch { /* Retain the viewer's current mode when storage is unavailable. */ } });
window.addEventListener('storage', event => { if (event.key === 'arc.homepage-mode') homepageMode.set(savedMode()); });
export const homepageTaskFocus = createStore<NodeTaskFocus | undefined>(undefined);
export function selectHomepageMode(mode: HomepageMode) {
  homepageTaskFocus.set(undefined);
  homepageMode.set(mode);
}
export function focusNodeTasks(focus: NodeTaskFocus) {
  homepageTaskFilter.set('all');
  homepageTaskFocus.set(focus);
  homepageMode.set('tasks');
}

export const homepageRemoteReads = createStore<string[]>(readRemoteReads());
function readRemoteReads(): string[] {
  try { const value = JSON.parse(localStorage.getItem('arc.remote-task-reads') ?? '[]'); return Array.isArray(value) ? value.filter(item => typeof item === 'string').slice(-1000) : []; }
  catch { return []; }
}
homepageRemoteReads.subscribe(() => { try { localStorage.setItem('arc.remote-task-reads', JSON.stringify(homepageRemoteReads.get())); } catch { /* Keep the current viewer's acknowledgements in memory. */ } });
export const remoteTaskPanel = createStore<{ key: string } | undefined>(undefined);

export type TaskLayout = 'tile' | 'stack';
export type TaskFilter = 'all' | 'running' | 'waiting' | 'completed' | 'unconfirmed';
function savedLayout(): TaskLayout {
  try { return JSON.parse(localStorage.getItem('arc.homepage-task-layout') ?? 'null') === 'stack' ? 'stack' : 'tile'; }
  catch { return 'tile'; }
}
export const homepageTaskLayout = createStore<TaskLayout>(savedLayout());
homepageTaskLayout.subscribe(() => { try { localStorage.setItem('arc.homepage-task-layout', JSON.stringify(homepageTaskLayout.get())); } catch { /* Keep the current layout in memory. */ } });
window.addEventListener('storage', event => { if (event.key === 'arc.homepage-task-layout') homepageTaskLayout.set(savedLayout()); });
export const homepageTaskFilter = createStore<TaskFilter>('all');
