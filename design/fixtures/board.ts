import type { BoardForm, BoardGroupData } from "../modules/board";
import type { TaskPreviewLine, TaskSnapshotData } from "../components/task-card";

const taskHeader = {
  node: "codex",
  origin: [{ label: "Claude", brand: "claude" }, { label: "Codex", brand: "codex" }],
  elapsed: "01:23",
  dispatch: { model: "GPT-6.1 Sol", effort: "High", tier: "priority", fast: true },
  project: { name: "acceptance", path: "/workspace/acceptance" },
} satisfies Partial<TaskSnapshotData>;
const previewLines: readonly TaskPreviewLine[] = [
  { kind: "source", text: "Review the project and check the configuration. Keep the existing behavior while making the requested changes." },
  { kind: "thinking", text: "I will read the current configuration and preserve its documented behavior." },
  { kind: "tool", text: "Ran 1 command · cat package.json" },
  { kind: "thinking", text: "The existing check command covers the changed TypeScript files." },
  { kind: "agent", text: "The project configuration is ready. I am applying the change next." },
];

export const boardTabs = [
  { value: "current", label: "Current" },
  { value: "activity", label: "Activity" },
  { value: "ax", label: "AX" },
];
export const boardFilters = ["All", "Needs attention", "Task input", "History"].map(
  (label) => ({ value: label, label }),
);
export const boardGroups: BoardGroupData[] = [
  {
    title: "Needs attention",
    rows: [
      {
        title: "Choose the verification scope",
        task: { ...taskHeader, id: 'scope', title: 'Choose the verification scope', group: 'needs-me',
          state: 'Waiting for user input', detail: 'Choose the shared verification scope', icon: 'circle-help',
          previewLines: [...previewLines, { kind: "tool", text: "Edited 1 file · Called 1 tool · Read project metadata" }],
          requestLabel: 'Will be handled at the source’s next check' },
        meta: ["Codex", "Waiting for user input"],
        icon: "message-circle-question-mark",
        tone: "warning",
      },
      {
        title: "Interrupted registered task",
        task: { ...taskHeader, id: 'interrupted', title: 'Interrupted registered task', group: 'recent',
          state: 'Interrupted', detail: '', icon: 'circle-pause', exception: 'interrupted' },
        meta: ["Codex", "Interrupted"],
        icon: "circle-pause",
        tone: "warning",
      },
      {
        title: "Claude",
        meta: ["Connection problem"],
        icon: "unplug",
        tone: "danger",
      },
      {
        title: "Claude",
        meta: ["Notification problem"],
        icon: "bell-off",
        tone: "warning",
      },
      {
        title: "ARC",
        meta: ["Update problem"],
        icon: "circle-arrow-down",
        tone: "warning",
      },
      {
        title: "Task detail reopens the previous turn after resume",
        meta: ["AX candidate · awaiting Claude"],
        icon: "lightbulb",
        tone: "neutral",
      },
    ],
  },
  {
    title: "Current work",
    rows: [
      {
        title: "Parallel registered work",
        task: { ...taskHeader, id: 'parallel', title: 'Parallel registered work', group: 'running',
          state: 'Running', detail: '', icon: 'activity', phase: 'file',
          previewLines: [...previewLines, { kind: "tool", text: "Edited 1 file · Called 1 tool · Ran 1 command · npm run check" }] },
        meta: ["Codex", "Running"],
        icon: "activity",
        tone: "accent",
      },
      {
        title: "Review the shared renderer and registered worktree",
        meta: ["Claude", "2 min. ago", "Sample project", "Review lane"],
        icon: "megaphone",
        tone: "accent",
      },
      {
        title:
          "Coordinate the release candidate across registered resources. Preserve linked task ownership, " +
          "keep interrupted work visible, and record evidence before clearing resource conditions. " +
          "并行任务、资源所有者与活动覆盖情况均需保留，长内容可完整查看。",
        meta: ["Local authority", "25 min. ago", "ARC"],
        icon: "megaphone",
        tone: "accent",
      },
    ],
  },
  {
    title: "Resource blockers",
    rows: [
      {
        title: "Registered build lane needs an explicit recovery decision",
        meta: ["Stale · uncleared", "Claude", "7 hr. ago", "Task observation incomplete", "Sample project", "Review lane"],
        icon: "shield-alert",
        tone: "warning",
      },
      {
        title:
          "Owner activity is uncertain; keep this resource condition uncleared",
        meta: ["Uncertain · uncleared", "Claude", "just now", "Activity time uncertain", "ARC"],
        icon: "shield-alert",
        tone: "warning",
      },
    ],
  },
];
export const boardFrames: { name: BoardForm; fixture: string; viewportHeight: number; clicks?: string[] }[] = [
  {
    name: "current",
    fixture: "coordination-problems",
    viewportHeight: 1800,
    clicks: ["Open board"],
  },
  {
    name: "empty",
    fixture: "coordination-empty",
    viewportHeight: 800,
    clicks: ["Open board"],
  },
  {
    name: "gap",
    fixture: "coordination-gap",
    viewportHeight: 800,
    clicks: ["Open board", "Activity"],
  },
  {
    name: "unavailable",
    fixture: "board-unavailable",
    viewportHeight: 800,
  },
];
export const boardCopy = {
  title: "Board",
  refresh: "Refresh",
  all: "All",
  filter: "Filter",
  resource: "Resource",
  resources: [{ value: "all", label: "All resources" }],
  partial: "Observation incomplete; attention count unavailable",
  empty: "No matching records",
  observed: "Observed just now",
  gap: {
    title: "History interval missing; reset the cursor to continue",
    detail: "CURSOR_EXPIRED: Refresh the current owner record and retry.",
    action: "Reset cursor",
  },
  unavailable: {
    title: "Refresh unavailable; retained data may be stale",
    detail: "Error: SCENARIO_BOARD_UNAVAILABLE",
    action: "Retry",
  },
  notes: {
    current: "The panel region fits the declared viewport; acceptance owns center-slot placement.",
    unavailable: "Prepared in the adapter: wait for SCENARIO_BOARD_UNAVAILABLE without retrying before capture.",
  },
};
