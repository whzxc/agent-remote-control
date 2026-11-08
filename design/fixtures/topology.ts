import type { TopologyNodeProps } from "../modules/topology-node";
import type { TaskBubbleProps } from "../modules/task-presentation";
import type { ScenePath } from "../modules/topology-scene";
import type { TopologyGroupProps } from "../modules/topology-group";
import { idleAgents, idleCodexAccounts, idleSources } from "./topology-group";

// Fixture geometry extracted from the approved topology sheets. Runtime solving stays in ui/topology/solve.ts.
export const nodes: readonly TopologyNodeProps[] = [
  { label: "Codex", brand: "codex" },
  { label: "OpenAI", brand: "openai", layout: "source", width: 156 },
  { label: "Anthropic", brand: "anthropic", layout: "source", width: 156 },
  { label: "Google", brand: "google", layout: "source", width: 156 },
  { label: "xAI", brand: "xai", layout: "source", width: 156 },
  {
    label: "Codex",
    brand: "codex",
    layout: "agent",
    width: 140,
    readings: [{ id: "display", label: "Display", value: 73.0, color: "var(--success)", elapsed: 0.5714285714285714 }],
  },
  { label: "Claude Code", brand: "claude-code", layout: "agent", width: 140 },
  { label: "OpenCode", brand: "opencode", layout: "agent", width: 140 },
  { label: "Claude account", brand: "claude" },
  {
    label: "DeepSeek Harness",
    brand: "deepseek",
    layout: "agent",
    width: 140,
    readings: [{ id: "display", label: "Display", value: 48.0, color: "var(--warning)", elapsed: 0.6166666666666667 }],
  },
  {
    label: "Claude Code",
    brand: "claude-code",
    layout: "agent",
    width: 140,
    readings: [
      { id: "session", label: "Session", value: 69.0, color: "var(--warning)", elapsed: 0.6000000000000001 },
      { id: "week", label: "Week", value: 36.0, color: "var(--warning)", elapsed: 0.5714285975609756 },
    ],
  },
  {
    label: "Cursor Agent",
    brand: "cursor",
    layout: "agent",
    width: 140,
    readings: [{ id: "display", label: "Display", value: 83.0, color: "var(--success)", elapsed: 0.575 }],
  },
  {
    label: "OpenCode",
    brand: "opencode",
    layout: "agent",
    width: 140,
    readings: [{ id: "display", label: "Display", value: 42.0, color: "var(--warning)", elapsed: 0.5888888888888889 }],
  },
  { label: "Anthropic", brand: "anthropic" },
  { label: "Claude", brand: "claude" },
  { label: "Claude Code", brand: "claude-code" },
  { label: "Pi", brand: "pi" },
  { label: "OpenAI", brand: "openai" },
  { label: "Claude · Laptop", brand: "claude" },
  { label: "Claude · Desktop", brand: "claude" },
  { label: "Personal", brand: "openai" },
  {
    label: "Personal",
    brand: "claude-code",
    readings: [{ id: "display", label: "Display", value: 73.0, color: "var(--success)", elapsed: 0.5714285714285714 }],
  },
  {
    label: "Studio",
    brand: "claude-code",
    readings: [{ id: "display", label: "Display", value: 27.0, color: "var(--warning)", elapsed: 0.5714285714285714 }],
  },
  { label: "DeepSeek Harness", brand: "deepseek" },
  {
    label: "Pro 200",
    brand: "codex",
    readings: [{ id: "display", label: "Display", value: 73.0, color: "var(--success)", elapsed: 0.5714285714285714 }],
  },
  {
    label: "Codex Pro 01",
    brand: "codex",
    readings: [{ id: "display", label: "Display", value: 38.0, color: "var(--warning)", elapsed: 0.5714285714285714 }],
  },
  {
    label: "Codex Pro 02",
    brand: "codex",
    readings: [{ id: "display", label: "Display", value: 81.0, color: "var(--success)", elapsed: 0.5714285714285714 }],
  },
];

export const groups: readonly TopologyGroupProps[] = [
  { label: "8 idle accounts", members: idleCodexAccounts },
  { label: "4 idle Agents", members: idleAgents },
  { label: "3 idle", members: idleSources, layout: "source" },
];
export const tasks: readonly TaskBubbleProps[] = [
  {
    title: "Check configuration",
    duration: "1:23",
    phase: "Command",
    headline: "npm run check",
    tone: "command",
    icon: "terminal",
    project: "acceptance",
    width: 400,
    headlineMono: true,
    phaseColumn: "latin",
    sourceBrand: "openai",
  },
  {
    title: "Review changes",
    duration: "2:16",
    phase: "Thinking",
    headline: "Read the project changes",
    tone: "thinking",
    icon: "brain",
    project: "acceptance",
    width: 400,
    headlineMono: true,
    phaseColumn: "latin",
  },
  {
    title: "Review navigation",
    duration: "0:48",
    phase: "Thinking",
    headline: "Check account routes",
    tone: "thinking",
    icon: "brain",
    project: "acceptance",
    width: 400,
    headlineMono: true,
    phaseColumn: "latin",
  },
  {
    title: "Verify project changes",
    duration: "1:05",
    phase: "Command",
    headline: "Review the build log",
    tone: "command",
    icon: "terminal",
    project: "acceptance",
    width: 400,
    headlineMono: true,
    phaseColumn: "latin",
    sourceBrand: "openai",
  },
  {
    title: "并行任务 1",
    duration: "1:23",
    phase: "思考中",
    headline: "确认 API 契约",
    tone: "thinking",
    icon: "brain",
    project: "ac…",
    width: 264,
    headlineMono: true,
    phaseColumn: "cjk",
  },
  {
    title: "并行任务 2",
    duration: "1:23",
    phase: "执行命令",
    headline: "npm run check",
    tone: "command",
    icon: "terminal",
    project: "ac…",
    width: 264,
    headlineMono: true,
    phaseColumn: "cjk",
  },
  {
    title: "并行任务 3",
    duration: "1:23",
    phase: "处理文件",
    headline: "ui/components…",
    tone: "file",
    icon: "pencil",
    project: "ac…",
    width: 264,
    headlineMono: true,
    phaseColumn: "cjk",
  },
  {
    title: "并行任务 4",
    duration: "1:23",
    phase: "调用工具",
    headline: "读取项目文档",
    tone: "agent",
    icon: "terminal",
    project: "ac…",
    width: 264,
    headlineMono: true,
    phaseColumn: "cjk",
  },
  {
    title: "并行任务 5",
    duration: "1:23",
    phase: "回复中",
    headline: "整理实现说明",
    tone: "agent",
    icon: "terminal",
    project: "ac…",
    width: 264,
    headlineMono: true,
    phaseColumn: "cjk",
  },
  {
    title: "并行任务 6",
    duration: "1:23",
    phase: "执行命令",
    headline: "git status --…",
    tone: "command",
    icon: "terminal",
    project: "ac…",
    width: 264,
    headlineMono: true,
    phaseColumn: "cjk",
  },
  {
    title: "并行任务 7",
    duration: "1:23",
    phase: "思考中",
    headline: "核对布局边界",
    tone: "thinking",
    icon: "brain",
    project: "ac…",
    width: 264,
    headlineMono: true,
    phaseColumn: "cjk",
  },
  {
    title: "Active Codex task",
    duration: "1:23",
    phase: "执行命令",
    headline: "Checking conf…",
    tone: "command",
    icon: "terminal",
    project: "ac…",
    width: 264,
    headlineMono: true,
    phaseColumn: "cjk",
    sourceBrand: "openai",
  },
  {
    title: "Codex completed task",
    duration: "1:23",
    phase: "已完成",
    headline: "Configuration…",
    tone: "success",
    icon: "circle-check",
    project: "ac…",
    width: 264,
    headlineMono: true,
    phaseColumn: "cjk",
    sourceBrand: "openai",
  },
  {
    title: "Studio completed ta…",
    duration: "1:23",
    phase: "已完成",
    headline: "Studio change…",
    tone: "success",
    icon: "circle-check",
    project: "ac…",
    width: 264,
    headlineMono: true,
    phaseColumn: "cjk",
  },
  {
    title: "Check configuration",
    duration: "1:23",
    phase: "Command",
    headline: "Running the c…",
    tone: "command",
    icon: "terminal",
    project: "ac…",
    width: 264,
    headlineMono: true,
    phaseColumn: "latin",
    sourceBrand: "openai",
  },
  {
    title: "Review changes",
    duration: "1:23",
    phase: "Thinking",
    headline: "Reading the p…",
    tone: "thinking",
    icon: "brain",
    project: "ac…",
    width: 264,
    headlineMono: true,
    phaseColumn: "latin",
  },
  {
    title: "Review navigation",
    duration: "1:23",
    phase: "Thinking",
    headline: "Checking the …",
    tone: "thinking",
    icon: "brain",
    project: "ac…",
    width: 264,
    headlineMono: true,
    phaseColumn: "latin",
  },
  {
    title: "Update documentation",
    duration: "1:23",
    phase: "Completed",
    headline: "Documentation…",
    tone: "success",
    icon: "circle-check",
    project: "ac…",
    width: 264,
    headlineMono: true,
    phaseColumn: "latin",
  },
  {
    title: "Validate workspace",
    duration: "1:23",
    phase: "Needs you",
    headline: "Waiting for p…",
    tone: "warning",
    icon: "shield-alert",
    project: "ac…",
    width: 264,
    headlineMono: true,
    phaseColumn: "latin",
  },
];

