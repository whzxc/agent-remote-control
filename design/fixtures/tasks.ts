import type { TaskSnapshotData, OriginStep } from '../modules/tasks';
import type { TaskStep } from '../modules/task-activity';
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
const baseTasks: TaskSnapshotData[] = [
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
const details: Record<string, Partial<TaskSnapshotData>> = {
  window: { elapsed: '01:48', activity: 'Waiting for your deployment choice',
    steps: recentSteps.slice(0, 3), plan: { completed: 1, total: 3, current: 'Select the target environment' },
    change: { kind: 'file', summary: 'config/deploy.toml', output: 'Target environment is required before proceeding.' },
    path: 'LAN · 4 ms' },
  approve: { elapsed: '02:16', activity: 'Waiting for permission to apply the migration',
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
const prompts: Record<string, string> = {
  window: 'Prepare the deployment and ask before choosing the target environment.',
  approve: 'Apply the prepared schema migration after review.',
  queue: 'Inspect the dispatch queue and fix the ordering bug.',
  review: 'Review the workspace changes against the plan.',
  report: 'Summarize the queue behavior for the release notes.',
  'remote-report': 'Review the agent configuration for drift.',
  offline: 'Inspect the storage index and verify its integrity.',
};
const step = (kind: TaskStep['kind'], text: string, elapsed?: string, status: TaskStep['status'] = 'completed'): TaskStep =>
  ({ kind, text, elapsed, status });
const snapshots: Record<string, readonly TaskStep[]> = {
  window: [step('reading', 'Read README.md', '1 s'), step('command', 'git status --short', '1 s'),
    step('reading', 'Read .github/workflows/deploy.yml', '2 s'), step('thinking', 'Map the release steps', '7 s'),
    step('thinking', 'Read the deployment checklist', '6 s'), step('reading', 'Read config/deploy.toml', '2 s'),
    step('reading', 'Read docs/release.md', '3 s'), step('thinking', 'Compare staging and production targets', '9 s'),
    step('editing', 'Draft the deployment plan', '5 s'), step('waiting', 'Ask which environment to target', undefined, 'running')],
  approve: [step('reading', 'Read db/schema.sql', '2 s'), step('command', 'db status', '3 s'),
    step('thinking', 'List the affected tables', '6 s'), step('reading', 'Read migrations/0042_tasks.sql', '2 s'), step('thinking', 'Check the rollback path', '11 s'),
    step('command', 'db migrate --dry-run', '14 s'), step('editing', 'Record the migration summary', '4 s'),
    step('waiting', 'Request permission to apply', undefined, 'running')],
  queue: [step('command', 'git log -5 --oneline', '1 s'), step('reading', 'Read src/scheduler.rs', '2 s'),
    step('thinking', 'Trace how requests enter the queue', '8 s'), step('reading', 'Read src/dispatch.rs', '2 s'), ...recentSteps],
  review: [step('command', 'git diff --stat', '1 s'), step('reading', 'Read src/dispatch.rs', '3 s'), ...recentSteps.slice(1)],
  tunnel: [step('reading', 'Read Cargo.toml', '1 s'), ...recentSteps.slice(0, 3),
    step('command', 'cargo check --lib', undefined, 'running')],
  report: [step('reading', 'Read src/queue.rs', '3 s'), step('thinking', 'Group the ordering rules', '7 s'),
    step('editing', 'Write queue-summary.md', '6 s'), step('command', 'npm run lint:docs', '9 s')],
  'remote-report': [step('reading', 'Read config/agents.toml', '2 s'), step('thinking', 'Compare with the defaults', '8 s'),
    step('editing', 'Update config/agents.toml', '4 s'), step('command', 'arc config check', '6 s')],
  offline: [step('reading', 'Read storage/index.json', '3 s'), step('command', 'index scan --verify', '41 s')],
};
export const tasks: TaskSnapshotData[] = baseTasks.map(task => ({
  ...task, ...details[task.id], prompt: prompts[task.id], snapshot: snapshots[task.id],
}));
tasks.splice(4, 0, {
  id: 'tunnel', node: 'quartz-codex', title: 'Validate the build configuration', group: 'running',
  state: 'Running command', detail: 'cargo check --lib', activity: 'Checking the build configuration',
  icon: 'terminal', elapsed: '01:08', path: 'Tunnel · 82 ms', partial: true,
  prompt: 'Validate the build configuration on the Tunnel machine.', snapshot: snapshots.tunnel,
  origin: [{ label: 'Anchor Mac · controller', icon: 'monitor' }, { label: 'Quartz PC · Tunnel', icon: 'monitor' },
    { label: 'Codex', brand: 'codex' }, { label: 'Work account', icon: 'user-round' }],
  steps: [...recentSteps.slice(0, 3), { kind: 'command', text: 'cargo check --lib', status: 'running' }],
  change: { kind: 'command', summary: 'cargo check --lib', output: 'Checking workspace packages…' },
});
export const tasksCopy = {
  tasks: 'Tasks', empty: 'No tasks', open: 'Open task detail', markRead: 'Mark as read',
  more: 'More task actions', moveUp: 'Move up', moveDown: 'Move down',
  filter: 'Cedar Mac · Codex', clear: 'Clear node filter', filtered: 'Tasks for Cedar Mac · Codex',
  recent: 'Recent completed · 12', answer: 'Answer…', approve: 'Review approval…',
  activity: 'Activity', hideActivity: 'Hide activity', partial: 'Partial history',
};
export const switcherCopy = {
  filter: 'Show tasks', layout: 'Task layout', tile: 'Tile', stack: 'Stack', all: 'All',
  browse: 'Drag or use arrow keys', open: 'Open', request: 'Request', reply: 'Reply', lastSeen: 'Last observation',
};
export const switcherStatus: Record<string, { status: string; routing?: string; route?: string }> = {
  window: { status: 'Waiting for input', routing: 'Handed to the controller', route: 'Controller' },
  approve: { status: 'Waiting for approval', routing: 'Hands to Claude in 18 s', route: 'Claude' },
};
export const switcherFilters = [
  { value: 'all', label: 'All', groups: ['needs-me', 'running', 'unread', 'unconfirmed'] },
  { value: 'running', label: 'Running', groups: ['running'] },
  { value: 'waiting', label: 'Waiting', groups: ['needs-me'] },
  { value: 'completed', label: 'Completed', groups: ['unread'] },
  { value: 'unconfirmed', label: 'Unconfirmed', groups: ['unconfirmed'] },
] as const;
export const switcherForms = [
  { name: 'switcher-tile-wide', width: 1600, height: 1000, layout: 'tile' },
  { name: 'switcher-tile', width: 1280, height: 800, layout: 'tile' },
  { name: 'switcher-stack', width: 1280, height: 800, layout: 'stack' },
  { name: 'switcher-tile-portrait', width: 640, height: 800, layout: 'tile' },
  { name: 'switcher-stack-portrait', width: 640, height: 800, layout: 'stack' },
  { name: 'switcher-tile-mobile', width: 390, height: 844, layout: 'tile' },
  { name: 'switcher-stack-mobile', width: 390, height: 844, layout: 'stack' },
] as const;
export const snapshotForms = [
  { name: 'waiting-input', id: 'window' },
  { name: 'waiting-approval', id: 'approve' },
  { name: 'running', id: 'queue' },
  { name: 'unread', id: 'report' },
  { name: 'unconfirmed', id: 'offline' },
] as const;
