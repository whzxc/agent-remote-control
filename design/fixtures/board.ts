import type { BoardForm, BoardGroupData } from "../modules/board";

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
        meta: ["Codex", "Waiting for user input"],
        icon: "message-circle-question-mark",
        tone: "warning",
      },
      {
        title: "Interrupted registered task",
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
export const boardFrames: { name: BoardForm; fixture: string; viewport: string; clicks?: string[]; height: number }[] = [
  {
    name: "current",
    fixture: "coordination-problems",
    viewport: "1280x1400",
    clicks: ["Open board"],
    height: 1144,
  },
  {
    name: "empty",
    fixture: "coordination-empty",
    viewport: "1280x800",
    clicks: ["Open board"],
    height: 680,
  },
  {
    name: "gap",
    fixture: "coordination-gap",
    viewport: "1280x800",
    clicks: ["Open board", "Activity"],
    height: 680,
  },
  {
    name: "unavailable",
    fixture: "board-unavailable",
    viewport: "1280x800",
    height: 760,
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