export const links: readonly ScenePath[] = [
  {
    d:
      "M 951.0 398.5 L 946.3 398.5 L 941.6 398.5 L 937.0 398.5 L 932.5 398.5 L 928.0 398.4 L 923.6 " +
      "398.4 L 919.3 398.4 L 915.0 398.4 L 910.7 398.4 L 906.5 398.3 L 902.4 398.3 L 898.3 398.3 L " +
      "894.2 398.3 L 890.2 398.2 L 886.3 398.2 L 882.4 398.2 L 878.5 398.2 L 874.6 398.1 L 870.8 398.1 " +
      "L 867.1 398.1 L 863.3 398.0 L 859.7 398.0 L 856.0 398.0 L 852.4 397.9 L 848.7 397.9 L 845.2 " +
      "397.9 L 841.6 397.8 L 838.1 397.8 L 834.6 397.8 L 831.1 397.7 L 827.6 397.7 L 824.2 397.7 L " +
      "820.7 397.6 L 817.3 397.6 L 813.9 397.5 L 810.5 397.5 L 807.1 397.5 L 803.7 397.4 L 800.4 397.4 " +
      "L 797.0 397.3 L 793.6 397.3 L 790.2 397.0 L 786.9 396.5 L 783.5 395.8 L 780.1 394.9 L 776.8 " +
      "393.8 L 773.4 392.5 L 770.0 391.0 L 770.0 409.0 L 773.4 407.5 L 776.8 406.2 L 780.1 405.1 L " +
      "783.5 404.2 L 786.9 403.5 L 790.2 403.0 L 793.6 402.7 L 797.0 402.7 L 800.4 402.6 L 803.7 402.6 " +
      "L 807.1 402.5 L 810.5 402.5 L 813.9 402.5 L 817.3 402.4 L 820.7 402.4 L 824.2 402.3 L 827.6 " +
      "402.3 L 831.1 402.3 L 834.6 402.2 L 838.1 402.2 L 841.6 402.2 L 845.2 402.1 L 848.7 402.1 L " +
      "852.4 402.1 L 856.0 402.0 L 859.7 402.0 L 863.3 402.0 L 867.1 401.9 L 870.8 401.9 L 874.6 401.9 " +
      "L 878.5 401.8 L 882.4 401.8 L 886.3 401.8 L 890.2 401.8 L 894.2 401.7 L 898.3 401.7 L 902.4 " +
      "401.7 L 906.5 401.7 L 910.7 401.6 L 915.0 401.6 L 919.3 401.6 L 923.6 401.6 L 928.0 401.6 L " +
      "932.5 401.5 L 937.0 401.5 L 941.6 401.5 L 946.3 401.5 L 951.0 401.5 Z",
    class: "fill-role-agent/35",
  },
  {
    d: "M 519.5 351.3 A 130 130 0 0 0 519.5 448.7",
    "stroke-width": "14.0",
    "stroke-linecap": "round",
    class: "fill-none stroke-role-source",
  },
  {
    d: "M 760.5 351.3 A 130 130 0 0 1 760.5 448.7",
    "stroke-width": "14.0",
    "stroke-linecap": "round",
    class: "fill-none stroke-role-agent",
  },
  { "stroke-width": "1", d: "M0.5 0.5h639.0v799.0h-639.0Z", class: "fill-none stroke-border-strong" },
  {
    d: "M282 438 H142 Q118 438 118 414 V146",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    class: "fill-none stroke-role-source/52",
  },
  {
    d: "M358 438 H496 Q520 438 520 462 V654",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    class: "fill-none stroke-role-agent/52",
  },
  {
    d: "M259 438H281",
    "stroke-width": "4",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    class: "fill-none stroke-role-source",
  },
  {
    d: "M359 438H381",
    "stroke-width": "4",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    class: "fill-none stroke-role-agent",
  },
  {
    d: "M282 370 H142 Q118 370 118 346 V102",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    class: "fill-none stroke-role-source/52",
  },
  {
    d: "M358 370 H496 Q520 370 520 394 V697",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    class: "fill-none stroke-role-agent/52",
  },
  {
    d: "M259 370H281",
    "stroke-width": "4",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    class: "fill-none stroke-role-source",
  },
  {
    d: "M359 370H381",
    "stroke-width": "4",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    class: "fill-none stroke-role-agent",
  },
  {
    d:
      "M520 494 H509 Q503 494 503 488 V459 Q503 451 495 451 H484 M520 494 H509 Q503 494 503 500 V529 " +
      "Q503 537 495 537 H484",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    class: "fill-none stroke-role-agent/52",
  },
  {
    d: "M472 451H484",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    class: "fill-none stroke-role-agent",
  },
  { d: "M476.4 451.0a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0 -3.2 0", class: "fill-role-agent" },
  {
    d: "M472 537H484",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    class: "fill-none stroke-role-agent",
  },
  { d: "M476.4 537.0a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0 -3.2 0", class: "fill-role-agent" },
  {
    d: "M282 194 H142 Q118 194 118 170 V94",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    class: "fill-none stroke-role-source/52",
  },
  {
    d: "M358 194 H496 Q520 194 520 218 V672",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    class: "fill-none stroke-role-agent/52",
  },
  {
    d: "M259 194H281",
    "stroke-width": "4",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    class: "fill-none stroke-role-source",
  },
  {
    d: "M359 194H381",
    "stroke-width": "4",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    class: "fill-none stroke-role-agent",
  },
  {
    d:
      "M520 400 H509 Q503 400 503 394 V279 Q503 271 495 271 H484 M520 400 H509 Q503 400 503 394 V365 " +
      "Q503 357 495 357 H484 M520 400 H509 Q503 400 503 406 V435 Q503 443 495 443 H484 M520 400 H509 " +
      "Q503 400 503 406 V521 Q503 529 495 529 H484",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    class: "fill-none stroke-role-agent/52",
  },
  {
    d: "M472 271H484",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    class: "fill-none stroke-role-agent",
  },
  { d: "M476.4 271.0a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0 -3.2 0", class: "fill-role-agent" },
  {
    d: "M472 357H484",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    class: "fill-none stroke-role-agent",
  },
  { d: "M476.4 357.0a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0 -3.2 0", class: "fill-role-agent" },
  {
    d: "M472 443H484",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    class: "fill-none stroke-role-agent",
  },
  { d: "M476.4 443.0a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0 -3.2 0", class: "fill-role-agent" },
  {
    d: "M472 529H484",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    class: "fill-none stroke-role-agent",
  },
  { d: "M476.4 529.0a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0 -3.2 0", class: "fill-role-agent" },
  {
    d: "M358 295 H496 Q520 295 520 319 V511",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    class: "fill-none stroke-role-agent/52",
  },
  {
    d: "M259 295H281",
    "stroke-width": "4",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    class: "fill-none stroke-role-source",
  },
  {
    d: "M359 295H381",
    "stroke-width": "4",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    class: "fill-none stroke-role-agent",
  },
  {
    d: "M282 543 H142 Q118 543 118 519 V251",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    class: "fill-none stroke-role-source/52",
  },
  {
    d: "M259 543H281",
    "stroke-width": "4",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    class: "fill-none stroke-role-source",
  },
  {
    d: "M359 543H381",
    "stroke-width": "4",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    class: "fill-none stroke-role-agent",
  },
  { "stroke-width": "1", d: "M0.5 0.5h639.0v999.0h-639.0Z", class: "fill-none stroke-border-strong" },
  {
    d: "M282 444 H142 Q118 444 118 420 V104",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    class: "fill-none stroke-role-source/52",
  },
  {
    d: "M358 444 H456 Q480 444 480 468 V894",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    class: "fill-none stroke-role-agent/52",
  },
  {
    d: "M259 444H281",
    "stroke-width": "4",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    class: "fill-none stroke-role-source",
  },
  {
    d: "M359 444H381",
    "stroke-width": "4",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    class: "fill-none stroke-role-agent",
  },
  { d: "M141 192H161", "stroke-width": "2", "stroke-linecap": "round", class: "fill-none stroke-role-source/52" },
  { d: "M432 526H455", "stroke-width": "2", "stroke-linecap": "round", class: "fill-none stroke-role-agent" },
  {
    d:
      "M 223.5 401.5 L 228.2 401.5 L 232.9 401.5 L 237.5 401.5 L 242.0 401.5 L 246.4 401.6 L 250.9 " +
      "401.6 L 255.2 401.6 L 259.5 401.6 L 263.7 401.6 L 267.9 401.7 L 272.1 401.7 L 276.2 401.7 L " +
      "280.2 401.7 L 284.2 401.8 L 288.2 401.8 L 292.1 401.8 L 296.0 401.8 L 299.8 401.9 L 303.6 401.9 " +
      "L 307.4 401.9 L 311.1 402.0 L 314.8 402.0 L 318.4 402.0 L 322.1 402.1 L 325.7 402.1 L 329.2 " +
      "402.1 L 332.8 402.2 L 336.3 402.2 L 339.8 402.2 L 343.3 402.3 L 346.8 402.3 L 350.2 402.3 L " +
      "353.7 402.4 L 357.1 402.4 L 360.5 402.5 L 363.9 402.5 L 367.3 402.5 L 370.6 402.6 L 374.0 402.6 " +
      "L 377.4 402.7 L 380.8 402.7 L 384.1 403.0 L 387.5 403.5 L 390.8 404.2 L 394.2 405.1 L 397.6 " +
      "406.2 L 401.0 407.5 L 404.3 409.0 L 404.3 391.0 L 401.0 392.5 L 397.6 393.8 L 394.2 394.9 L " +
      "390.8 395.8 L 387.5 396.5 L 384.1 397.0 L 380.8 397.3 L 377.4 397.3 L 374.0 397.4 L 370.6 397.4 " +
      "L 367.3 397.5 L 363.9 397.5 L 360.5 397.5 L 357.1 397.6 L 353.7 397.6 L 350.2 397.7 L 346.8 " +
      "397.7 L 343.3 397.7 L 339.8 397.8 L 336.3 397.8 L 332.8 397.8 L 329.2 397.9 L 325.7 397.9 L " +
      "322.1 397.9 L 318.4 398.0 L 314.8 398.0 L 311.1 398.0 L 307.4 398.1 L 303.6 398.1 L 299.8 398.1 " +
      "L 296.0 398.2 L 292.1 398.2 L 288.2 398.2 L 284.2 398.2 L 280.2 398.3 L 276.2 398.3 L 272.1 " +
      "398.3 L 267.9 398.3 L 263.7 398.4 L 259.5 398.4 L 255.2 398.4 L 250.9 398.4 L 246.4 398.4 L " +
      "242.0 398.5 L 237.5 398.5 L 232.9 398.5 L 228.2 398.5 L 223.5 398.5 Z",
    class: "fill-role-source/35",
  },
  {
    d:
      "M 119.5 401.0 L 120.9 401.0 L 122.2 401.0 L 123.5 401.0 L 124.8 401.0 L 126.1 401.0 L 127.3 " +
      "401.1 L 128.4 401.1 L 129.6 401.1 L 130.7 401.1 L 131.8 401.1 L 132.8 401.1 L 133.9 401.2 L " +
      "134.9 401.2 L 135.9 401.2 L 136.8 401.2 L 137.8 401.2 L 138.7 401.3 L 139.6 401.3 L 140.5 401.3 " +
      "L 141.3 401.3 L 142.2 401.3 L 143.0 401.4 L 143.9 401.4 L 144.7 401.4 L 145.5 401.4 L 146.3 " +
      "401.4 L 147.1 401.5 L 147.9 401.5 L 148.7 401.5 L 149.5 401.5 L 150.3 401.6 L 151.0 401.7 L " +
      "151.8 401.7 L 152.6 401.8 L 153.4 402.0 L 154.2 402.1 L 155.0 402.3 L 155.8 402.4 L 156.6 402.6 " +
      "L 157.4 402.8 L 158.3 403.1 L 159.1 403.3 L 160.0 403.6 L 160.8 403.9 L 161.7 404.3 L 162.6 " +
      "404.7 L 163.6 405.1 L 164.5 405.5 L 164.5 394.5 L 163.6 394.9 L 162.6 395.3 L 161.7 395.7 L " +
      "160.8 396.1 L 160.0 396.4 L 159.1 396.7 L 158.3 396.9 L 157.4 397.2 L 156.6 397.4 L 155.8 397.6 " +
      "L 155.0 397.7 L 154.2 397.9 L 153.4 398.0 L 152.6 398.2 L 151.8 398.3 L 151.0 398.3 L 150.3 " +
      "398.4 L 149.5 398.5 L 148.7 398.5 L 147.9 398.5 L 147.1 398.5 L 146.3 398.6 L 145.5 398.6 L " +
      "144.7 398.6 L 143.9 398.6 L 143.0 398.6 L 142.2 398.7 L 141.3 398.7 L 140.5 398.7 L 139.6 398.7 " +
      "L 138.7 398.7 L 137.8 398.8 L 136.8 398.8 L 135.9 398.8 L 134.9 398.8 L 133.9 398.8 L 132.8 " +
      "398.9 L 131.8 398.9 L 130.7 398.9 L 129.6 398.9 L 128.4 398.9 L 127.3 398.9 L 126.1 399.0 L " +
      "124.8 399.0 L 123.5 399.0 L 122.2 399.0 L 120.9 399.0 L 119.5 399.0 Z",
    class: "fill-role-source/35",
  },
  {
    d:
      "M 845.0 204.5 L 838.7 204.7 L 832.6 205.1 L 826.8 205.9 L 821.1 206.9 L 815.5 208.2 L 810.2 " +
      "209.8 L 805.0 211.6 L 800.0 213.7 L 795.1 216.0 L 790.4 218.5 L 785.8 221.2 L 781.4 224.1 L " +
      "777.1 227.1 L 772.9 230.4 L 768.8 233.7 L 764.8 237.3 L 760.9 240.9 L 757.2 244.7 L 753.5 248.5 " +
      "L 749.9 252.5 L 746.3 256.5 L 742.9 260.6 L 739.5 264.7 L 736.1 268.9 L 732.8 273.1 L 729.5 " +
      "277.4 L 726.3 281.6 L 723.1 285.9 L 719.9 290.1 L 716.7 294.3 L 713.5 298.4 L 710.4 302.5 L " +
      "707.2 306.5 L 704.0 310.5 L 700.8 314.3 L 697.5 318.1 L 694.2 321.7 L 690.9 325.2 L 687.6 328.6 " +
      "L 684.2 331.8 L 680.7 334.9 L 677.2 337.8 L 673.6 340.4 L 669.7 342.5 L 665.5 344.1 L 661.2 " +
      "345.1 L 656.8 345.5 L 652.1 345.3 L 659.1 361.9 L 662.7 358.3 L 666.3 354.8 L 669.9 351.4 L " +
      "673.4 348.2 L 677.0 345.0 L 680.6 342.1 L 684.3 339.0 L 687.8 335.7 L 691.3 332.3 L 694.7 328.8 " +
      "L 698.0 325.1 L 701.3 321.4 L 704.5 317.5 L 707.7 313.5 L 710.9 309.5 L 714.0 305.4 L 717.2 " +
      "301.2 L 720.3 297.0 L 723.4 292.7 L 726.6 288.5 L 729.7 284.2 L 732.9 279.9 L 736.1 275.7 L " +
      "739.3 271.4 L 742.6 267.2 L 745.9 263.1 L 749.3 259.0 L 752.7 255.0 L 756.2 251.0 L 759.8 247.2 " +
      "L 763.5 243.5 L 767.2 239.9 L 771.1 236.4 L 775.0 233.0 L 779.1 229.9 L 783.3 226.8 L 787.6 " +
      "224.0 L 792.0 221.3 L 796.6 218.9 L 801.3 216.6 L 806.1 214.6 L 811.1 212.8 L 816.3 211.2 L " +
      "821.7 209.9 L 827.2 208.9 L 833.0 208.1 L 838.9 207.7 L 845.0 207.5 Z",
    class: "fill-role-agent/35",
  },
  {
    d:
      "M 845.0 441.5 L 840.2 441.5 L 835.5 441.4 L 830.9 441.2 L 826.3 440.9 L 821.8 440.6 L 817.4 " +
      "440.3 L 813.0 439.9 L 808.7 439.4 L 804.5 438.9 L 800.3 438.3 L 796.1 437.7 L 792.0 437.1 L " +
      "788.0 436.4 L 784.0 435.7 L 780.1 434.9 L 776.2 434.1 L 772.3 433.3 L 768.5 432.5 L 764.8 431.6 " +
      "L 761.0 430.8 L 757.4 429.9 L 753.7 428.9 L 750.1 428.0 L 746.5 427.1 L 742.9 426.1 L 739.3 " +
      "425.2 L 735.8 424.2 L 732.3 423.3 L 728.8 422.4 L 725.4 421.4 L 721.9 420.5 L 718.5 419.6 L " +
      "715.1 418.7 L 711.7 417.8 L 708.3 416.9 L 704.9 416.1 L 701.5 415.2 L 698.1 414.4 L 694.7 413.7 " +
      "L 691.3 412.9 L 687.9 412.2 L 684.6 411.3 L 681.2 410.3 L 677.9 409.0 L 674.6 407.7 L 671.2 " +
      "406.1 L 667.9 404.4 L 664.5 402.5 L 662.8 420.5 L 666.3 419.3 L 669.8 418.3 L 673.2 417.7 L " +
      "676.7 417.3 L 680.1 417.1 L 683.5 417.2 L 686.9 417.6 L 690.3 418.1 L 693.6 418.8 L 697.0 419.5 " +
      "L 700.4 420.2 L 703.7 420.9 L 707.1 421.7 L 710.5 422.5 L 713.9 423.3 L 717.3 424.1 L 720.8 " +
      "425.0 L 724.2 425.8 L 727.7 426.7 L 731.2 427.6 L 734.7 428.4 L 738.3 429.3 L 741.9 430.2 L " +
      "745.5 431.1 L 749.1 432.0 L 752.7 432.8 L 756.4 433.7 L 760.2 434.5 L 763.9 435.3 L 767.8 436.2 " +
      "L 771.6 436.9 L 775.5 437.7 L 779.4 438.4 L 783.4 439.1 L 787.4 439.8 L 791.5 440.5 L 795.6 " +
      "441.1 L 799.8 441.6 L 804.1 442.1 L 808.4 442.6 L 812.7 443.0 L 817.1 443.4 L 821.6 443.7 L " +
      "826.2 444.0 L 830.8 444.2 L 835.4 444.4 L 840.2 444.5 L 845.0 444.5 Z",
    class: "fill-role-agent/35",
  },
  {
    d:
      "M 845.0 635.5 L 838.2 635.3 L 831.8 634.7 L 825.5 633.8 L 819.5 632.5 L 813.8 630.9 L 808.2 " +
      "629.0 L 802.9 626.8 L 797.8 624.3 L 792.8 621.6 L 788.1 618.5 L 783.5 615.3 L 779.1 611.8 L " +
      "774.8 608.0 L 770.7 604.1 L 766.8 600.0 L 762.9 595.7 L 759.2 591.3 L 755.6 586.7 L 752.1 582.0 " +
      "L 748.7 577.1 L 745.3 572.2 L 742.1 567.1 L 738.9 562.0 L 735.8 556.8 L 732.7 551.6 L 729.7 " +
      "546.4 L 726.7 541.1 L 723.7 535.8 L 720.7 530.5 L 717.7 525.3 L 714.8 520.1 L 711.8 514.9 L " +
      "708.8 509.8 L 705.7 504.8 L 702.6 499.9 L 699.5 495.1 L 696.3 490.4 L 693.0 485.9 L 689.6 481.5 " +
      "L 686.1 477.3 L 682.6 473.2 L 678.9 469.4 L 675.0 465.7 L 671.3 462.1 L 667.6 458.2 L 663.9 " +
      "454.3 L 660.1 450.1 L 656.4 445.9 L 648.4 462.0 L 653.6 462.2 L 658.4 463.1 L 663.0 464.7 L " +
      "667.3 467.0 L 671.3 469.9 L 675.0 473.3 L 678.6 476.9 L 682.1 480.7 L 685.5 484.8 L 688.9 489.0 " +
      "L 692.1 493.4 L 695.3 497.9 L 698.5 502.6 L 701.6 507.4 L 704.7 512.3 L 707.8 517.3 L 710.8 " +
      "522.4 L 713.8 527.5 L 716.9 532.7 L 719.9 538.0 L 723.0 543.2 L 726.1 548.5 L 729.2 553.7 L " +
      "732.3 558.9 L 735.5 564.1 L 738.8 569.2 L 742.2 574.3 L 745.6 579.3 L 749.1 584.2 L 752.7 588.9 " +
      "L 756.4 593.6 L 760.3 598.1 L 764.2 602.4 L 768.3 606.6 L 772.6 610.6 L 777.0 614.3 L 781.5 " +
      "617.9 L 786.3 621.2 L 791.2 624.3 L 796.3 627.2 L 801.6 629.7 L 807.1 632.0 L 812.8 633.9 L " +
      "818.8 635.5 L 825.0 636.8 L 831.4 637.7 L 838.1 638.3 L 845.0 638.5 Z",
    class: "fill-role-agent/35",
  },
  {
    d:
      "M 976.0 119.0 L 972.8 119.1 L 969.7 119.3 L 966.8 119.6 L 964.0 120.0 L 961.3 120.6 L 958.8 " +
      "121.3 L 956.4 122.1 L 954.1 123.0 L 951.9 124.0 L 949.8 125.1 L 947.8 126.3 L 945.9 127.6 L " +
      "944.1 129.0 L 942.4 130.4 L 940.7 131.9 L 939.2 133.5 L 937.7 135.1 L 936.2 136.8 L 934.9 138.6 " +
      "L 933.6 140.4 L 932.3 142.2 L 931.1 144.1 L 929.9 145.9 L 928.8 147.9 L 927.7 149.8 L 926.6 " +
      "151.7 L 925.5 153.7 L 924.5 155.7 L 923.4 157.6 L 922.4 159.6 L 921.3 161.5 L 920.3 163.5 L " +
      "919.2 165.4 L 918.1 167.3 L 917.0 169.1 L 915.9 171.0 L 914.8 172.7 L 913.6 174.5 L 912.4 176.2 " +
      "L 911.1 177.8 L 909.8 179.4 L 908.3 180.8 L 906.7 182.1 L 905.0 183.2 L 903.1 184.0 L 901.2 " +
      "184.7 L 899.2 185.2 L 896.9 185.5 L 902.7 194.8 L 904.2 192.9 L 905.7 190.9 L 907.1 188.9 L " +
      "908.5 187.1 L 909.8 185.2 L 911.2 183.5 L 912.5 181.7 L 913.9 180.0 L 915.2 178.2 L 916.4 176.4 " +
      "L 917.6 174.6 L 918.7 172.7 L 919.8 170.8 L 920.9 168.9 L 922.0 166.9 L 923.0 164.9 L 924.0 " +
      "163.0 L 925.0 161.0 L 926.0 159.0 L 927.0 157.0 L 928.0 155.0 L 929.0 153.1 L 930.1 151.1 L " +
      "931.1 149.2 L 932.2 147.3 L 933.3 145.4 L 934.5 143.6 L 935.6 141.8 L 936.9 140.1 L 938.2 138.4 " +
      "L 939.5 136.7 L 940.9 135.1 L 942.4 133.6 L 943.9 132.1 L 945.5 130.7 L 947.2 129.4 L 949.0 " +
      "128.2 L 950.9 127.0 L 952.8 126.0 L 954.9 125.0 L 957.1 124.1 L 959.4 123.3 L 961.8 122.6 L " +
      "964.4 122.1 L 967.1 121.6 L 969.9 121.3 L 972.9 121.1 L 976.0 121.0 Z",
    class: "fill-role-agent/55",
  },
  {
    d:
      "M 976.0 205.0 L 973.8 205.0 L 971.6 205.0 L 969.5 205.0 L 967.5 205.0 L 965.5 205.0 L 963.6 " +
      "204.9 L 961.7 204.9 L 959.9 204.9 L 958.1 204.9 L 956.3 204.9 L 954.7 204.9 L 953.0 204.8 L " +
      "951.4 204.8 L 949.8 204.8 L 948.3 204.8 L 946.8 204.8 L 945.3 204.7 L 943.9 204.7 L 942.4 204.7 " +
      "L 941.0 204.7 L 939.7 204.7 L 938.3 204.6 L 937.0 204.6 L 935.7 204.6 L 934.4 204.6 L 933.1 " +
      "204.6 L 931.8 204.5 L 930.6 204.5 L 929.3 204.5 L 928.0 204.5 L 926.8 204.5 L 925.5 204.4 L " +
      "924.3 204.4 L 923.0 204.4 L 921.8 204.4 L 920.5 204.3 L 919.2 204.3 L 918.0 204.2 L 916.6 204.1 " +
      "L 915.3 203.9 L 914.0 203.7 L 912.6 203.4 L 911.3 203.1 L 909.9 202.7 L 908.4 202.3 L 907.0 " +
      "201.8 L 905.5 201.2 L 904.0 200.5 L 904.0 211.5 L 905.5 210.8 L 907.0 210.2 L 908.4 209.7 L " +
      "909.9 209.3 L 911.3 208.9 L 912.6 208.6 L 914.0 208.3 L 915.3 208.1 L 916.6 207.9 L 918.0 207.8 " +
      "L 919.2 207.7 L 920.5 207.7 L 921.8 207.6 L 923.0 207.6 L 924.3 207.6 L 925.5 207.6 L 926.8 " +
      "207.5 L 928.0 207.5 L 929.3 207.5 L 930.6 207.5 L 931.8 207.5 L 933.1 207.4 L 934.4 207.4 L " +
      "935.7 207.4 L 937.0 207.4 L 938.3 207.4 L 939.7 207.3 L 941.0 207.3 L 942.4 207.3 L 943.9 207.3 " +
      "L 945.3 207.3 L 946.8 207.2 L 948.3 207.2 L 949.8 207.2 L 951.4 207.2 L 953.0 207.2 L 954.7 " +
      "207.1 L 956.3 207.1 L 958.1 207.1 L 959.9 207.1 L 961.7 207.1 L 963.6 207.1 L 965.5 207.0 L " +
      "967.5 207.0 L 969.5 207.0 L 971.6 207.0 L 973.8 207.0 L 976.0 207.0 Z",
    class: "fill-role-agent/55",
  },
  {
    d:
      "M 976.0 291.0 L 972.9 290.9 L 969.9 290.7 L 967.1 290.4 L 964.4 289.9 L 961.8 289.4 L 959.4 " +
      "288.7 L 957.1 287.9 L 954.9 287.0 L 952.8 286.0 L 950.9 285.0 L 949.0 283.8 L 947.2 282.6 L " +
      "945.5 281.3 L 943.9 279.9 L 942.4 278.4 L 940.9 276.9 L 939.5 275.3 L 938.2 273.6 L 936.9 271.9 " +
      "L 935.6 270.2 L 934.5 268.4 L 933.3 266.6 L 932.2 264.7 L 931.1 262.8 L 930.1 260.9 L 929.0 " +
      "258.9 L 928.0 257.0 L 927.0 255.0 L 926.0 253.0 L 925.0 251.0 L 924.0 249.0 L 923.0 247.1 L " +
      "922.0 245.1 L 920.9 243.1 L 919.8 241.2 L 918.7 239.3 L 917.6 237.4 L 916.4 235.6 L 915.2 233.8 " +
      "L 913.9 232.0 L 912.5 230.3 L 911.2 228.5 L 909.8 226.8 L 908.5 224.9 L 907.1 223.1 L 905.7 " +
      "221.1 L 904.2 219.1 L 902.7 217.2 L 896.9 226.5 L 899.2 226.8 L 901.2 227.3 L 903.1 228.0 L " +
      "905.0 228.8 L 906.7 229.9 L 908.3 231.2 L 909.8 232.6 L 911.1 234.2 L 912.4 235.8 L 913.6 237.5 " +
      "L 914.8 239.3 L 915.9 241.0 L 917.0 242.9 L 918.1 244.7 L 919.2 246.6 L 920.3 248.5 L 921.3 " +
      "250.5 L 922.4 252.4 L 923.4 254.4 L 924.5 256.3 L 925.5 258.3 L 926.6 260.3 L 927.7 262.2 L " +
      "928.8 264.1 L 929.9 266.1 L 931.1 267.9 L 932.3 269.8 L 933.6 271.6 L 934.9 273.4 L 936.2 275.2 " +
      "L 937.7 276.9 L 939.2 278.5 L 940.7 280.1 L 942.4 281.6 L 944.1 283.0 L 945.9 284.4 L 947.8 " +
      "285.7 L 949.8 286.9 L 951.9 288.0 L 954.1 289.0 L 956.4 289.9 L 958.8 290.7 L 961.3 291.4 L " +
      "964.0 292.0 L 966.8 292.4 L 969.7 292.7 L 972.8 292.9 L 976.0 293.0 Z",
    class: "fill-role-agent/55",
  },
  {
    d:
      "M 976.0 399.0 L 973.5 399.0 L 971.1 399.1 L 968.7 399.3 L 966.5 399.5 L 964.3 399.8 L 962.2 " +
      "400.1 L 960.1 400.5 L 958.1 400.9 L 956.2 401.4 L 954.3 401.9 L 952.5 402.5 L 950.8 403.1 L " +
      "949.1 403.7 L 947.5 404.4 L 945.9 405.1 L 944.3 405.9 L 942.8 406.7 L 941.3 407.5 L 939.9 408.3 " +
      "L 938.5 409.2 L 937.1 410.1 L 935.8 410.9 L 934.5 411.9 L 933.2 412.8 L 931.9 413.7 L 930.7 " +
      "414.6 L 929.4 415.6 L 928.2 416.5 L 927.0 417.4 L 925.8 418.4 L 924.6 419.3 L 923.4 420.2 L " +
      "922.2 421.1 L 921.0 422.0 L 919.8 422.9 L 918.5 423.8 L 917.3 424.6 L 916.0 425.4 L 914.8 426.2 " +
      "L 913.4 426.8 L 912.0 427.4 L 910.6 427.9 L 909.1 428.3 L 907.5 428.6 L 906.0 428.8 L 904.4 " +
      "428.8 L 902.7 428.7 L 900.9 428.5 L 904.3 439.0 L 905.8 437.7 L 907.3 436.5 L 908.7 435.3 L " +
      "910.1 434.2 L 911.4 433.1 L 912.8 432.1 L 914.1 431.1 L 915.4 430.1 L 916.6 429.2 L 917.9 428.3 " +
      "L 919.2 427.4 L 920.5 426.4 L 921.7 425.5 L 922.9 424.6 L 924.1 423.6 L 925.3 422.7 L 926.5 " +
      "421.7 L 927.7 420.7 L 928.9 419.8 L 930.0 418.8 L 931.2 417.8 L 932.4 416.9 L 933.6 415.9 L " +
      "934.8 415.0 L 936.1 414.1 L 937.3 413.1 L 938.6 412.2 L 939.9 411.4 L 941.2 410.5 L 942.6 409.7 " +
      "L 944.0 408.8 L 945.4 408.1 L 946.9 407.3 L 948.4 406.6 L 950.0 405.9 L 951.6 405.2 L 953.3 " +
      "404.6 L 955.0 404.0 L 956.8 403.5 L 958.6 403.0 L 960.5 402.6 L 962.5 402.2 L 964.6 401.8 L " +
      "966.7 401.5 L 968.9 401.3 L 971.2 401.1 L 973.5 401.0 L 976.0 401.0 Z",
    class: "fill-role-agent/55",
  },
  {
    d:
      "M 976.0 485.0 L 973.5 485.0 L 971.2 484.9 L 968.9 484.7 L 966.7 484.5 L 964.6 484.2 L 962.5 " +
      "483.8 L 960.5 483.4 L 958.6 483.0 L 956.8 482.5 L 955.0 482.0 L 953.3 481.4 L 951.6 480.8 L " +
      "950.0 480.1 L 948.4 479.4 L 946.9 478.7 L 945.4 477.9 L 944.0 477.2 L 942.6 476.3 L 941.2 475.5 " +
      "L 939.9 474.6 L 938.6 473.8 L 937.3 472.9 L 936.1 471.9 L 934.8 471.0 L 933.6 470.1 L 932.4 " +
      "469.1 L 931.2 468.2 L 930.0 467.2 L 928.9 466.2 L 927.7 465.3 L 926.5 464.3 L 925.3 463.3 L " +
      "924.1 462.4 L 922.9 461.4 L 921.7 460.5 L 920.5 459.6 L 919.2 458.6 L 917.9 457.7 L 916.6 456.8 " +
      "L 915.4 455.9 L 914.1 454.9 L 912.8 453.9 L 911.4 452.9 L 910.1 451.8 L 908.7 450.7 L 907.3 " +
      "449.5 L 905.8 448.3 L 904.3 447.0 L 900.9 457.5 L 902.7 457.3 L 904.4 457.2 L 906.0 457.2 L " +
      "907.5 457.4 L 909.1 457.7 L 910.6 458.1 L 912.0 458.6 L 913.4 459.2 L 914.8 459.8 L 916.0 460.6 " +
      "L 917.3 461.4 L 918.5 462.2 L 919.8 463.1 L 921.0 464.0 L 922.2 464.9 L 923.4 465.8 L 924.6 " +
      "466.7 L 925.8 467.6 L 927.0 468.6 L 928.2 469.5 L 929.4 470.4 L 930.7 471.4 L 931.9 472.3 L " +
      "933.2 473.2 L 934.5 474.1 L 935.8 475.1 L 937.1 475.9 L 938.5 476.8 L 939.9 477.7 L 941.3 478.5 " +
      "L 942.8 479.3 L 944.3 480.1 L 945.9 480.9 L 947.5 481.6 L 949.1 482.3 L 950.8 482.9 L 952.5 " +
      "483.5 L 954.3 484.1 L 956.2 484.6 L 958.1 485.1 L 960.1 485.5 L 962.2 485.9 L 964.3 486.2 L " +
      "966.5 486.5 L 968.7 486.7 L 971.1 486.9 L 973.5 487.0 L 976.0 487.0 Z",
    class: "fill-role-agent/55",
  },
  {
    d:
      "M 976.0 593.0 L 973.5 593.0 L 971.1 593.1 L 968.7 593.3 L 966.5 593.5 L 964.3 593.8 L 962.2 " +
      "594.1 L 960.1 594.5 L 958.1 594.9 L 956.2 595.4 L 954.3 595.9 L 952.5 596.5 L 950.8 597.1 L " +
      "949.1 597.7 L 947.5 598.4 L 945.9 599.1 L 944.3 599.9 L 942.8 600.7 L 941.3 601.5 L 939.9 602.3 " +
      "L 938.5 603.2 L 937.1 604.1 L 935.8 604.9 L 934.5 605.9 L 933.2 606.8 L 931.9 607.7 L 930.7 " +
      "608.6 L 929.4 609.6 L 928.2 610.5 L 927.0 611.4 L 925.8 612.4 L 924.6 613.3 L 923.4 614.2 L " +
      "922.2 615.1 L 921.0 616.0 L 919.8 616.9 L 918.5 617.8 L 917.3 618.6 L 916.0 619.4 L 914.8 620.2 " +
      "L 913.4 620.8 L 912.0 621.4 L 910.6 621.9 L 909.1 622.3 L 907.5 622.6 L 906.0 622.8 L 904.4 " +
      "622.8 L 902.7 622.7 L 900.9 622.5 L 904.3 633.0 L 905.8 631.7 L 907.3 630.5 L 908.7 629.3 L " +
      "910.1 628.2 L 911.4 627.1 L 912.8 626.1 L 914.1 625.1 L 915.4 624.1 L 916.6 623.2 L 917.9 622.3 " +
      "L 919.2 621.4 L 920.5 620.4 L 921.7 619.5 L 922.9 618.6 L 924.1 617.6 L 925.3 616.7 L 926.5 " +
      "615.7 L 927.7 614.7 L 928.9 613.8 L 930.0 612.8 L 931.2 611.8 L 932.4 610.9 L 933.6 609.9 L " +
      "934.8 609.0 L 936.1 608.1 L 937.3 607.1 L 938.6 606.2 L 939.9 605.4 L 941.2 604.5 L 942.6 603.7 " +
      "L 944.0 602.8 L 945.4 602.1 L 946.9 601.3 L 948.4 600.6 L 950.0 599.9 L 951.6 599.2 L 953.3 " +
      "598.6 L 955.0 598.0 L 956.8 597.5 L 958.6 597.0 L 960.5 596.6 L 962.5 596.2 L 964.6 595.8 L " +
      "966.7 595.5 L 968.9 595.3 L 971.2 595.1 L 973.5 595.0 L 976.0 595.0 Z",
    class: "fill-role-agent/55",
  },
  {
    d:
      "M 976.0 679.0 L 973.5 679.0 L 971.2 678.9 L 968.9 678.7 L 966.7 678.5 L 964.6 678.2 L 962.5 " +
      "677.8 L 960.5 677.4 L 958.6 677.0 L 956.8 676.5 L 955.0 676.0 L 953.3 675.4 L 951.6 674.8 L " +
      "950.0 674.1 L 948.4 673.4 L 946.9 672.7 L 945.4 671.9 L 944.0 671.2 L 942.6 670.3 L 941.2 669.5 " +
      "L 939.9 668.6 L 938.6 667.8 L 937.3 666.9 L 936.1 665.9 L 934.8 665.0 L 933.6 664.1 L 932.4 " +
      "663.1 L 931.2 662.2 L 930.0 661.2 L 928.9 660.2 L 927.7 659.3 L 926.5 658.3 L 925.3 657.3 L " +
      "924.1 656.4 L 922.9 655.4 L 921.7 654.5 L 920.5 653.6 L 919.2 652.6 L 917.9 651.7 L 916.6 650.8 " +
      "L 915.4 649.9 L 914.1 648.9 L 912.8 647.9 L 911.4 646.9 L 910.1 645.8 L 908.7 644.7 L 907.3 " +
      "643.5 L 905.8 642.3 L 904.3 641.0 L 900.9 651.5 L 902.7 651.3 L 904.4 651.2 L 906.0 651.2 L " +
      "907.5 651.4 L 909.1 651.7 L 910.6 652.1 L 912.0 652.6 L 913.4 653.2 L 914.8 653.8 L 916.0 654.6 " +
      "L 917.3 655.4 L 918.5 656.2 L 919.8 657.1 L 921.0 658.0 L 922.2 658.9 L 923.4 659.8 L 924.6 " +
      "660.7 L 925.8 661.6 L 927.0 662.6 L 928.2 663.5 L 929.4 664.4 L 930.7 665.4 L 931.9 666.3 L " +
      "933.2 667.2 L 934.5 668.1 L 935.8 669.1 L 937.1 669.9 L 938.5 670.8 L 939.9 671.7 L 941.3 672.5 " +
      "L 942.8 673.3 L 944.3 674.1 L 945.9 674.9 L 947.5 675.6 L 949.1 676.3 L 950.8 676.9 L 952.5 " +
      "677.5 L 954.3 678.1 L 956.2 678.6 L 958.1 679.1 L 960.1 679.5 L 962.2 679.9 L 964.3 680.2 L " +
      "966.5 680.5 L 968.7 680.7 L 971.1 680.9 L 973.5 681.0 L 976.0 681.0 Z",
    class: "fill-role-agent/55",
  },
  {
    d: "M 413.8 351.3 A 129.904 129.904 0 0 0 413.8 448.7",
    "stroke-width": "13.989644956588746",
    "stroke-linecap": "round",
    class: "fill-none stroke-role-source",
  },
  {
    d: "M 165.5 392.3 A 32 32 0 0 0 165.5 407.7",
    "stroke-width": "3.997041416168213",
    "stroke-linecap": "round",
    class: "fill-none stroke-role-source",
  },
  {
    d: "M 649.0 339.2 A 129.904 129.904 0 0 1 645.0 468.0",
    "stroke-width": "13.989644956588746",
    "stroke-linecap": "round",
    class: "fill-none stroke-role-agent",
  },
  {
    d: "M 897.0 186.0 A 32 32 0 0 1 897.0 226.0",
    "stroke-width": "3.997041416168213",
    "stroke-linecap": "round",
    class: "fill-none stroke-role-agent",
  },
  {
    d: "M 900.8 429.0 A 32 32 0 0 1 900.8 457.0",
    "stroke-width": "3.997041416168213",
    "stroke-linecap": "round",
    class: "fill-none stroke-role-agent",
  },
  {
    d: "M 900.8 623.0 A 32 32 0 0 1 900.8 651.0",
    "stroke-width": "3.997041416168213",
    "stroke-linecap": "round",
    class: "fill-none stroke-role-agent",
  },
  {
    d:
      "M 223.5 356.3 L 227.5 356.3 L 231.4 356.4 L 235.2 356.6 L 239.0 356.9 L 242.7 357.2 L 246.4 " +
      "357.5 L 250.0 358.0 L 253.5 358.4 L 257.1 359.0 L 260.5 359.6 L 263.9 360.2 L 267.3 360.9 L " +
      "270.6 361.6 L 273.9 362.3 L 277.1 363.1 L 280.3 363.9 L 283.5 364.8 L 286.6 365.6 L 289.7 366.5 " +
      "L 292.8 367.5 L 295.8 368.4 L 298.8 369.3 L 301.8 370.3 L 304.7 371.3 L 307.6 372.3 L 310.5 " +
      "373.3 L 313.4 374.2 L 316.3 375.2 L 319.1 376.2 L 322.0 377.2 L 324.8 378.2 L 327.6 379.1 L " +
      "330.4 380.1 L 333.2 381.0 L 336.0 381.9 L 338.8 382.8 L 341.6 383.6 L 344.4 384.4 L 347.2 385.2 " +
      "L 350.0 386.0 L 352.8 386.8 L 355.5 387.7 L 358.3 388.7 L 361.0 389.8 L 363.8 391.1 L 366.5 " +
      "392.4 L 369.3 393.9 L 372.1 395.6 L 373.9 380.5 L 371.0 381.4 L 368.1 382.1 L 365.2 382.6 L " +
      "362.4 382.8 L 359.5 382.8 L 356.7 382.6 L 353.9 382.2 L 351.1 381.6 L 348.3 381.0 L 345.6 380.2 " +
      "L 342.8 379.5 L 340.0 378.7 L 337.2 377.9 L 334.5 377.1 L 331.7 376.2 L 328.9 375.3 L 326.0 " +
      "374.4 L 323.2 373.5 L 320.3 372.6 L 317.5 371.7 L 314.6 370.8 L 311.7 369.8 L 308.7 368.9 L " +
      "305.8 368.0 L 302.8 367.0 L 299.8 366.1 L 296.7 365.2 L 293.7 364.3 L 290.6 363.5 L 287.4 362.6 " +
      "L 284.3 361.8 L 281.1 361.0 L 277.8 360.2 L 274.5 359.4 L 271.2 358.7 L 267.9 358.0 L 264.4 " +
      "357.4 L 261.0 356.8 L 257.5 356.3 L 253.9 355.7 L 250.3 355.3 L 246.7 354.9 L 242.9 354.5 L " +
      "239.2 354.3 L 235.3 354.0 L 231.5 353.9 L 227.5 353.8 L 223.5 353.7 Z",
    class: "fill-role-source/35",
  },
  {
    d:
      "M 223.5 626.3 L 229.7 626.1 L 235.6 625.5 L 241.3 624.6 L 246.8 623.4 L 252.0 621.9 L 257.0 " +
      "620.0 L 261.8 617.8 L 266.3 615.4 L 270.7 612.7 L 274.9 609.7 L 278.9 606.5 L 282.8 603.1 L " +
      "286.4 599.5 L 290.0 595.7 L 293.3 591.7 L 296.6 587.5 L 299.7 583.2 L 302.7 578.8 L 305.6 574.2 " +
      "L 308.4 569.5 L 311.2 564.8 L 313.8 559.9 L 316.4 555.0 L 318.9 550.0 L 321.4 545.0 L 323.8 " +
      "540.0 L 326.2 535.0 L 328.6 529.9 L 331.0 524.9 L 333.3 519.9 L 335.7 515.0 L 338.1 510.1 L " +
      "340.5 505.3 L 343.0 500.6 L 345.5 496.0 L 348.0 491.5 L 350.6 487.1 L 353.3 482.9 L 356.0 478.9 " +
      "L 358.8 475.0 L 361.7 471.3 L 364.7 467.8 L 367.9 464.5 L 371.2 461.6 L 374.9 459.2 L 378.9 " +
      "457.5 L 383.2 456.5 L 387.8 456.1 L 380.4 442.8 L 377.3 446.7 L 374.0 450.6 L 370.9 454.2 L " +
      "367.7 457.8 L 364.5 461.2 L 361.3 464.7 L 358.2 468.4 L 355.2 472.3 L 352.4 476.3 L 349.6 480.6 " +
      "L 346.9 484.9 L 344.3 489.4 L 341.8 494.0 L 339.4 498.7 L 337.0 503.5 L 334.6 508.4 L 332.2 " +
      "513.3 L 329.9 518.3 L 327.6 523.3 L 325.3 528.4 L 323.0 533.4 L 320.6 538.5 L 318.3 543.5 L " +
      "315.8 548.5 L 313.4 553.5 L 310.9 558.4 L 308.3 563.2 L 305.7 567.9 L 303.0 572.6 L 300.1 577.1 " +
      "L 297.2 581.5 L 294.2 585.7 L 291.0 589.8 L 287.8 593.8 L 284.4 597.5 L 280.8 601.1 L 277.1 " +
      "604.4 L 273.3 607.5 L 269.2 610.4 L 265.0 613.1 L 260.6 615.4 L 256.0 617.6 L 251.1 619.4 L " +
      "246.1 620.9 L 240.8 622.1 L 235.3 623.0 L 229.5 623.5 L 223.5 623.7 Z",
    class: "fill-role-source/35",
  },
  {
    d:
      "M 119.5 175.8 L 124.5 176.0 L 129.0 176.4 L 133.2 177.2 L 137.0 178.2 L 140.5 179.4 L 143.7 " +
      "180.9 L 146.5 182.6 L 149.1 184.6 L 151.3 186.7 L 153.4 189.1 L 155.1 191.6 L 156.7 194.4 L " +
      "158.0 197.3 L 159.1 200.4 L 160.0 203.7 L 160.7 207.1 L 161.3 210.7 L 161.7 214.3 L 162.0 218.1 " +
      "L 162.2 222.1 L 162.2 226.1 L 162.1 230.2 L 162.0 234.4 L 161.8 238.6 L 161.5 242.9 L 161.2 " +
      "247.3 L 160.8 251.7 L 160.5 256.1 L 160.1 260.5 L 159.8 264.9 L 159.5 269.3 L 159.2 273.7 L " +
      "159.0 278.1 L 158.8 282.4 L 158.8 286.7 L 158.8 290.9 L 158.9 295.1 L 159.2 299.2 L 159.7 303.2 " +
      "L 160.2 307.1 L 161.0 310.9 L 162.0 314.6 L 163.1 318.1 L 164.5 321.5 L 166.0 324.9 L 167.5 " +
      "328.3 L 169.0 331.9 L 170.4 335.5 L 177.3 329.3 L 174.0 327.7 L 171.3 325.7 L 169.1 323.2 L " +
      "167.4 320.2 L 166.1 317.0 L 164.9 313.7 L 164.0 310.2 L 163.2 306.6 L 162.6 302.8 L 162.1 298.9 " +
      "L 161.8 294.9 L 161.6 290.9 L 161.5 286.7 L 161.5 282.5 L 161.6 278.2 L 161.8 273.9 L 162.0 " +
      "269.5 L 162.3 265.1 L 162.6 260.7 L 162.9 256.2 L 163.2 251.8 L 163.5 247.4 L 163.8 243.1 L " +
      "164.0 238.7 L 164.2 234.5 L 164.3 230.2 L 164.3 226.1 L 164.2 222.0 L 164.0 218.0 L 163.7 214.1 " +
      "L 163.3 210.4 L 162.7 206.7 L 161.9 203.2 L 160.9 199.8 L 159.7 196.6 L 158.3 193.5 L 156.7 " +
      "190.7 L 154.8 188.0 L 152.7 185.5 L 150.2 183.2 L 147.5 181.1 L 144.5 179.3 L 141.2 177.8 L " +
      "137.5 176.5 L 133.6 175.5 L 129.2 174.8 L 124.6 174.3 L 119.5 174.2 Z",
    class: "fill-role-source/35",
  },
  {
    d:
      "M 119.5 265.8 L 122.1 265.9 L 124.6 266.1 L 126.9 266.5 L 129.1 267.0 L 131.1 267.6 L 132.9 " +
      "268.3 L 134.7 269.2 L 136.3 270.1 L 137.8 271.2 L 139.1 272.4 L 140.4 273.6 L 141.6 275.0 L " +
      "142.6 276.4 L 143.6 277.9 L 144.5 279.5 L 145.4 281.1 L 146.1 282.8 L 146.9 284.6 L 147.5 286.5 " +
      "L 148.1 288.4 L 148.6 290.3 L 149.1 292.3 L 149.6 294.3 L 150.0 296.3 L 150.5 298.4 L 150.8 " +
      "300.5 L 151.2 302.6 L 151.6 304.7 L 152.0 306.8 L 152.4 308.9 L 152.8 310.9 L 153.2 313.0 L " +
      "153.6 315.1 L 154.1 317.1 L 154.6 319.1 L 155.2 321.1 L 155.8 323.0 L 156.5 324.9 L 157.2 326.8 " +
      "L 158.0 328.6 L 158.9 330.3 L 159.8 332.0 L 160.8 333.7 L 161.7 335.5 L 162.8 337.2 L 163.9 " +
      "339.0 L 165.2 340.8 L 166.4 342.6 L 171.5 334.8 L 169.6 334.5 L 168.0 334.1 L 166.5 333.4 L " +
      "165.1 332.6 L 163.8 331.5 L 162.6 330.2 L 161.6 328.8 L 160.7 327.2 L 159.9 325.6 L 159.2 323.9 " +
      "L 158.5 322.1 L 157.9 320.3 L 157.3 318.4 L 156.7 316.4 L 156.2 314.5 L 155.7 312.5 L 155.3 " +
      "310.4 L 154.8 308.4 L 154.4 306.3 L 154.0 304.2 L 153.6 302.1 L 153.1 300.0 L 152.7 297.9 L " +
      "152.2 295.8 L 151.8 293.8 L 151.3 291.7 L 150.7 289.7 L 150.1 287.7 L 149.5 285.8 L 148.8 283.9 " +
      "L 148.0 282.0 L 147.2 280.3 L 146.3 278.5 L 145.3 276.9 L 144.2 275.3 L 143.0 273.7 L 141.8 " +
      "272.3 L 140.4 271.0 L 138.9 269.8 L 137.3 268.6 L 135.5 267.6 L 133.7 266.7 L 131.7 266.0 L " +
      "129.5 265.3 L 127.2 264.8 L 124.8 264.4 L 122.2 264.2 L 119.5 264.2 Z",
    class: "fill-role-source/35",
  },
  {
    d:
      "M 119.5 355.8 L 120.9 355.8 L 122.2 355.9 L 123.5 355.9 L 124.8 355.9 L 126.1 355.9 L 127.3 " +
      "355.9 L 128.4 355.9 L 129.6 355.9 L 130.7 355.9 L 131.8 356.0 L 132.8 356.0 L 133.9 356.0 L " +
      "134.9 356.0 L 135.9 356.0 L 136.8 356.0 L 137.8 356.0 L 138.7 356.1 L 139.6 356.1 L 140.5 356.1 " +
      "L 141.3 356.1 L 142.2 356.1 L 143.0 356.1 L 143.9 356.2 L 144.7 356.2 L 145.5 356.2 L 146.3 " +
      "356.2 L 147.1 356.2 L 147.9 356.3 L 148.7 356.3 L 149.5 356.3 L 150.3 356.3 L 151.0 356.3 L " +
      "151.8 356.4 L 152.6 356.4 L 153.4 356.5 L 154.2 356.6 L 155.0 356.7 L 155.8 356.8 L 156.6 357.0 " +
      "L 157.4 357.2 L 158.3 357.4 L 159.1 357.6 L 160.0 357.9 L 160.8 358.2 L 161.7 358.5 L 162.6 " +
      "358.8 L 163.6 359.2 L 164.5 359.6 L 164.5 350.4 L 163.6 350.8 L 162.6 351.2 L 161.7 351.5 L " +
      "160.8 351.8 L 160.0 352.1 L 159.1 352.4 L 158.3 352.6 L 157.4 352.8 L 156.6 353.0 L 155.8 353.2 " +
      "L 155.0 353.3 L 154.2 353.4 L 153.4 353.5 L 152.6 353.6 L 151.8 353.6 L 151.0 353.7 L 150.3 " +
      "353.7 L 149.5 353.7 L 148.7 353.7 L 147.9 353.7 L 147.1 353.8 L 146.3 353.8 L 145.5 353.8 L " +
      "144.7 353.8 L 143.9 353.8 L 143.0 353.9 L 142.2 353.9 L 141.3 353.9 L 140.5 353.9 L 139.6 353.9 " +
      "L 138.7 353.9 L 137.8 354.0 L 136.8 354.0 L 135.9 354.0 L 134.9 354.0 L 133.9 354.0 L 132.8 " +
      "354.0 L 131.8 354.0 L 130.7 354.1 L 129.6 354.1 L 128.4 354.1 L 127.3 354.1 L 126.1 354.1 L " +
      "124.8 354.1 L 123.5 354.1 L 122.2 354.1 L 120.9 354.2 L 119.5 354.2 Z",
    class: "fill-role-source/35",
  },
  {
    d:
      "M 119.5 445.8 L 122.2 445.8 L 124.8 445.6 L 127.2 445.2 L 129.5 444.7 L 131.7 444.0 L 133.7 " +
      "443.3 L 135.5 442.4 L 137.3 441.4 L 138.9 440.2 L 140.4 439.0 L 141.8 437.7 L 143.0 436.3 L " +
      "144.2 434.7 L 145.3 433.1 L 146.3 431.5 L 147.2 429.7 L 148.0 428.0 L 148.8 426.1 L 149.5 424.2 " +
      "L 150.1 422.3 L 150.7 420.3 L 151.3 418.3 L 151.8 416.2 L 152.2 414.2 L 152.7 412.1 L 153.1 " +
      "410.0 L 153.6 407.9 L 154.0 405.8 L 154.4 403.7 L 154.8 401.6 L 155.3 399.6 L 155.7 397.5 L " +
      "156.2 395.5 L 156.7 393.6 L 157.3 391.6 L 157.9 389.7 L 158.5 387.9 L 159.2 386.1 L 159.9 384.4 " +
      "L 160.7 382.8 L 161.6 381.2 L 162.6 379.8 L 163.8 378.5 L 165.1 377.4 L 166.5 376.6 L 168.0 " +
      "375.9 L 169.6 375.5 L 171.5 375.2 L 166.4 367.4 L 165.2 369.2 L 163.9 371.0 L 162.8 372.8 L " +
      "161.7 374.5 L 160.8 376.3 L 159.8 378.0 L 158.9 379.7 L 158.0 381.4 L 157.2 383.2 L 156.5 385.1 " +
      "L 155.8 387.0 L 155.2 388.9 L 154.6 390.9 L 154.1 392.9 L 153.6 394.9 L 153.2 397.0 L 152.8 " +
      "399.1 L 152.4 401.1 L 152.0 403.2 L 151.6 405.3 L 151.2 407.4 L 150.8 409.5 L 150.5 411.6 L " +
      "150.0 413.7 L 149.6 415.7 L 149.1 417.7 L 148.6 419.7 L 148.1 421.6 L 147.5 423.5 L 146.9 425.4 " +
      "L 146.1 427.2 L 145.4 428.9 L 144.5 430.5 L 143.6 432.1 L 142.6 433.6 L 141.6 435.0 L 140.4 " +
      "436.4 L 139.1 437.6 L 137.8 438.8 L 136.3 439.9 L 134.7 440.8 L 132.9 441.7 L 131.1 442.4 L " +
      "129.1 443.0 L 126.9 443.5 L 124.6 443.9 L 122.1 444.1 L 119.5 444.2 Z",
    class: "fill-role-source/35",
  },
  {
    d:
      "M 119.5 535.8 L 124.6 535.7 L 129.2 535.2 L 133.6 534.5 L 137.5 533.5 L 141.2 532.2 L 144.5 " +
      "530.7 L 147.5 528.9 L 150.2 526.8 L 152.7 524.5 L 154.8 522.0 L 156.7 519.3 L 158.3 516.5 L " +
      "159.7 513.4 L 160.9 510.2 L 161.9 506.8 L 162.7 503.3 L 163.3 499.6 L 163.7 495.9 L 164.0 492.0 " +
      "L 164.2 488.0 L 164.3 483.9 L 164.3 479.8 L 164.2 475.5 L 164.0 471.3 L 163.8 466.9 L 163.5 " +
      "462.6 L 163.2 458.2 L 162.9 453.8 L 162.6 449.3 L 162.3 444.9 L 162.0 440.5 L 161.8 436.1 L " +
      "161.6 431.8 L 161.5 427.5 L 161.5 423.3 L 161.6 419.1 L 161.8 415.1 L 162.1 411.1 L 162.6 407.2 " +
      "L 163.2 403.4 L 164.0 399.8 L 164.9 396.3 L 166.1 393.0 L 167.4 389.8 L 169.1 386.8 L 171.3 " +
      "384.3 L 174.0 382.3 L 177.3 380.7 L 170.4 374.5 L 169.0 378.1 L 167.5 381.7 L 166.0 385.1 L " +
      "164.5 388.5 L 163.1 391.9 L 162.0 395.4 L 161.0 399.1 L 160.2 402.9 L 159.7 406.8 L 159.2 410.8 " +
      "L 158.9 414.9 L 158.8 419.1 L 158.8 423.3 L 158.8 427.6 L 159.0 431.9 L 159.2 436.3 L 159.5 " +
      "440.7 L 159.8 445.1 L 160.1 449.5 L 160.5 453.9 L 160.8 458.3 L 161.2 462.7 L 161.5 467.1 L " +
      "161.8 471.4 L 162.0 475.6 L 162.1 479.8 L 162.2 483.9 L 162.2 487.9 L 162.0 491.9 L 161.7 495.7 " +
      "L 161.3 499.3 L 160.7 502.9 L 160.0 506.3 L 159.1 509.6 L 158.0 512.7 L 156.7 515.6 L 155.1 " +
      "518.4 L 153.4 520.9 L 151.3 523.3 L 149.1 525.4 L 146.5 527.4 L 143.7 529.1 L 140.5 530.6 L " +
      "137.0 531.8 L 133.2 532.8 L 129.0 533.6 L 124.5 534.0 L 119.5 534.2 Z",
    class: "fill-role-source/35",
  },
  {
    d:
      "M 119.5 625.8 L 120.9 625.8 L 122.2 625.9 L 123.5 625.9 L 124.8 625.9 L 126.1 625.9 L 127.3 " +
      "625.9 L 128.4 625.9 L 129.6 625.9 L 130.7 625.9 L 131.8 626.0 L 132.8 626.0 L 133.9 626.0 L " +
      "134.9 626.0 L 135.9 626.0 L 136.8 626.0 L 137.8 626.0 L 138.7 626.1 L 139.6 626.1 L 140.5 626.1 " +
      "L 141.3 626.1 L 142.2 626.1 L 143.0 626.1 L 143.9 626.2 L 144.7 626.2 L 145.5 626.2 L 146.3 " +
      "626.2 L 147.1 626.2 L 147.9 626.3 L 148.7 626.3 L 149.5 626.3 L 150.3 626.3 L 151.0 626.3 L " +
      "151.8 626.4 L 152.6 626.4 L 153.4 626.5 L 154.2 626.6 L 155.0 626.7 L 155.8 626.8 L 156.6 627.0 " +
      "L 157.4 627.2 L 158.3 627.4 L 159.1 627.6 L 160.0 627.9 L 160.8 628.2 L 161.7 628.5 L 162.6 " +
      "628.8 L 163.6 629.2 L 164.5 629.6 L 164.5 620.4 L 163.6 620.8 L 162.6 621.2 L 161.7 621.5 L " +
      "160.8 621.8 L 160.0 622.1 L 159.1 622.4 L 158.3 622.6 L 157.4 622.8 L 156.6 623.0 L 155.8 623.2 " +
      "L 155.0 623.3 L 154.2 623.4 L 153.4 623.5 L 152.6 623.6 L 151.8 623.6 L 151.0 623.7 L 150.3 " +
      "623.7 L 149.5 623.7 L 148.7 623.7 L 147.9 623.7 L 147.1 623.8 L 146.3 623.8 L 145.5 623.8 L " +
      "144.7 623.8 L 143.9 623.8 L 143.0 623.9 L 142.2 623.9 L 141.3 623.9 L 140.5 623.9 L 139.6 623.9 " +
      "L 138.7 623.9 L 137.8 624.0 L 136.8 624.0 L 135.9 624.0 L 134.9 624.0 L 133.9 624.0 L 132.8 " +
      "624.0 L 131.8 624.0 L 130.7 624.1 L 129.6 624.1 L 128.4 624.1 L 127.3 624.1 L 126.1 624.1 L " +
      "124.8 624.1 L 123.5 624.1 L 122.2 624.1 L 120.9 624.2 L 119.5 624.2 Z",
    class: "fill-role-source/35",
  },
  {
    d:
      "M 741.0 301.7 L 736.6 301.8 L 732.3 302.0 L 728.1 302.4 L 723.9 302.9 L 719.9 303.6 L 716.0 " +
      "304.3 L 712.1 305.2 L 708.3 306.2 L 704.6 307.4 L 700.9 308.6 L 697.4 309.9 L 693.9 311.3 L " +
      "690.4 312.8 L 687.1 314.4 L 683.7 316.1 L 680.5 317.8 L 677.3 319.6 L 674.1 321.4 L 671.0 323.3 " +
      "L 667.9 325.3 L 664.9 327.2 L 661.9 329.2 L 659.0 331.3 L 656.1 333.3 L 653.2 335.4 L 650.3 " +
      "337.5 L 647.5 339.5 L 644.7 341.6 L 641.9 343.6 L 639.1 345.7 L 636.3 347.7 L 633.6 349.7 L " +
      "630.8 351.6 L 628.1 353.5 L 625.3 355.4 L 622.6 357.2 L 619.9 358.9 L 617.1 360.6 L 614.3 362.2 " +
      "L 611.6 363.8 L 608.8 365.2 L 605.9 366.5 L 603.0 367.5 L 600.0 368.1 L 596.9 368.5 L 593.8 " +
      "368.6 L 590.7 368.3 L 587.4 367.7 L 591.2 382.4 L 594.0 380.3 L 596.9 378.2 L 599.7 376.2 L " +
      "602.5 374.3 L 605.3 372.5 L 608.0 370.8 L 610.9 369.3 L 613.7 367.7 L 616.6 366.1 L 619.4 364.3 " +
      "L 622.2 362.6 L 624.9 360.7 L 627.7 358.8 L 630.4 356.9 L 633.2 354.9 L 635.9 352.9 L 638.7 " +
      "350.8 L 641.4 348.8 L 644.1 346.7 L 646.9 344.6 L 649.7 342.5 L 652.5 340.3 L 655.3 338.2 L " +
      "658.1 336.1 L 661.0 334.1 L 663.8 332.0 L 666.8 330.0 L 669.7 328.0 L 672.7 326.0 L 675.7 324.1 " +
      "L 678.8 322.3 L 682.0 320.5 L 685.1 318.7 L 688.4 317.1 L 691.7 315.5 L 695.0 314.0 L 698.4 " +
      "312.5 L 701.9 311.2 L 705.4 310.0 L 709.1 308.8 L 712.7 307.8 L 716.5 306.9 L 720.4 306.1 L " +
      "724.3 305.5 L 728.3 305.0 L 732.5 304.6 L 736.7 304.3 L 741.0 304.3 Z",
    class: "fill-role-agent/35",
  },
  {
    d:
      "M 741.0 497.7 L 736.7 497.6 L 732.4 497.4 L 728.3 497.0 L 724.3 496.5 L 720.3 495.8 L 716.4 " +
      "495.0 L 712.7 494.1 L 709.0 493.1 L 705.3 491.9 L 701.8 490.6 L 698.3 489.3 L 694.9 487.8 L " +
      "691.5 486.3 L 688.2 484.7 L 685.0 483.0 L 681.8 481.2 L 678.7 479.4 L 675.6 477.5 L 672.6 475.5 " +
      "L 669.6 473.5 L 666.7 471.5 L 663.7 469.4 L 660.9 467.3 L 658.0 465.2 L 655.2 463.1 L 652.4 " +
      "460.9 L 649.6 458.8 L 646.8 456.6 L 644.1 454.5 L 641.3 452.3 L 638.6 450.2 L 635.9 448.1 L " +
      "633.1 446.1 L 630.4 444.0 L 627.6 442.0 L 624.9 440.1 L 622.1 438.2 L 619.3 436.4 L 616.5 434.7 " +
      "L 613.7 433.0 L 610.8 431.4 L 608.0 429.8 L 605.2 428.1 L 602.4 426.3 L 599.6 424.4 L 596.8 " +
      "422.4 L 593.9 420.2 L 591.1 418.1 L 587.3 432.8 L 590.5 432.2 L 593.7 431.9 L 596.8 432.0 L " +
      "599.9 432.4 L 602.9 433.1 L 605.9 434.1 L 608.7 435.4 L 611.5 436.9 L 614.3 438.5 L 617.0 440.1 " +
      "L 619.8 441.8 L 622.5 443.6 L 625.3 445.5 L 628.0 447.4 L 630.7 449.3 L 633.5 451.3 L 636.2 " +
      "453.3 L 639.0 455.4 L 641.8 457.5 L 644.6 459.6 L 647.4 461.7 L 650.2 463.8 L 653.1 465.9 L " +
      "656.0 468.0 L 658.9 470.1 L 661.8 472.2 L 664.8 474.2 L 667.8 476.2 L 670.9 478.2 L 674.0 480.1 " +
      "L 677.1 482.0 L 680.3 483.9 L 683.6 485.6 L 686.9 487.3 L 690.3 488.9 L 693.7 490.5 L 697.2 " +
      "491.9 L 700.8 493.3 L 704.5 494.5 L 708.2 495.7 L 712.0 496.7 L 715.9 497.6 L 719.8 498.4 L " +
      "723.9 499.1 L 728.0 499.6 L 732.2 500.0 L 736.6 500.2 L 741.0 500.3 Z",
    class: "fill-role-agent/35",
  },
  {
    d:
      "M 845.0 248.2 L 843.0 248.2 L 841.1 248.3 L 839.3 248.5 L 837.6 248.8 L 836.0 249.2 L 834.4 " +
      "249.7 L 832.9 250.2 L 831.5 250.8 L 830.2 251.5 L 828.9 252.2 L 827.7 253.0 L 826.5 253.9 L " +
      "825.4 254.8 L 824.3 255.7 L 823.4 256.7 L 822.4 257.7 L 821.5 258.8 L 820.6 259.9 L 819.8 261.0 " +
      "L 819.0 262.2 L 818.3 263.4 L 817.5 264.6 L 816.8 265.8 L 816.1 267.0 L 815.5 268.2 L 814.8 " +
      "269.4 L 814.2 270.7 L 813.5 271.9 L 812.9 273.1 L 812.2 274.3 L 811.6 275.5 L 810.9 276.7 L " +
      "810.3 277.8 L 809.6 278.9 L 808.9 280.0 L 808.2 281.1 L 807.5 282.1 L 806.7 283.1 L 805.9 284.0 " +
      "L 805.0 284.8 L 804.1 285.6 L 803.1 286.2 L 802.0 286.7 L 801.0 287.1 L 799.8 287.4 L 798.7 " +
      "287.5 L 797.5 287.5 L 796.2 287.5 L 799.7 296.0 L 800.9 294.9 L 802.0 293.8 L 803.1 292.7 L " +
      "804.1 291.5 L 805.0 290.4 L 805.9 289.3 L 806.7 288.2 L 807.5 287.1 L 808.3 286.0 L 809.0 284.9 " +
      "L 809.8 283.8 L 810.5 282.6 L 811.3 281.5 L 811.9 280.3 L 812.6 279.1 L 813.2 277.9 L 813.9 " +
      "276.7 L 814.5 275.5 L 815.1 274.2 L 815.7 273.0 L 816.3 271.8 L 816.9 270.5 L 817.5 269.3 L " +
      "818.2 268.1 L 818.8 266.9 L 819.5 265.7 L 820.1 264.5 L 820.8 263.4 L 821.6 262.2 L 822.3 261.1 " +
      "L 823.1 260.1 L 823.9 259.1 L 824.8 258.1 L 825.7 257.1 L 826.7 256.2 L 827.7 255.4 L 828.7 " +
      "254.6 L 829.9 253.8 L 831.0 253.1 L 832.3 252.5 L 833.6 251.9 L 835.0 251.4 L 836.4 250.9 L " +
      "838.0 250.5 L 839.6 250.2 L 841.3 250.0 L 843.1 249.9 L 845.0 249.8 Z",
    class: "fill-role-agent/35",
  },
  {
    d:
      "M 845.0 347.2 L 843.3 347.1 L 841.6 347.0 L 840.0 346.8 L 838.5 346.6 L 837.0 346.2 L 835.6 " +
      "345.9 L 834.3 345.4 L 833.1 345.0 L 831.9 344.4 L 830.7 343.8 L 829.7 343.2 L 828.6 342.5 L " +
      "827.6 341.8 L 826.7 341.0 L 825.8 340.3 L 824.9 339.4 L 824.0 338.6 L 823.2 337.7 L 822.4 336.8 " +
      "L 821.7 335.8 L 821.0 334.9 L 820.2 333.9 L 819.5 332.9 L 818.9 331.9 L 818.2 330.9 L 817.5 " +
      "329.9 L 816.9 328.8 L 816.2 327.8 L 815.6 326.8 L 814.9 325.8 L 814.2 324.7 L 813.6 323.7 L " +
      "812.9 322.7 L 812.2 321.7 L 811.5 320.8 L 810.7 319.8 L 810.0 318.9 L 809.2 317.9 L 808.5 317.0 " +
      "L 807.7 316.0 L 806.9 315.1 L 806.1 314.1 L 805.2 313.1 L 804.3 312.2 L 803.3 311.2 L 802.3 " +
      "310.2 L 801.1 309.2 L 800.0 308.3 L 797.0 317.0 L 798.2 316.9 L 799.3 316.8 L 800.3 316.9 L " +
      "801.4 317.0 L 802.4 317.3 L 803.4 317.7 L 804.4 318.1 L 805.3 318.7 L 806.2 319.3 L 807.0 320.0 " +
      "L 807.8 320.8 L 808.6 321.6 L 809.3 322.5 L 810.0 323.4 L 810.7 324.3 L 811.4 325.2 L 812.1 " +
      "326.2 L 812.8 327.2 L 813.5 328.2 L 814.1 329.2 L 814.8 330.2 L 815.5 331.2 L 816.2 332.2 L " +
      "817.0 333.2 L 817.7 334.2 L 818.4 335.2 L 819.2 336.2 L 820.0 337.2 L 820.8 338.2 L 821.7 339.1 " +
      "L 822.6 340.0 L 823.5 340.9 L 824.4 341.8 L 825.4 342.6 L 826.5 343.4 L 827.5 344.1 L 828.7 " +
      "344.8 L 829.9 345.5 L 831.1 346.1 L 832.4 346.6 L 833.7 347.1 L 835.1 347.6 L 836.6 348.0 L " +
      "838.2 348.3 L 839.8 348.5 L 841.4 348.7 L 843.2 348.8 L 845.0 348.8 Z",
    class: "fill-role-agent/35",
  },
  {
    d:
      "M 872.0 455.2 L 869.5 455.2 L 867.1 455.3 L 864.7 455.4 L 862.5 455.6 L 860.3 455.9 L 858.2 " +
      "456.2 L 856.1 456.6 L 854.2 457.1 L 852.2 457.5 L 850.4 458.1 L 848.6 458.6 L 846.9 459.2 L " +
      "845.2 459.9 L 843.5 460.6 L 841.9 461.3 L 840.4 462.1 L 838.9 462.8 L 837.4 463.7 L 836.0 464.5 " +
      "L 834.6 465.3 L 833.3 466.2 L 831.9 467.1 L 830.6 468.0 L 829.3 468.9 L 828.1 469.9 L 826.8 " +
      "470.8 L 825.6 471.7 L 824.4 472.7 L 823.2 473.6 L 821.9 474.6 L 820.7 475.5 L 819.5 476.4 L " +
      "818.3 477.3 L 817.1 478.2 L 815.9 479.1 L 814.7 480.0 L 813.4 480.8 L 812.2 481.6 L 810.9 482.4 " +
      "L 809.6 483.2 L 808.3 483.9 L 806.8 484.4 L 805.4 484.9 L 803.8 485.2 L 802.3 485.5 L 800.6 " +
      "485.5 L 799.0 485.5 L 797.2 485.3 L 800.1 494.2 L 801.5 492.9 L 803.0 491.7 L 804.4 490.6 L " +
      "805.8 489.5 L 807.2 488.5 L 808.5 487.5 L 809.8 486.6 L 811.1 485.7 L 812.5 484.9 L 813.8 484.0 " +
      "L 815.1 483.1 L 816.3 482.2 L 817.5 481.3 L 818.8 480.4 L 820.0 479.4 L 821.2 478.5 L 822.4 " +
      "477.5 L 823.5 476.6 L 824.7 475.6 L 825.9 474.6 L 827.1 473.7 L 828.3 472.7 L 829.5 471.8 L " +
      "830.7 470.8 L 832.0 469.9 L 833.2 469.0 L 834.5 468.1 L 835.8 467.2 L 837.1 466.3 L 838.5 465.5 " +
      "L 839.9 464.7 L 841.3 463.9 L 842.8 463.1 L 844.3 462.4 L 845.9 461.7 L 847.5 461.1 L 849.2 " +
      "460.4 L 850.9 459.9 L 852.7 459.3 L 854.6 458.8 L 856.5 458.4 L 858.5 458.0 L 860.5 457.7 L " +
      "862.7 457.4 L 864.9 457.2 L 867.2 457.0 L 869.5 456.9 L 872.0 456.8 Z",
    class: "fill-role-agent/55",
  },
  {
    d:
      "M 872.0 541.2 L 869.5 541.1 L 867.2 541.0 L 864.9 540.8 L 862.7 540.6 L 860.5 540.3 L 858.5 " +
      "540.0 L 856.5 539.6 L 854.6 539.2 L 852.7 538.7 L 850.9 538.1 L 849.2 537.6 L 847.5 536.9 L " +
      "845.9 536.3 L 844.3 535.6 L 842.8 534.9 L 841.3 534.1 L 839.9 533.3 L 838.5 532.5 L 837.1 531.7 " +
      "L 835.8 530.8 L 834.5 529.9 L 833.2 529.0 L 832.0 528.1 L 830.7 527.2 L 829.5 526.2 L 828.3 " +
      "525.3 L 827.1 524.3 L 825.9 523.4 L 824.7 522.4 L 823.5 521.4 L 822.4 520.5 L 821.2 519.5 L " +
      "820.0 518.6 L 818.8 517.6 L 817.5 516.7 L 816.3 515.8 L 815.1 514.9 L 813.8 514.0 L 812.5 513.1 " +
      "L 811.1 512.3 L 809.8 511.4 L 808.5 510.5 L 807.2 509.5 L 805.8 508.5 L 804.4 507.4 L 803.0 " +
      "506.3 L 801.5 505.1 L 800.1 503.8 L 797.2 512.7 L 799.0 512.5 L 800.6 512.5 L 802.3 512.5 L " +
      "803.8 512.8 L 805.4 513.1 L 806.8 513.6 L 808.3 514.1 L 809.6 514.8 L 810.9 515.6 L 812.2 516.4 " +
      "L 813.4 517.2 L 814.7 518.0 L 815.9 518.9 L 817.1 519.8 L 818.3 520.7 L 819.5 521.6 L 820.7 " +
      "522.5 L 821.9 523.4 L 823.2 524.4 L 824.4 525.3 L 825.6 526.3 L 826.8 527.2 L 828.1 528.1 L " +
      "829.3 529.1 L 830.6 530.0 L 831.9 530.9 L 833.3 531.8 L 834.6 532.7 L 836.0 533.5 L 837.4 534.3 " +
      "L 838.9 535.2 L 840.4 535.9 L 841.9 536.7 L 843.5 537.4 L 845.2 538.1 L 846.9 538.8 L 848.6 " +
      "539.4 L 850.4 539.9 L 852.2 540.5 L 854.2 540.9 L 856.1 541.4 L 858.2 541.8 L 860.3 542.1 L " +
      "862.5 542.4 L 864.7 542.6 L 867.1 542.7 L 869.5 542.8 L 872.0 542.8 Z",
    class: "fill-role-agent/55",
  },
  {
    d:
      "M 976.0 347.2 L 973.8 347.2 L 971.6 347.1 L 969.5 347.1 L 967.5 347.1 L 965.5 347.1 L 963.6 " +
      "347.1 L 961.7 347.1 L 959.9 347.1 L 958.1 347.1 L 956.3 347.0 L 954.7 347.0 L 953.0 347.0 L " +
      "951.4 347.0 L 949.8 347.0 L 948.3 347.0 L 946.8 347.0 L 945.3 346.9 L 943.9 346.9 L 942.4 346.9 " +
      "L 941.0 346.9 L 939.7 346.9 L 938.3 346.9 L 937.0 346.8 L 935.7 346.8 L 934.4 346.8 L 933.1 " +
      "346.8 L 931.8 346.8 L 930.6 346.7 L 929.3 346.7 L 928.0 346.7 L 926.8 346.7 L 925.5 346.7 L " +
      "924.3 346.7 L 923.0 346.6 L 921.8 346.6 L 920.5 346.6 L 919.2 346.6 L 918.0 346.6 L 916.6 346.5 " +
      "L 915.3 346.4 L 914.0 346.3 L 912.6 346.1 L 911.3 345.8 L 909.9 345.5 L 908.4 345.1 L 907.0 " +
      "344.6 L 905.5 344.0 L 904.0 343.4 L 904.0 352.6 L 905.5 352.0 L 907.0 351.4 L 908.4 350.9 L " +
      "909.9 350.5 L 911.3 350.2 L 912.6 349.9 L 914.0 349.7 L 915.3 349.6 L 916.6 349.5 L 918.0 349.4 " +
      "L 919.2 349.4 L 920.5 349.4 L 921.8 349.4 L 923.0 349.4 L 924.3 349.3 L 925.5 349.3 L 926.8 " +
      "349.3 L 928.0 349.3 L 929.3 349.3 L 930.6 349.3 L 931.8 349.2 L 933.1 349.2 L 934.4 349.2 L " +
      "935.7 349.2 L 937.0 349.2 L 938.3 349.1 L 939.7 349.1 L 941.0 349.1 L 942.4 349.1 L 943.9 349.1 " +
      "L 945.3 349.1 L 946.8 349.0 L 948.3 349.0 L 949.8 349.0 L 951.4 349.0 L 953.0 349.0 L 954.7 " +
      "349.0 L 956.3 349.0 L 958.1 348.9 L 959.9 348.9 L 961.7 348.9 L 963.6 348.9 L 965.5 348.9 L " +
      "967.5 348.9 L 969.5 348.9 L 971.6 348.9 L 973.8 348.8 L 976.0 348.8 Z",
    class: "fill-role-agent/55",
  },
  {
    d: "M 380.3 358.8 A 109.904 109.904 0 0 0 390.9 461.1",
    "stroke-width": "11.835798597335815",
    "stroke-linecap": "round",
    class: "fill-none stroke-role-source",
  },
  {
    d: "M 177.7 329.1 A 32 32 0 0 0 177.7 380.9",
    "stroke-width": "3.3816567420959474",
    "stroke-linecap": "round",
    class: "fill-none stroke-role-source",
  },
  {
    d: "M 165.5 617.3 A 32 32 0 0 0 165.5 632.7",
    "stroke-width": "3.3816567420959474",
    "stroke-linecap": "round",
    class: "fill-none stroke-role-source",
  },
  {
    d: "M 584.2 358.8 A 109.904 109.904 0 0 1 584.2 441.2",
    "stroke-width": "11.835798597335815",
    "stroke-linecap": "round",
    class: "fill-none stroke-role-agent",
  },
  {
    d: "M 795.8 287.2 A 32 32 0 0 1 796.6 317.3",
    "stroke-width": "3.3816567420959474",
    "stroke-linecap": "round",
    class: "fill-none stroke-role-agent",
  },
  {
    d: "M 796.8 485.0 A 32 32 0 0 1 796.8 513.0",
    "stroke-width": "3.3816567420959474",
    "stroke-linecap": "round",
    class: "fill-none stroke-role-agent",
  },
  {
    d: "M 903.0 340.3 A 32 32 0 0 1 903.0 355.7",
    "stroke-width": "3.3816567420959474",
    "stroke-linecap": "round",
    class: "fill-none stroke-role-agent",
  },
  {
    d: "M 899.7 233 A32 32 0 0 1 899.7 265",
    "stroke-width": "3.4",
    "stroke-linecap": "round",
    class: "fill-none stroke-role-agent",
  },
  {
    d:
      "M 741.0 290.7 L 736.5 290.8 L 732.1 291.1 L 727.8 291.5 L 723.6 292.1 L 719.4 292.8 L 715.4 " +
      "293.6 L 711.5 294.6 L 707.7 295.8 L 703.9 297.0 L 700.2 298.4 L 696.6 299.9 L 693.1 301.5 L " +
      "689.6 303.1 L 686.2 304.9 L 682.9 306.8 L 679.7 308.7 L 676.5 310.7 L 673.3 312.8 L 670.2 314.9 " +
      "L 667.2 317.0 L 664.2 319.2 L 661.2 321.5 L 658.3 323.8 L 655.4 326.1 L 652.5 328.4 L 649.7 " +
      "330.7 L 646.9 333.0 L 644.1 335.3 L 641.3 337.6 L 638.5 339.9 L 635.8 342.1 L 633.1 344.3 L " +
      "630.3 346.5 L 627.6 348.7 L 624.9 350.7 L 622.1 352.8 L 619.4 354.7 L 616.6 356.6 L 613.9 358.4 " +
      "L 611.1 360.1 L 608.3 361.8 L 605.5 363.2 L 602.5 364.4 L 599.4 365.2 L 596.3 365.7 L 593.1 " +
      "365.9 L 589.9 365.7 L 586.6 365.2 L 590.7 379.8 L 593.6 377.5 L 596.5 375.3 L 599.3 373.2 L " +
      "602.1 371.2 L 604.9 369.2 L 607.7 367.4 L 610.6 365.7 L 613.5 364.0 L 616.3 362.1 L 619.1 360.2 " +
      "L 621.9 358.2 L 624.7 356.2 L 627.4 354.0 L 630.1 351.9 L 632.9 349.7 L 635.6 347.4 L 638.3 " +
      "345.1 L 641.0 342.8 L 643.7 340.5 L 646.5 338.1 L 649.2 335.8 L 652.0 333.4 L 654.7 331.1 L " +
      "657.5 328.7 L 660.4 326.4 L 663.2 324.1 L 666.1 321.9 L 669.1 319.7 L 672.1 317.5 L 675.1 315.4 " +
      "L 678.1 313.3 L 681.3 311.3 L 684.4 309.4 L 687.7 307.5 L 691.0 305.7 L 694.3 304.1 L 697.7 " +
      "302.5 L 701.2 301.0 L 704.8 299.6 L 708.5 298.4 L 712.2 297.2 L 716.0 296.2 L 720.0 295.3 L " +
      "724.0 294.6 L 728.1 294.0 L 732.3 293.6 L 736.6 293.4 L 741.0 293.3 Z",
    class: "fill-role-agent/35",
  },
  {
    d:
      "M 741.0 495.7 L 736.7 495.7 L 732.5 495.4 L 728.3 495.0 L 724.3 494.5 L 720.4 493.9 L 716.5 " +
      "493.1 L 712.7 492.2 L 709.1 491.2 L 705.4 490.0 L 701.9 488.8 L 698.4 487.5 L 695.0 486.0 L " +
      "691.7 484.5 L 688.4 482.9 L 685.1 481.3 L 682.0 479.5 L 678.8 477.7 L 675.7 475.9 L 672.7 474.0 " +
      "L 669.7 472.0 L 666.8 470.0 L 663.8 468.0 L 661.0 465.9 L 658.1 463.9 L 655.3 461.8 L 652.5 " +
      "459.7 L 649.7 457.5 L 646.9 455.4 L 644.1 453.3 L 641.4 451.2 L 638.7 449.2 L 635.9 447.1 L " +
      "633.2 445.1 L 630.4 443.1 L 627.7 441.2 L 624.9 439.3 L 622.2 437.4 L 619.4 435.7 L 616.6 433.9 " +
      "L 613.7 432.3 L 610.9 430.7 L 608.0 429.2 L 605.3 427.5 L 602.5 425.7 L 599.7 423.8 L 596.9 " +
      "421.8 L 594.0 419.7 L 591.2 417.6 L 587.4 432.3 L 590.7 431.7 L 593.8 431.4 L 596.9 431.5 L " +
      "600.0 431.9 L 603.0 432.5 L 605.9 433.5 L 608.8 434.8 L 611.6 436.2 L 614.3 437.8 L 617.1 439.4 " +
      "L 619.9 441.1 L 622.6 442.8 L 625.3 444.6 L 628.1 446.5 L 630.8 448.4 L 633.6 450.3 L 636.3 " +
      "452.3 L 639.1 454.3 L 641.9 456.4 L 644.7 458.4 L 647.5 460.5 L 650.3 462.5 L 653.2 464.6 L " +
      "656.1 466.7 L 659.0 468.7 L 661.9 470.8 L 664.9 472.8 L 667.9 474.7 L 671.0 476.7 L 674.1 478.6 " +
      "L 677.3 480.4 L 680.5 482.2 L 683.7 483.9 L 687.1 485.6 L 690.4 487.2 L 693.9 488.7 L 697.4 " +
      "490.1 L 700.9 491.4 L 704.6 492.6 L 708.3 493.8 L 712.1 494.8 L 716.0 495.7 L 719.9 496.4 L " +
      "723.9 497.1 L 728.1 497.6 L 732.3 498.0 L 736.6 498.2 L 741.0 498.3 Z",
    class: "fill-role-agent/35",
  },
  {
    d:
      "M 741.0 603.7 L 735.3 603.6 L 729.8 603.1 L 724.6 602.3 L 719.5 601.2 L 714.7 599.8 L 710.1 " +
      "598.1 L 705.6 596.2 L 701.3 594.0 L 697.2 591.6 L 693.3 589.0 L 689.5 586.2 L 685.9 583.1 L " +
      "682.3 579.9 L 679.0 576.5 L 675.7 573.0 L 672.5 569.2 L 669.5 565.4 L 666.5 561.4 L 663.7 557.3 " +
      "L 660.9 553.1 L 658.2 548.8 L 655.6 544.4 L 653.0 540.0 L 650.5 535.5 L 648.0 531.0 L 645.5 " +
      "526.4 L 643.1 521.9 L 640.7 517.3 L 638.3 512.7 L 635.9 508.2 L 633.5 503.7 L 631.0 499.2 L " +
      "628.6 494.8 L 626.1 490.4 L 623.6 486.2 L 621.0 482.0 L 618.4 478.0 L 615.7 474.0 L 612.9 470.2 " +
      "L 610.1 466.6 L 607.1 463.1 L 604.1 459.7 L 600.9 456.6 L 597.8 453.4 L 594.7 450.2 L 591.6 " +
      "446.7 L 588.5 443.2 L 585.3 439.6 L 578.4 453.2 L 582.8 453.4 L 586.9 454.1 L 590.7 455.5 L " +
      "594.3 457.5 L 597.7 460.0 L 600.7 463.0 L 603.7 466.1 L 606.6 469.4 L 609.4 472.9 L 612.2 476.6 " +
      "L 614.9 480.4 L 617.5 484.3 L 620.1 488.4 L 622.6 492.5 L 625.1 496.8 L 627.6 501.1 L 630.1 " +
      "505.5 L 632.5 510.0 L 635.0 514.5 L 637.4 519.0 L 639.9 523.6 L 642.4 528.1 L 644.9 532.7 L " +
      "647.5 537.2 L 650.1 541.7 L 652.7 546.1 L 655.5 550.5 L 658.2 554.8 L 661.1 559.1 L 664.1 563.2 " +
      "L 667.1 567.2 L 670.2 571.1 L 673.5 574.9 L 676.9 578.5 L 680.4 582.0 L 684.0 585.3 L 687.8 " +
      "588.4 L 691.7 591.3 L 695.8 594.0 L 700.1 596.4 L 704.5 598.6 L 709.1 600.6 L 713.9 602.3 L " +
      "718.9 603.7 L 724.1 604.8 L 729.5 605.6 L 735.1 606.1 L 741.0 606.3 Z",
    class: "fill-role-agent/35",
  },
  {
    d:
      "M 845.0 237.2 L 843.0 237.2 L 841.1 237.3 L 839.3 237.5 L 837.6 237.8 L 836.0 238.2 L 834.4 " +
      "238.7 L 832.9 239.2 L 831.5 239.8 L 830.2 240.5 L 828.9 241.2 L 827.7 242.0 L 826.5 242.9 L " +
      "825.4 243.8 L 824.3 244.7 L 823.4 245.7 L 822.4 246.7 L 821.5 247.8 L 820.6 248.9 L 819.8 250.0 " +
      "L 819.0 251.2 L 818.3 252.4 L 817.5 253.6 L 816.8 254.8 L 816.1 256.0 L 815.5 257.2 L 814.8 " +
      "258.4 L 814.2 259.7 L 813.5 260.9 L 812.9 262.1 L 812.2 263.3 L 811.6 264.5 L 810.9 265.7 L " +
      "810.3 266.8 L 809.6 267.9 L 808.9 269.0 L 808.2 270.1 L 807.5 271.1 L 806.7 272.1 L 805.9 273.0 " +
      "L 805.0 273.8 L 804.1 274.6 L 803.1 275.2 L 802.0 275.7 L 801.0 276.1 L 799.8 276.4 L 798.7 " +
      "276.5 L 797.5 276.5 L 796.2 276.5 L 799.7 285.0 L 800.9 283.9 L 802.0 282.8 L 803.1 281.7 L " +
      "804.1 280.5 L 805.0 279.4 L 805.9 278.3 L 806.7 277.2 L 807.5 276.1 L 808.3 275.0 L 809.0 273.9 " +
      "L 809.8 272.8 L 810.5 271.6 L 811.3 270.5 L 811.9 269.3 L 812.6 268.1 L 813.2 266.9 L 813.9 " +
      "265.7 L 814.5 264.5 L 815.1 263.2 L 815.7 262.0 L 816.3 260.8 L 816.9 259.5 L 817.5 258.3 L " +
      "818.2 257.1 L 818.8 255.9 L 819.5 254.7 L 820.1 253.5 L 820.8 252.4 L 821.6 251.2 L 822.3 250.1 " +
      "L 823.1 249.1 L 823.9 248.1 L 824.8 247.1 L 825.7 246.1 L 826.7 245.2 L 827.7 244.4 L 828.7 " +
      "243.6 L 829.9 242.8 L 831.0 242.1 L 832.3 241.5 L 833.6 240.9 L 835.0 240.4 L 836.4 239.9 L " +
      "838.0 239.5 L 839.6 239.2 L 841.3 239.0 L 843.1 238.9 L 845.0 238.8 Z",
    class: "fill-role-agent/35",
  },
  {
    d:
      "M 845.0 388.2 L 842.2 388.1 L 839.6 387.8 L 837.1 387.4 L 834.9 386.9 L 832.8 386.3 L 830.8 " +
      "385.5 L 829.0 384.5 L 827.3 383.5 L 825.8 382.4 L 824.4 381.1 L 823.1 379.8 L 821.9 378.3 L " +
      "820.8 376.8 L 819.8 375.2 L 818.9 373.5 L 818.0 371.7 L 817.3 369.8 L 816.6 367.9 L 816.0 365.9 " +
      "L 815.4 363.9 L 814.9 361.8 L 814.5 359.6 L 814.0 357.5 L 813.6 355.3 L 813.3 353.0 L 812.9 " +
      "350.8 L 812.6 348.5 L 812.3 346.2 L 811.9 344.0 L 811.6 341.7 L 811.2 339.4 L 810.9 337.2 L " +
      "810.5 334.9 L 810.0 332.7 L 809.5 330.5 L 809.0 328.4 L 808.4 326.3 L 807.8 324.3 L 807.1 322.3 " +
      "L 806.3 320.3 L 805.4 318.4 L 804.4 316.6 L 803.5 314.8 L 802.5 312.9 L 801.4 311.0 L 800.3 " +
      "309.1 L 799.0 307.2 L 797.7 305.3 L 792.4 312.9 L 794.4 313.3 L 796.1 313.8 L 797.7 314.6 L " +
      "799.2 315.6 L 800.5 316.8 L 801.7 318.2 L 802.7 319.8 L 803.5 321.6 L 804.3 323.3 L 805.1 325.2 " +
      "L 805.7 327.2 L 806.3 329.1 L 806.9 331.2 L 807.4 333.3 L 807.9 335.5 L 808.3 337.6 L 808.7 " +
      "339.8 L 809.1 342.1 L 809.5 344.3 L 809.9 346.6 L 810.2 348.9 L 810.6 351.1 L 811.0 353.4 L " +
      "811.4 355.7 L 811.8 357.9 L 812.3 360.1 L 812.8 362.3 L 813.4 364.4 L 814.0 366.5 L 814.7 368.6 " +
      "L 815.4 370.5 L 816.2 372.5 L 817.1 374.4 L 818.1 376.1 L 819.2 377.9 L 820.4 379.5 L 821.7 " +
      "381.0 L 823.1 382.5 L 824.6 383.8 L 826.3 385.0 L 828.1 386.1 L 830.1 387.1 L 832.2 387.9 L " +
      "834.4 388.6 L 836.8 389.1 L 839.4 389.5 L 842.1 389.8 L 845.0 389.8 Z",
    class: "fill-role-agent/35",
  },
  {
    d:
      "M 872.0 496.2 L 869.8 496.2 L 867.6 496.1 L 865.5 496.1 L 863.5 496.1 L 861.5 496.1 L 859.6 " +
      "496.1 L 857.7 496.1 L 855.9 496.1 L 854.1 496.1 L 852.3 496.0 L 850.7 496.0 L 849.0 496.0 L " +
      "847.4 496.0 L 845.8 496.0 L 844.3 496.0 L 842.8 496.0 L 841.3 495.9 L 839.9 495.9 L 838.4 495.9 " +
      "L 837.0 495.9 L 835.7 495.9 L 834.3 495.9 L 833.0 495.8 L 831.7 495.8 L 830.4 495.8 L 829.1 " +
      "495.8 L 827.8 495.8 L 826.6 495.7 L 825.3 495.7 L 824.0 495.7 L 822.8 495.7 L 821.5 495.7 L " +
      "820.3 495.7 L 819.0 495.6 L 817.8 495.6 L 816.5 495.6 L 815.2 495.6 L 814.0 495.6 L 812.6 495.5 " +
      "L 811.3 495.4 L 810.0 495.3 L 808.6 495.1 L 807.3 494.8 L 805.9 494.5 L 804.4 494.1 L 803.0 " +
      "493.6 L 801.5 493.0 L 800.0 492.4 L 800.0 501.6 L 801.5 501.0 L 803.0 500.4 L 804.4 499.9 L " +
      "805.9 499.5 L 807.3 499.2 L 808.6 498.9 L 810.0 498.7 L 811.3 498.6 L 812.6 498.5 L 814.0 498.4 " +
      "L 815.2 498.4 L 816.5 498.4 L 817.8 498.4 L 819.0 498.4 L 820.3 498.3 L 821.5 498.3 L 822.8 " +
      "498.3 L 824.0 498.3 L 825.3 498.3 L 826.6 498.3 L 827.8 498.2 L 829.1 498.2 L 830.4 498.2 L " +
      "831.7 498.2 L 833.0 498.2 L 834.3 498.1 L 835.7 498.1 L 837.0 498.1 L 838.4 498.1 L 839.9 498.1 " +
      "L 841.3 498.1 L 842.8 498.0 L 844.3 498.0 L 845.8 498.0 L 847.4 498.0 L 849.0 498.0 L 850.7 " +
      "498.0 L 852.3 498.0 L 854.1 497.9 L 855.9 497.9 L 857.7 497.9 L 859.6 497.9 L 861.5 497.9 L " +
      "863.5 497.9 L 865.5 497.9 L 867.6 497.9 L 869.8 497.8 L 872.0 497.8 Z",
    class: "fill-role-agent/55",
  },
  {
    d:
      "M 872.0 604.2 L 869.8 604.2 L 867.6 604.1 L 865.5 604.1 L 863.5 604.1 L 861.5 604.1 L 859.6 " +
      "604.1 L 857.7 604.1 L 855.9 604.1 L 854.1 604.1 L 852.3 604.0 L 850.7 604.0 L 849.0 604.0 L " +
      "847.4 604.0 L 845.8 604.0 L 844.3 604.0 L 842.8 604.0 L 841.3 603.9 L 839.9 603.9 L 838.4 603.9 " +
      "L 837.0 603.9 L 835.7 603.9 L 834.3 603.9 L 833.0 603.8 L 831.7 603.8 L 830.4 603.8 L 829.1 " +
      "603.8 L 827.8 603.8 L 826.6 603.7 L 825.3 603.7 L 824.0 603.7 L 822.8 603.7 L 821.5 603.7 L " +
      "820.3 603.7 L 819.0 603.6 L 817.8 603.6 L 816.5 603.6 L 815.2 603.6 L 814.0 603.6 L 812.6 603.5 " +
      "L 811.3 603.4 L 810.0 603.3 L 808.6 603.1 L 807.3 602.8 L 805.9 602.5 L 804.4 602.1 L 803.0 " +
      "601.6 L 801.5 601.0 L 800.0 600.4 L 800.0 609.6 L 801.5 609.0 L 803.0 608.4 L 804.4 607.9 L " +
      "805.9 607.5 L 807.3 607.2 L 808.6 606.9 L 810.0 606.7 L 811.3 606.6 L 812.6 606.5 L 814.0 606.4 " +
      "L 815.2 606.4 L 816.5 606.4 L 817.8 606.4 L 819.0 606.4 L 820.3 606.3 L 821.5 606.3 L 822.8 " +
      "606.3 L 824.0 606.3 L 825.3 606.3 L 826.6 606.3 L 827.8 606.2 L 829.1 606.2 L 830.4 606.2 L " +
      "831.7 606.2 L 833.0 606.2 L 834.3 606.1 L 835.7 606.1 L 837.0 606.1 L 838.4 606.1 L 839.9 606.1 " +
      "L 841.3 606.1 L 842.8 606.0 L 844.3 606.0 L 845.8 606.0 L 847.4 606.0 L 849.0 606.0 L 850.7 " +
      "606.0 L 852.3 606.0 L 854.1 605.9 L 855.9 605.9 L 857.7 605.9 L 859.6 605.9 L 861.5 605.9 L " +
      "863.5 605.9 L 865.5 605.9 L 867.6 605.9 L 869.8 605.8 L 872.0 605.8 Z",
    class: "fill-role-agent/55",
  },
  {
    d:
      "M 976.0 194.2 L 973.5 194.2 L 971.1 194.3 L 968.7 194.4 L 966.5 194.6 L 964.3 194.9 L 962.2 " +
      "195.2 L 960.1 195.6 L 958.2 196.1 L 956.2 196.5 L 954.4 197.1 L 952.6 197.6 L 950.9 198.2 L " +
      "949.2 198.9 L 947.5 199.6 L 945.9 200.3 L 944.4 201.1 L 942.9 201.8 L 941.4 202.7 L 940.0 203.5 " +
      "L 938.6 204.3 L 937.3 205.2 L 935.9 206.1 L 934.6 207.0 L 933.3 207.9 L 932.1 208.9 L 930.8 " +
      "209.8 L 929.6 210.7 L 928.4 211.7 L 927.2 212.6 L 925.9 213.6 L 924.7 214.5 L 923.5 215.4 L " +
      "922.3 216.3 L 921.1 217.2 L 919.9 218.1 L 918.7 219.0 L 917.4 219.8 L 916.2 220.6 L 914.9 221.4 " +
      "L 913.6 222.2 L 912.3 222.9 L 910.8 223.4 L 909.4 223.9 L 907.8 224.2 L 906.3 224.5 L 904.6 " +
      "224.5 L 903.0 224.5 L 901.2 224.3 L 904.1 233.2 L 905.5 231.9 L 907.0 230.7 L 908.4 229.6 L " +
      "909.8 228.5 L 911.2 227.5 L 912.5 226.5 L 913.8 225.6 L 915.1 224.7 L 916.5 223.9 L 917.8 223.0 " +
      "L 919.1 222.1 L 920.3 221.2 L 921.5 220.3 L 922.8 219.4 L 924.0 218.4 L 925.2 217.5 L 926.4 " +
      "216.5 L 927.5 215.6 L 928.7 214.6 L 929.9 213.6 L 931.1 212.7 L 932.3 211.7 L 933.5 210.8 L " +
      "934.7 209.8 L 936.0 208.9 L 937.2 208.0 L 938.5 207.1 L 939.8 206.2 L 941.1 205.3 L 942.5 204.5 " +
      "L 943.9 203.7 L 945.3 202.9 L 946.8 202.1 L 948.3 201.4 L 949.9 200.7 L 951.5 200.1 L 953.2 " +
      "199.4 L 954.9 198.9 L 956.7 198.3 L 958.6 197.8 L 960.5 197.4 L 962.5 197.0 L 964.5 196.7 L " +
      "966.7 196.4 L 968.9 196.2 L 971.2 196.0 L 973.5 195.9 L 976.0 195.8 Z",
    class: "fill-role-agent/55",
  },
  {
    d:
      "M 976.0 280.2 L 973.5 280.1 L 971.2 280.0 L 968.9 279.8 L 966.7 279.6 L 964.5 279.3 L 962.5 " +
      "279.0 L 960.5 278.6 L 958.6 278.2 L 956.7 277.7 L 954.9 277.1 L 953.2 276.6 L 951.5 275.9 L " +
      "949.9 275.3 L 948.3 274.6 L 946.8 273.9 L 945.3 273.1 L 943.9 272.3 L 942.5 271.5 L 941.1 270.7 " +
      "L 939.8 269.8 L 938.5 268.9 L 937.2 268.0 L 936.0 267.1 L 934.7 266.2 L 933.5 265.2 L 932.3 " +
      "264.3 L 931.1 263.3 L 929.9 262.4 L 928.7 261.4 L 927.5 260.4 L 926.4 259.5 L 925.2 258.5 L " +
      "924.0 257.6 L 922.8 256.6 L 921.5 255.7 L 920.3 254.8 L 919.1 253.9 L 917.8 253.0 L 916.5 252.1 " +
      "L 915.1 251.3 L 913.8 250.4 L 912.5 249.5 L 911.2 248.5 L 909.8 247.5 L 908.4 246.4 L 907.0 " +
      "245.3 L 905.5 244.1 L 904.1 242.8 L 901.2 251.7 L 903.0 251.5 L 904.6 251.5 L 906.3 251.5 L " +
      "907.8 251.8 L 909.4 252.1 L 910.8 252.6 L 912.3 253.1 L 913.6 253.8 L 914.9 254.6 L 916.2 255.4 " +
      "L 917.4 256.2 L 918.7 257.0 L 919.9 257.9 L 921.1 258.8 L 922.3 259.7 L 923.5 260.6 L 924.7 " +
      "261.5 L 925.9 262.4 L 927.2 263.4 L 928.4 264.3 L 929.6 265.3 L 930.8 266.2 L 932.1 267.1 L " +
      "933.3 268.1 L 934.6 269.0 L 935.9 269.9 L 937.3 270.8 L 938.6 271.7 L 940.0 272.5 L 941.4 273.3 " +
      "L 942.9 274.2 L 944.4 274.9 L 945.9 275.7 L 947.5 276.4 L 949.2 277.1 L 950.9 277.8 L 952.6 " +
      "278.4 L 954.4 278.9 L 956.2 279.5 L 958.2 279.9 L 960.1 280.4 L 962.2 280.8 L 964.3 281.1 L " +
      "966.5 281.4 L 968.7 281.6 L 971.1 281.7 L 973.5 281.8 L 976.0 281.8 Z",
    class: "fill-role-agent/55",
  },
  {
    d:
      "M 976.0 388.2 L 973.8 388.2 L 971.6 388.1 L 969.5 388.1 L 967.5 388.1 L 965.5 388.1 L 963.6 " +
      "388.1 L 961.7 388.1 L 959.9 388.1 L 958.1 388.1 L 956.3 388.0 L 954.7 388.0 L 953.0 388.0 L " +
      "951.4 388.0 L 949.8 388.0 L 948.3 388.0 L 946.8 388.0 L 945.3 387.9 L 943.9 387.9 L 942.4 387.9 " +
      "L 941.0 387.9 L 939.7 387.9 L 938.3 387.9 L 937.0 387.8 L 935.7 387.8 L 934.4 387.8 L 933.1 " +
      "387.8 L 931.8 387.8 L 930.6 387.7 L 929.3 387.7 L 928.0 387.7 L 926.8 387.7 L 925.5 387.7 L " +
      "924.3 387.7 L 923.0 387.6 L 921.8 387.6 L 920.5 387.6 L 919.2 387.6 L 918.0 387.6 L 916.6 387.5 " +
      "L 915.3 387.4 L 914.0 387.3 L 912.6 387.1 L 911.3 386.8 L 909.9 386.5 L 908.4 386.1 L 907.0 " +
      "385.6 L 905.5 385.0 L 904.0 384.4 L 904.0 393.6 L 905.5 393.0 L 907.0 392.4 L 908.4 391.9 L " +
      "909.9 391.5 L 911.3 391.2 L 912.6 390.9 L 914.0 390.7 L 915.3 390.6 L 916.6 390.5 L 918.0 390.4 " +
      "L 919.2 390.4 L 920.5 390.4 L 921.8 390.4 L 923.0 390.4 L 924.3 390.3 L 925.5 390.3 L 926.8 " +
      "390.3 L 928.0 390.3 L 929.3 390.3 L 930.6 390.3 L 931.8 390.2 L 933.1 390.2 L 934.4 390.2 L " +
      "935.7 390.2 L 937.0 390.2 L 938.3 390.1 L 939.7 390.1 L 941.0 390.1 L 942.4 390.1 L 943.9 390.1 " +
      "L 945.3 390.1 L 946.8 390.0 L 948.3 390.0 L 949.8 390.0 L 951.4 390.0 L 953.0 390.0 L 954.7 " +
      "390.0 L 956.3 390.0 L 958.1 389.9 L 959.9 389.9 L 961.7 389.9 L 963.6 389.9 L 965.5 389.9 L " +
      "967.5 389.9 L 969.5 389.9 L 971.6 389.9 L 973.8 389.8 L 976.0 389.8 Z",
    class: "fill-role-agent/55",
  },
  {
    d: "M 584.2 358.8 A 109.904 109.904 0 0 1 575.5 458.2",
    "stroke-width": "11.835798597335815",
    "stroke-linecap": "round",
    class: "fill-none stroke-role-agent",
  },
  {
    d: "M 795.8 276.2 A 32 32 0 0 1 792.1 313.1",
    "stroke-width": "3.3816567420959474",
    "stroke-linecap": "round",
    class: "fill-none stroke-role-agent",
  },
  {
    d: "M 799.0 489.3 A 32 32 0 0 1 799.0 504.7",
    "stroke-width": "3.3816567420959474",
    "stroke-linecap": "round",
    class: "fill-none stroke-role-agent",
  },
  {
    d: "M 799.0 597.3 A 32 32 0 0 1 799.0 612.7",
    "stroke-width": "3.3816567420959474",
    "stroke-linecap": "round",
    class: "fill-none stroke-role-agent",
  },
  {
    d: "M 900.8 224.0 A 32 32 0 0 1 900.8 252.0",
    "stroke-width": "3.3816567420959474",
    "stroke-linecap": "round",
    class: "fill-none stroke-role-agent",
  },
  {
    d: "M 903.0 381.3 A 32 32 0 0 1 903.0 396.7",
    "stroke-width": "3.3816567420959474",
    "stroke-linecap": "round",
    class: "fill-none stroke-role-agent",
  },
  {
    d: "M 584.4 359.3 A 109.9 109.9 0 0 1 569.2 468.1",
    "stroke-width": "11.8",
    "stroke-linecap": "round",
    class: "fill-none stroke-role-agent",
  },
  {
    d:
      "M 598.5 403.9 L 602.5 403.7 L 606.5 403.6 L 610.5 403.4 L 614.4 403.3 L 618.4 403.2 L 622.4 " +
      "403.1 L 626.4 402.9 L 630.4 402.8 L 634.4 402.7 L 638.4 402.6 L 642.5 402.5 L 646.6 402.4 L " +
      "650.7 402.3 L 654.9 402.2 L 659.1 402.1 L 663.3 402.0 L 667.6 401.9 L 672.0 401.8 L 676.4 401.8 " +
      "L 680.9 401.7 L 685.4 401.6 L 690.0 401.6 L 694.7 401.5 L 699.5 401.5 L 704.4 401.4 L 709.3 " +
      "401.4 L 714.3 401.4 L 719.4 401.3 L 724.7 401.3 L 730.0 401.3 L 735.4 401.3 L 741.0 401.3 L " +
      "741.0 398.7 L 735.4 398.7 L 730.0 398.7 L 724.7 398.7 L 719.4 398.7 L 714.3 398.7 L 709.3 398.7 " +
      "L 704.3 398.6 L 699.5 398.6 L 694.7 398.6 L 690.0 398.6 L 685.4 398.5 L 680.9 398.5 L 676.4 " +
      "398.5 L 672.0 398.4 L 667.6 398.4 L 663.3 398.3 L 659.1 398.3 L 654.9 398.2 L 650.7 398.1 L " +
      "646.6 398.1 L 642.5 398.0 L 638.4 397.9 L 634.4 397.8 L 630.4 397.7 L 626.4 397.7 L 622.4 397.6 " +
      "L 618.4 397.5 L 614.4 397.3 L 610.5 397.2 L 606.5 397.1 L 602.5 397.0 L 598.5 396.9 Z",
    class: "fill-role-agent/35",
  },
  {
    d:
      "M 580.2 463.1 L 586.6 467.2 L 592.8 472.1 L 598.8 477.6 L 604.7 483.7 L 610.4 490.5 L 616.0 " +
      "497.7 L 621.4 505.4 L 626.7 513.6 L 631.9 522.0 L 637.0 530.8 L 641.9 539.7 L 646.9 548.9 L " +
      "651.7 558.1 L 656.5 567.4 L 661.3 576.7 L 666.1 586.0 L 670.8 595.1 L 675.6 604.0 L 680.4 612.7 " +
      "L 685.3 621.2 L 690.2 629.2 L 695.2 636.9 L 700.3 644.2 L 705.6 650.9 L 711.0 657.0 L 716.5 " +
      "662.6 L 722.2 667.4 L 728.1 671.5 L 734.2 674.8 L 740.6 677.3 L 747.2 678.8 L 754.0 679.3 L " +
      "754.0 676.7 L 747.6 676.2 L 741.3 674.8 L 735.3 672.4 L 729.5 669.3 L 723.9 665.3 L 718.4 660.6 " +
      "L 713.0 655.1 L 707.8 649.1 L 702.7 642.4 L 697.7 635.2 L 692.9 627.6 L 688.1 619.5 L 683.3 " +
      "611.1 L 678.6 602.4 L 674.0 593.4 L 669.3 584.3 L 664.7 575.0 L 660.1 565.6 L 655.4 556.2 L " +
      "650.7 546.9 L 645.9 537.6 L 641.0 528.5 L 636.1 519.6 L 631.0 510.9 L 625.8 502.5 L 620.5 494.5 " +
      "L 614.9 486.9 L 609.2 479.8 L 603.2 473.2 L 597.0 467.2 L 590.6 461.8 L 583.9 457.2 Z",
    class: "fill-role-agent/35",
  },
  {
    d: "M 787.5 374.6 A 32 32 0 0 1 787.5 425.4",
    "stroke-width": "3.4",
    "stroke-linecap": "round",
    class: "fill-none stroke-role-agent",
  },
  {
    d:
      "M 794.0 378.0 L 797.5 374.3 L 800.7 370.2 L 803.6 365.7 L 806.2 360.9 L 808.6 355.9 L 810.7 " +
      "350.6 L 812.7 345.1 L 814.5 339.5 L 816.1 333.7 L 817.6 327.8 L 819.0 321.7 L 820.2 315.7 L " +
      "821.3 309.6 L 822.4 303.5 L 823.4 297.5 L 824.4 291.6 L 825.3 285.7 L 826.2 280.0 L 827.1 274.5 " +
      "L 828.0 269.2 L 828.9 264.1 L 829.9 259.3 L 831.0 254.8 L 832.1 250.7 L 833.3 246.9 L 834.6 " +
      "243.6 L 836.0 240.7 L 837.6 238.3 L 839.2 236.4 L 841.0 235.1 L 842.9 234.3 L 845.0 234.0 L " +
      "845.0 232.0 L 842.4 232.3 L 840.0 233.4 L 837.9 235.0 L 836.0 237.1 L 834.3 239.7 L 832.7 242.8 " +
      "L 831.3 246.2 L 830.0 250.1 L 828.9 254.3 L 827.8 258.8 L 826.7 263.7 L 825.7 268.8 L 824.8 " +
      "274.1 L 823.8 279.6 L 822.9 285.3 L 821.9 291.2 L 820.9 297.1 L 819.8 303.1 L 818.7 309.1 L " +
      "817.5 315.1 L 816.2 321.1 L 814.8 327.1 L 813.2 332.9 L 811.5 338.6 L 809.7 344.1 L 807.7 349.4 " +
      "L 805.5 354.5 L 803.1 359.3 L 800.4 363.8 L 797.6 368.0 L 794.6 371.7 L 791.2 375.1 Z",
    class: "fill-role-agent/35",
  },
  {
    d:
      "M 801.8 395.8 L 803.4 395.4 L 804.9 394.9 L 806.3 394.3 L 807.7 393.7 L 809.0 393.0 L 810.3 " +
      "392.3 L 811.6 391.6 L 812.8 390.8 L 813.9 389.9 L 815.1 389.1 L 816.2 388.2 L 817.3 387.3 L " +
      "818.4 386.4 L 819.6 385.6 L 820.7 384.7 L 821.8 383.8 L 822.9 382.9 L 824.1 382.1 L 825.3 381.2 " +
      "L 826.5 380.4 L 827.7 379.7 L 829.0 379.0 L 830.3 378.3 L 831.7 377.7 L 833.1 377.1 L 834.6 " +
      "376.6 L 836.1 376.1 L 837.7 375.7 L 839.4 375.4 L 841.2 375.2 L 843.1 375.0 L 845.0 375.0 L " +
      "845.0 373.0 L 843.0 373.0 L 841.0 373.2 L 839.1 373.4 L 837.3 373.7 L 835.6 374.1 L 834.0 374.6 " +
      "L 832.4 375.1 L 830.8 375.7 L 829.4 376.3 L 828.0 377.0 L 826.6 377.7 L 825.3 378.5 L 824.0 " +
      "379.3 L 822.7 380.1 L 821.5 380.9 L 820.3 381.8 L 819.1 382.6 L 818.0 383.5 L 816.8 384.3 L " +
      "815.7 385.1 L 814.5 385.9 L 813.4 386.7 L 812.2 387.4 L 811.1 388.1 L 809.9 388.8 L 808.7 389.4 " +
      "L 807.5 390.0 L 806.3 390.5 L 805.0 390.9 L 803.8 391.3 L 802.4 391.6 L 801.0 391.8 Z",
    class: "fill-role-agent/35",
  },
  {
    d:
      "M 797.6 416.7 L 799.6 417.7 L 801.4 418.9 L 803.1 420.2 L 804.8 421.7 L 806.4 423.4 L 807.9 " +
      "425.3 L 809.3 427.2 L 810.7 429.3 L 812.0 431.5 L 813.3 433.7 L 814.5 436.0 L 815.8 438.4 L " +
      "816.9 440.8 L 818.1 443.2 L 819.2 445.7 L 820.4 448.1 L 821.5 450.5 L 822.7 452.8 L 823.8 455.1 " +
      "L 825.0 457.4 L 826.3 459.5 L 827.5 461.6 L 828.9 463.5 L 830.3 465.3 L 831.8 467.0 L 833.3 " +
      "468.4 L 835.0 469.8 L 836.8 470.9 L 838.6 471.8 L 840.6 472.5 L 842.8 472.9 L 845.0 473.0 L " +
      "845.0 471.0 L 843.0 470.9 L 841.2 470.5 L 839.4 469.9 L 837.8 469.1 L 836.2 468.1 L 834.7 466.9 " +
      "L 833.3 465.5 L 831.9 464.0 L 830.6 462.2 L 829.4 460.4 L 828.2 458.4 L 827.0 456.3 L 825.9 " +
      "454.1 L 824.8 451.8 L 823.7 449.5 L 822.6 447.1 L 821.6 444.6 L 820.5 442.1 L 819.4 439.7 L " +
      "818.3 437.2 L 817.1 434.7 L 815.9 432.3 L 814.7 430.0 L 813.4 427.6 L 812.0 425.4 L 810.5 423.3 " +
      "L 809.0 421.2 L 807.3 419.3 L 805.6 417.5 L 803.7 415.9 L 801.6 414.4 L 799.5 413.1 Z",
    class: "fill-role-agent/35",
  },
  {
    d:
      "M 791.3 424.8 L 794.7 428.3 L 797.9 432.2 L 800.9 436.4 L 803.7 440.9 L 806.3 445.7 L 808.8 " +
      "450.8 L 811.0 456.2 L 813.2 461.7 L 815.1 467.3 L 817.0 473.1 L 818.8 479.0 L 820.4 485.0 L " +
      "822.0 491.0 L 823.5 496.9 L 825.0 502.9 L 826.4 508.7 L 827.8 514.5 L 829.2 520.1 L 830.6 525.6 " +
      "L 832.1 530.9 L 833.6 535.9 L 835.1 540.7 L 836.8 545.1 L 838.5 549.3 L 840.3 553.1 L 842.3 " +
      "556.5 L 844.4 559.5 L 846.7 562.1 L 849.2 564.2 L 851.9 565.7 L 854.8 566.7 L 858.0 567.0 L " +
      "858.0 565.0 L 855.3 564.7 L 852.7 563.9 L 850.3 562.5 L 848.1 560.7 L 846.0 558.3 L 844.0 555.4 " +
      "L 842.2 552.1 L 840.4 548.4 L 838.8 544.4 L 837.2 540.0 L 835.7 535.2 L 834.3 530.2 L 832.9 " +
      "525.0 L 831.5 519.6 L 830.2 513.9 L 828.8 508.2 L 827.5 502.3 L 826.1 496.3 L 824.6 490.3 L " +
      "823.1 484.3 L 821.5 478.3 L 819.8 472.3 L 818.0 466.4 L 816.1 460.6 L 814.0 455.0 L 811.8 449.5 " +
      "L 809.4 444.2 L 806.8 439.2 L 804.0 434.4 L 800.9 429.9 L 797.6 425.7 L 794.1 422.0 Z",
    class: "fill-role-agent/35",
  },
  {
    d: "M 900.8 219.0 A 32 32 0 0 1 900.8 247.0",
    "stroke-width": "3.4",
    "stroke-linecap": "round",
    class: "fill-none stroke-role-agent",
  },
  {
    d:
      "M 905.0 224.7 L 907.4 223.8 L 909.7 222.9 L 912.0 221.9 L 914.2 220.7 L 916.2 219.6 L 918.3 " +
      "218.3 L 920.3 217.1 L 922.2 215.7 L 924.1 214.4 L 926.0 213.0 L 927.8 211.6 L 929.7 210.1 L " +
      "931.5 208.7 L 933.3 207.3 L 935.2 205.9 L 937.1 204.5 L 939.0 203.1 L 940.9 201.8 L 942.9 200.5 " +
      "L 944.9 199.2 L 947.0 198.0 L 949.1 196.9 L 951.4 195.9 L 953.7 194.9 L 956.1 194.0 L 958.6 " +
      "193.2 L 961.2 192.5 L 963.9 191.9 L 966.7 191.4 L 969.7 191.1 L 972.8 190.9 L 976.0 190.8 L " +
      "976.0 189.2 L 972.7 189.3 L 969.5 189.5 L 966.5 189.8 L 963.6 190.3 L 960.8 190.9 L 958.1 191.6 " +
      "L 955.5 192.4 L 953.1 193.3 L 950.7 194.3 L 948.4 195.3 L 946.1 196.5 L 944.0 197.7 L 941.9 " +
      "198.9 L 939.9 200.2 L 937.9 201.5 L 935.9 202.8 L 934.0 204.2 L 932.1 205.6 L 930.2 207.0 L " +
      "928.3 208.4 L 926.5 209.7 L 924.6 211.1 L 922.7 212.4 L 920.8 213.7 L 918.9 214.9 L 916.9 216.1 " +
      "L 914.9 217.2 L 912.9 218.2 L 910.8 219.2 L 908.6 220.1 L 906.4 220.9 L 904.1 221.6 Z",
    class: "fill-role-agent/55",
  },
  {
    d:
      "M 904.1 244.4 L 906.4 245.1 L 908.6 245.9 L 910.8 246.8 L 912.9 247.8 L 914.9 248.8 L 916.9 " +
      "249.9 L 918.9 251.1 L 920.8 252.3 L 922.7 253.6 L 924.6 254.9 L 926.5 256.3 L 928.3 257.6 L " +
      "930.2 259.0 L 932.1 260.4 L 934.0 261.8 L 935.9 263.2 L 937.9 264.5 L 939.9 265.8 L 941.9 267.1 " +
      "L 944.0 268.3 L 946.1 269.5 L 948.4 270.7 L 950.7 271.7 L 953.1 272.7 L 955.5 273.6 L 958.1 " +
      "274.4 L 960.8 275.1 L 963.6 275.7 L 966.5 276.2 L 969.5 276.5 L 972.7 276.7 L 976.0 276.8 L " +
      "976.0 275.2 L 972.8 275.1 L 969.7 274.9 L 966.7 274.6 L 963.9 274.1 L 961.2 273.5 L 958.6 272.8 " +
      "L 956.1 272.0 L 953.7 271.1 L 951.4 270.1 L 949.1 269.1 L 947.0 268.0 L 944.9 266.8 L 942.9 " +
      "265.5 L 940.9 264.2 L 939.0 262.9 L 937.1 261.5 L 935.2 260.1 L 933.3 258.7 L 931.5 257.3 L " +
      "929.7 255.9 L 927.8 254.4 L 926.0 253.0 L 924.1 251.6 L 922.2 250.3 L 920.3 248.9 L 918.3 247.7 " +
      "L 916.2 246.4 L 914.2 245.3 L 912.0 244.1 L 909.7 243.1 L 907.4 242.2 L 905.0 241.3 Z",
    class: "fill-role-agent/55",
  },
  {
    d: "M 903.0 366.3 A 32 32 0 0 1 903.0 381.7",
    "stroke-width": "3.4",
    "stroke-linecap": "round",
    class: "fill-none stroke-role-agent",
  },
  {
    d:
      "M 906.0 375.6 L 908.2 375.6 L 910.3 375.5 L 912.4 375.5 L 914.4 375.4 L 916.4 375.4 L 918.3 " +
      "375.3 L 920.2 375.3 L 922.1 375.3 L 923.9 375.2 L 925.7 375.2 L 927.6 375.1 L 929.4 375.1 L " +
      "931.2 375.1 L 933.1 375.1 L 934.9 375.0 L 936.8 375.0 L 938.7 375.0 L 940.7 375.0 L 942.7 374.9 " +
      "L 944.7 374.9 L 946.9 374.9 L 949.0 374.9 L 951.3 374.9 L 953.6 374.9 L 956.1 374.8 L 958.6 " +
      "374.8 L 961.2 374.8 L 963.9 374.8 L 966.8 374.8 L 969.7 374.8 L 972.8 374.8 L 976.0 374.8 L " +
      "976.0 373.2 L 972.8 373.2 L 969.7 373.2 L 966.8 373.2 L 963.9 373.2 L 961.2 373.2 L 958.6 373.2 " +
      "L 956.1 373.2 L 953.6 373.1 L 951.3 373.1 L 949.0 373.1 L 946.9 373.1 L 944.7 373.1 L 942.7 " +
      "373.1 L 940.7 373.0 L 938.7 373.0 L 936.8 373.0 L 934.9 373.0 L 933.1 372.9 L 931.2 372.9 L " +
      "929.4 372.9 L 927.6 372.9 L 925.7 372.8 L 923.9 372.8 L 922.1 372.8 L 920.2 372.7 L 918.3 372.7 " +
      "L 916.4 372.6 L 914.4 372.6 L 912.4 372.5 L 910.3 372.5 L 908.2 372.4 L 906.0 372.4 Z",
    class: "fill-role-agent/55",
  },
  {
    d: "M 903.0 464.3 A 32 32 0 0 1 903.0 479.7",
    "stroke-width": "3.4",
    "stroke-linecap": "round",
    class: "fill-none stroke-role-agent",
  },
  {
    d:
      "M 906.0 473.6 L 908.2 473.6 L 910.3 473.5 L 912.4 473.5 L 914.4 473.4 L 916.4 473.4 L 918.3 " +
      "473.3 L 920.2 473.3 L 922.1 473.3 L 923.9 473.2 L 925.7 473.2 L 927.6 473.1 L 929.4 473.1 L " +
      "931.2 473.1 L 933.1 473.1 L 934.9 473.0 L 936.8 473.0 L 938.7 473.0 L 940.7 473.0 L 942.7 472.9 " +
      "L 944.7 472.9 L 946.9 472.9 L 949.0 472.9 L 951.3 472.9 L 953.6 472.9 L 956.1 472.8 L 958.6 " +
      "472.8 L 961.2 472.8 L 963.9 472.8 L 966.8 472.8 L 969.7 472.8 L 972.8 472.8 L 976.0 472.8 L " +
      "976.0 471.2 L 972.8 471.2 L 969.7 471.2 L 966.8 471.2 L 963.9 471.2 L 961.2 471.2 L 958.6 471.2 " +
      "L 956.1 471.2 L 953.6 471.1 L 951.3 471.1 L 949.0 471.1 L 946.9 471.1 L 944.7 471.1 L 942.7 " +
      "471.1 L 940.7 471.0 L 938.7 471.0 L 936.8 471.0 L 934.9 471.0 L 933.1 470.9 L 931.2 470.9 L " +
      "929.4 470.9 L 927.6 470.9 L 925.7 470.8 L 923.9 470.8 L 922.1 470.8 L 920.2 470.7 L 918.3 470.7 " +
      "L 916.4 470.6 L 914.4 470.6 L 912.4 470.5 L 910.3 470.5 L 908.2 470.4 L 906.0 470.4 Z",
    class: "fill-role-agent/55",
  },
];

