import type { AgentIconReading } from "../components/agent-icon";

export const iconExampleBrand = "claude-code";

export const agentIconForms: { name: string; readings: AgentIconReading[]; used?: boolean }[] = [
  { name: "no-ring", readings: [] },
  {
    name: "single-ring",
    readings: [
      {
        id: "display",
        label: "Week",
        value: 73,
        color: "var(--success)",
        elapsed: 4 / 7,
      },
    ],
  },
  ...[
    { name: "single-ring-remaining-ahead", value: 25, elapsed: 0.45, color: "var(--warning)" },
    { name: "single-ring-remaining-aligned", value: 55, elapsed: 0.45, color: "var(--success)" },
    { name: "single-ring-used-behind", value: 27, elapsed: 4 / 7, color: "var(--success)", used: true },
    { name: "single-ring-used-ahead", value: 75, elapsed: 0.45, color: "var(--warning)", used: true },
    { name: "single-ring-used-aligned", value: 45, elapsed: 0.45, color: "var(--success)", used: true },
  ].map(({ name, used, ...reading }) => ({
    name,
    used,
    readings: [{ id: "display", label: "Week", ...reading }],
  })),
  {
    name: "two-part-ring",
    readings: [
      {
        id: "session",
        label: "Session",
        value: 27,
        color: "var(--warning)",
        elapsed: 0.6,
      },
      {
        id: "week",
        label: "Week",
        value: 32,
        color: "var(--warning)",
        elapsed: 4 / 7,
      },
    ],
  },
  {
    name: "three-part-ring",
    readings: [
      {
        id: "session",
        label: "Session",
        value: 32,
        color: "var(--warning)",
        elapsed: 0.54,
      },
      {
        id: "week",
        label: "Week",
        value: 68,
        color: "var(--success)",
        elapsed: 0.4,
      },
      {
        id: "month",
        label: "Month",
        value: 85,
        color: "var(--success)",
        elapsed: 0.73,
      },
    ],
  },
];
