import type { TaskCardData, OriginStep } from '../modules/tasks';

// Fictional task content and device identities. Native task storage stays runtime-owned.
const studio: OriginStep = { label: 'Studio account', icon: 'user-round' };
const work: OriginStep = { label: 'Work profile', icon: 'user-round' };
const chatgpt: OriginStep = { label: 'ChatGPT', brand: 'openai' };
const claude: OriginStep = { label: 'Claude', brand: 'claude' };
const controller: OriginStep = { label: 'Anchor Mac · controller', icon: 'monitor' };
const member: OriginStep = { label: 'Cedar Mac · LAN · 4 ms', icon: 'laptop' };
const codex: OriginStep = { label: 'Codex', brand: 'codex' };
const cc: OriginStep = { label: 'Claude Code', brand: 'claude-code' };
export const origins = {
  local: [chatgpt, codex, studio],
  localClaude: [claude, cc, work],
  remote: [controller, member, codex, studio],
  remoteClaude: [controller, member, cc, work],
  member: [controller, codex, studio],
  offline: [controller, { label: 'Moss Server · offline', icon: 'server' }, codex, work],
} satisfies Record<string, OriginStep[]>;
export const tasks: TaskCardData[] = [
  { id: 'window', node: 'cedar-codex', title: 'Choose the deployment window', group: 'needs-me',
    state: 'Needs input', detail: 'Staging or production?', icon: 'circle-help', origin: origins.remote },
  { id: 'approve', node: 'local-claude', title: 'Approve the migration', group: 'needs-me',
    state: 'Approval required', detail: 'Apply schema changes', icon: 'shield-question', origin: origins.localClaude },
  { id: 'queue', node: 'local-codex', title: 'Inspect the dispatch queue', group: 'running',
    state: 'Reading', detail: 'Queue state', icon: 'terminal', origin: origins.local },
  { id: 'review', node: 'cedar-codex', title: 'Review the workspace changes', group: 'running',
    state: 'Reading', detail: 'Diff · LAN · 4 ms', icon: 'file-search', origin: origins.remote },
  { id: 'report', node: 'local-codex', title: 'Summarize the queue', group: 'unread',
    state: 'Completed', detail: 'Unread', icon: 'check', origin: origins.local },
  { id: 'remote-report', node: 'cedar-claude', title: 'Review the configuration', group: 'unread',
    state: 'Completed', detail: 'Unread', icon: 'check', origin: origins.remoteClaude },
  { id: 'offline', node: 'moss-codex', title: 'Inspect the storage index', group: 'unconfirmed',
    state: 'Unconfirmed', detail: 'Last seen 18 min ago', icon: 'circle-help', origin: origins.offline },
];
export const memberTasks: TaskCardData[] = tasks.filter(t => t.node.startsWith('cedar-')).map(task => ({
  ...task,
  origin: [task.origin[0], ...task.origin.slice(2)],
  detail: task.group === 'running' ? 'Diff' : task.detail,
}));
export const groups = [
  { id: 'needs-me', title: 'Needs me', paint: 'text-warning' },
  { id: 'running', title: 'Running', paint: 'text-text' },
  { id: 'unread', title: 'Completed unread', paint: 'text-accent-text' },
  { id: 'unconfirmed', title: 'Unconfirmed', paint: 'text-text-secondary' },
] as const;
export const tasksCopy = {
  tasks: 'Tasks', empty: 'No tasks', open: 'Open task detail', markRead: 'Mark as read',
  more: 'More task actions', moveUp: 'Move up', moveDown: 'Move down',
  filter: 'Cedar Mac · Codex', clear: 'Clear node filter', filtered: 'Tasks for Cedar Mac · Codex',
  recent: 'Recent completed · 12',
};
export const screenForms = [
  { name: 'mixed', width: 1280, height: 800 },
  { name: 'empty', width: 1280, height: 800, empty: true },
  { name: 'focused-node', width: 1280, height: 800, focused: true },
  { name: 'member-origin', width: 1280, height: 800, member: true },
  { name: 'portrait', width: 640, height: 800 },
  { name: 'mobile', width: 390, height: 844 },
] as const;
