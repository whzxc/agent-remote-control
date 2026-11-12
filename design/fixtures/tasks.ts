import type { TaskCardData, OriginStep } from '../modules/tasks';
import { recentSteps, activitySamples } from './task-activity';

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
const baseTasks: TaskCardData[] = [
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
const details: Record<string, Partial<TaskCardData>> = {
  window: { elapsed: '01:48', activity: 'Waiting for your deployment choice', action: 'answer',
    steps: recentSteps.slice(0, 3), plan: { completed: 1, total: 3, current: 'Select the target environment' },
    change: { kind: 'file', summary: 'config/deploy.toml', output: 'Target environment is required before proceeding.' },
    path: 'LAN · 4 ms' },
  approve: { elapsed: '02:16', activity: 'Waiting for permission to apply the migration', action: 'approve',
    steps: recentSteps.slice(0, 2),
    change: { kind: 'command', summary: 'db migrate --apply', output: 'Apply the prepared schema migration.' } },
  queue: { elapsed: '03:24', activity: 'Reviewing queue ordering after the edit',
    steps: recentSteps, plan: activitySamples.plan, change: activitySamples.change },
  review: { elapsed: '02:42', activity: 'Checking the file changes against the plan', steps: recentSteps,
    plan: { completed: 2, total: 3, current: 'Review the remaining diff' },
    change: { kind: 'diff', summary: 'src/dispatch.rs', added: 24, removed: 8 }, path: 'LAN · 4 ms' },
  report: { elapsed: '02:36', activity: 'Queue summary is ready',
    change: { kind: 'file', summary: 'queue-summary.md', output: 'Recorded the ordering rules and pending request handling.' } },
  'remote-report': { elapsed: '01:52', activity: 'Configuration review is ready', path: 'LAN · 4 ms',
    change: { kind: 'diff', summary: 'config/agents.toml', added: 6, removed: 2 } },
  offline: { activity: 'Last observation unavailable',
    change: { kind: 'command', summary: 'index scan --verify', output: 'Last recorded request; result is unconfirmed.' } },
};
export const tasks: TaskCardData[] = baseTasks.map(task => ({ ...task, ...details[task.id] }));
tasks.splice(4, 0, {
  id: 'tunnel', node: 'quartz-codex', title: 'Validate the build configuration', group: 'running',
  state: 'Running command', detail: 'cargo check --lib', activity: 'Checking the build configuration',
  icon: 'terminal', elapsed: '01:08', path: 'Tunnel · 82 ms', partial: true,
  origin: [{ label: 'Anchor Mac · controller', icon: 'monitor' }, { label: 'Quartz PC · Tunnel', icon: 'monitor' },
    { label: 'Codex', brand: 'codex' }, { label: 'Work account', icon: 'user-round' }],
  steps: [...recentSteps.slice(0, 3), { kind: 'command', text: 'cargo check --lib', status: 'running' }],
  change: { kind: 'command', summary: 'cargo check --lib', output: 'Checking workspace packages…' },
});
export const memberTasks: TaskCardData[] = tasks.filter(t => t.node.startsWith('cedar-')).map(task => ({
  ...task,
  origin: [task.origin[0], ...task.origin.slice(2)],
  detail: task.group === 'running' ? 'Diff' : task.detail, path: undefined,
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
  recent: 'Recent completed · 12', answer: 'Answer…', approve: 'Review approval…',
  activity: 'Activity', hideActivity: 'Hide activity', partial: 'Partial history',
};
export const screenForms = [
  { name: 'wide-landscape', width: 1600, height: 1000, density: 'wide' },
  { name: 'standard-landscape', width: 1280, height: 800, density: 'standard' },
  { name: 'empty', width: 1280, height: 800, density: 'standard', empty: true },
  { name: 'focused-node', width: 1280, height: 800, density: 'standard', focused: true },
  { name: 'member-origin', width: 1280, height: 800, density: 'standard', member: true },
  { name: 'portrait', width: 640, height: 800, density: 'compact' },
  { name: 'portrait-expanded', width: 640, height: 800, density: 'compact', expanded: true },
  { name: 'mobile', width: 390, height: 844, density: 'compact' },
  { name: 'mobile-expanded', width: 390, height: 844, density: 'compact', expanded: true },
] as const;
export const cardForms = [
  { name: 'input-wide', id: 'window', width: 500, density: 'wide' },
  { name: 'approval-wide', id: 'approve', width: 500, density: 'wide' },
  { name: 'local-wide', id: 'queue', width: 500, density: 'wide' },
  { name: 'remote-lan-wide', id: 'review', width: 500, density: 'wide' },
  { name: 'remote-tunnel-wide', id: 'tunnel', width: 500, density: 'wide' },
  { name: 'unread-wide', id: 'report', width: 500, density: 'wide' },
  { name: 'unconfirmed-wide', id: 'offline', width: 500, density: 'wide' },
  { name: 'standard', id: 'queue', width: 440, density: 'standard' },
  { name: 'portrait-collapsed', id: 'queue', width: 592, density: 'compact' },
  { name: 'portrait-expanded', id: 'queue', width: 592, density: 'compact', expanded: true },
  { name: 'mobile-collapsed', id: 'queue', width: 358, density: 'compact' },
  { name: 'mobile-expanded', id: 'queue', width: 358, density: 'compact', expanded: true },
] as const;