const accountSources = {
  nodes: [
    [142, 329, 13],
    [142, 599, 17],
    [38, 149, 14],
    [38, 239, 14],
    [38, 329, 14],
    [38, 419, 18],
    [38, 509, 19],
    [38, 599, 20],
  ],
  links: [61, 62, 63, 64, 65, 66, 67, 68],
} as const;

export const scenes = {
  "empty-empty": {
    nodes: [[923, 374, 0]],
    tasks: [],
    links: [0, 1, 2],
    chrome: [
      { kind: "board", x: 520, y: 27, date: "January 1 · Thu", time: "08:00", title: "Board" },
      { kind: "button", x: 562, y: 263, label: "Add connection", icon: "plus" },
      { kind: "nav", x: 24, y: 732, active: "permissions" },
    ],
    mark: { x: 520, y: 280, size: 240, sourceAction: true, agentAction: false },
  },
  "portrait-expanded-empty": {
    nodes: [
      [4, 120, 1],
      [4, 196, 2],
      [4, 272, 3],
      [4, 348, 4],
      [496, 476, 5],
      [496, 552, 6],
      [496, 628, 7],
    ],
    tasks: [],
    links: [3, 4, 5, 6, 7],
    chrome: [
      { kind: "board", x: 200, y: 27, date: "January 1 · Thu", time: "08:00", title: "Board" },
      { kind: "nav", x: 24, y: 732, active: "" },
    ],
    mark: { x: 282, y: 400, size: 76, sourceAction: false, agentAction: false },
  },
  "portrait-expanded-two-tasks": {
    nodes: [
      [4, 76, 1],
      [4, 146, 2],
      [4, 216, 3],
      [4, 286, 4],
      [496, 468, 5],
      [496, 601, 6],
      [496, 671, 7],
    ],
    tasks: [
      [72, 413, 0],
      [72, 499, 1],
    ],
    links: [3, 8, 9, 10, 11, 12, 13, 14, 15, 16],
    chrome: [
      { kind: "board", x: 200, y: 27, date: "January 1 · Thu", time: "08:00", title: "2 running" },
      { kind: "nav", x: 24, y: 732, active: "" },
    ],
    mark: { x: 282, y: 332, size: 76, sourceAction: false, agentAction: false },
  },
  "portrait-sources-compacted": {
    nodes: [
      [4, 68, 1],
      [496, 374, 5],
      [496, 592, 6],
      [496, 646, 7],
    ],
    groups: [[4, 122, 2]],
    tasks: [
      [72, 233, 0],
      [72, 319, 1],
      [72, 405, 2],
      [72, 491, 3],
    ],
    links: [3, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29],
    chrome: [
      { kind: "board", x: 200, y: 27, date: "January 1 · Thu", time: "08:00", title: "4 running" },
      { kind: "nav", x: 24, y: 732, active: "" },
    ],
    mark: { x: 282, y: 156, size: 76, sourceAction: false, agentAction: false },
  },
  "portrait-sources-folded": {
    nodes: [
      [496, 333, 5],
      [496, 409, 6],
      [496, 485, 7],
    ],
    tasks: [],
    links: [3, 30, 31, 32],
    chrome: [
      { kind: "board", x: 200, y: 27, date: "January 1 · Thu", time: "08:00", title: "Board" },
      { kind: "nav", x: 24, y: 732, active: "" },
    ],
    mark: { x: 282, y: 257, size: 76, sourceAction: false, agentAction: false },
  },
  "portrait-agents-folded": {
    nodes: [
      [4, 225, 1],
      [4, 301, 2],
      [4, 377, 3],
      [4, 453, 4],
    ],
    tasks: [],
    links: [3, 33, 34, 35],
    chrome: [
      { kind: "board", x: 200, y: 27, date: "January 1 · Thu", time: "08:00", title: "Board" },
      { kind: "nav", x: 24, y: 732, active: "" },
    ],
    mark: { x: 282, y: 505, size: 76, sourceAction: false, agentAction: false },
  },
  "portrait-expanded-single-task": {
    nodes: [
      [4, 78, 1],
      [4, 166, 2],
      [4, 254, 3],
      [4, 342, 4],
      [129, 166, 8],
      [456, 500, 5],
      [456, 604, 9],
      [456, 692, 10],
      [456, 780, 11],
      [456, 868, 12],
    ],
    tasks: [[32, 488, 0]],
    links: [36, 37, 38, 39, 40, 41, 42],
    chrome: [
      { kind: "board", x: 200, y: 27, date: "January 1 · Thu", time: "08:00", title: "1 running" },
      { kind: "nav", x: 24, y: 932, active: "" },
    ],
    mark: { x: 282, y: 406, size: 76, sourceAction: false, agentAction: false },
  },
  "tasks-tasks": {
    nodes: [
      [142, 374, 13],
      [38, 374, 14],
      [817, 180, 0],
      [817, 417, 15],
      [817, 611, 16],
    ],
    tasks: [
      [976, 82, 4],
      [976, 168, 5],
      [976, 254, 6],
      [976, 362, 7],
      [976, 448, 8],
      [976, 556, 9],
      [976, 642, 10],
    ],
    links: [43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60],
    chrome: [
      { kind: "board", x: 414, y: 27, date: "1月1日 · 周四", time: "08:00", title: "7 进行中" },
      { kind: "nav", x: 24, y: 732, active: "permissions" },
    ],
    mark: { x: 414, y: 280, size: 240, sourceAction: false, agentAction: false },
  },
  "studio-studio": {
    nodes: [...accountSources.nodes, [713, 277, 15], [713, 473, 0], [817, 223, 21], [817, 322, 22]],
    tasks: [
      [872, 418, 11],
      [872, 504, 12],
      [976, 310, 13],
    ],
    links: [...accountSources.links, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83],
    chrome: [
      { kind: "board", x: 362, y: 27, date: "1月1日 · 周四", time: "08:00", title: "2 进行中" },
      { kind: "icon", x: 906, y: 218, icon: "plus" },
      { kind: "icon", x: 906, y: 250, icon: "check-check" },
      { kind: "nav", x: 24, y: 732, active: "permissions" },
    ],
    mark: { x: 381, y: 299, size: 203, sourceAction: false, agentAction: false },
  },
  "accounts-accounts": {
    nodes: [...accountSources.nodes, [713, 266, 15], [713, 471, 0], [713, 579, 23], [817, 212, 21], [817, 363, 22]],
    tasks: [
      [872, 459, 14],
      [872, 567, 15],
      [976, 157, 16],
      [976, 243, 17],
      [976, 351, 18],
    ],
    links: [...accountSources.links, 84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 76, 77, 78, 94, 95, 96, 97, 98, 99],
    chrome: [
      { kind: "board", x: 362, y: 27, date: "January 1 · Thu", time: "08:00", title: "3 running · 1 need attention" },
      { kind: "nav", x: 24, y: 732, active: "permissions" },
    ],
    mark: { x: 381, y: 299, size: 203, sourceAction: false, agentAction: false },
  },
  "accounts-dense": {
    nodes: [
      ...accountSources.nodes,
      [817, 207, 24],
      [817, 348, 25],
      [817, 446, 26],
      [713, 374, 0],
    ],
    groups: [[848, 546, 0], [744, 658, 1]],
    tasks: [
      [976, 152, 16],
      [976, 238, 15],
      [976, 336, 17],
      [976, 434, 14],
    ],
    links: [...accountSources.links, 76, 77, 78, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114],
    chrome: [
      { kind: "board", x: 362, y: 27, date: "November 8 · Sun", time: "05:37", title: "3 running" },
      { kind: "nav", x: 24, y: 732, active: "" },
    ],
    mark: { x: 381, y: 299, size: 203, sourceAction: false, agentAction: false },
  },
} as const;

export const dispatch = {
  model: "GPT-6.1 Sol",
  effort: "High reasoning effort",
  position: { count: 4, index: 2 },
  tier: "Fast",
  fast: true,
};
