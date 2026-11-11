export const sourceDispatches = [
  {
    title: "需要你处理",
    rows: [
      [
        "Review the example change",
        "codex · 等待输入",
        "warning",
        "shield-alert",
      ],
    ],
  },
  {
    title: "运行中",
    rows: [
      ["Update example documentation", "codex · 运行中", "thinking", "brain"],
      ["Review example tests", "claude · 运行中", "thinking", "brain"],
    ],
  },
];
export const sourceHistory = [
  {
    title: "Needs your attention",
    rows: [
      [
        "Submission awaiting-approval",
        "codex · Awaiting dispatch approval",
        "warning",
        "shield-alert",
      ],
    ],
  },
  {
    title: "Running",
    rows: [["Current running dispatch", "codex · Running", "file", "pencil"]],
  },
  {
    title: "Unread",
    rows: [
      ["Completed dispatch", "codex · Done", "success", "check"],
      ["Failed execution", "codex · Failed", "danger", "circle-alert"],
      [
        "Interrupted execution",
        "codex · Interrupted",
        "neutral",
        "circle-pause",
      ],
    ],
  },
  {
    title: "Today",
    rows: [
      ["Submission reserved", "codex · Submitting", "neutral", "circle"],
      ["Submission not-executed", "codex · Not executed", "neutral", "circle"],
      [
        "Submission unconfirmed",
        "codex · Submission unconfirmed",
        "warning",
        "circle",
      ],
      [
        "Submission failed",
        "codex · Submission failed",
        "danger",
        "circle-alert",
      ],
    ],
  },
  {
    title: "Yesterday",
    rows: [["Earlier completed dispatch", "codex · Done", "success", "check"]],
  },
];

export const attentionGroupTitles = [sourceDispatches[0].title, sourceHistory[0].title];
export const sourcePanelCopy = { loading: "正在加载…" };
