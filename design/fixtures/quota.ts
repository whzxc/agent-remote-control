export const readings = [
  {
    label: "5h 额度",
    reset: "2h 0m",
    remaining: 27,
    estimate: "≈ 1h 7m",
    elapsed: 0.4,
  },
  {
    label: "周额度",
    reset: "3d 0h",
    remaining: 32,
    estimate: "≈ 1d 21h",
    elapsed: 3 / 7,
  },
];
export const quotaExample = { title: "ChatGPT", updated: "2m ago" };

export const agentQuotas = [
  {
    label: "5h 额度 · 2h 0m",
    remaining: 27,
    estimate: "≈ 1h 7m",
    elapsed: 0.4,
  },
  {
    label: "周额度 · 3d 0h",
    remaining: 32,
    estimate: "≈ 1d 21h",
    elapsed: 3 / 7,
  },
];

export const quotaAccounts = [
  {
    name: "Personal",
    quotas: [
      {
        label: "5h quota · 2h 0m",
        remaining: 82,
        elapsed: 0.4,
        tone: "success",
      },
      {
        label: "Weekly · 3d 0h",
        remaining: 73,
        elapsed: 3 / 7,
        tone: "success",
      },
    ],
  },
  {
    name: "Studio",
    quotas: [
      {
        label: "5h quota · 2h 0m",
        remaining: 42,
        elapsed: 0.4,
        estimate: "~3% spare",
        tone: "warning",
      },
      {
        label: "Weekly · 3d 0h",
        remaining: 27,
        elapsed: 3 / 7,
        estimate: "≈ 1d 11h",
        tone: "success",
      },
    ],
  },
] as const;

export const overviewReadings = [
  {
    title: "5h 额度 · 剩余 27%",
    detail: "2h 0m · ≈ 1h 7m",
    remaining: 27,
    elapsed: 0.4,
  },
  {
    title: "周额度 · 剩余 32%",
    detail: "3d 0h · ≈ 1d 21h",
    remaining: 32,
    elapsed: 3 / 7,
  },
];
