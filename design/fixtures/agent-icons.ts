export const iconExampleBrand = "claude-code";

export const agentIconForms = [
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
