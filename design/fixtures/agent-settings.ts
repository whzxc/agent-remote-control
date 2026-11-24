export type AgentCardSample = {
  brand: 'codex' | 'deepseek' | 'claude-code' | 'cursor' | 'antigravity' | 'opencode' | 'pi';
  name: string;
  meta: string;
  enabled: boolean;
  quotaLabel?: string;
  quotaTone?: 'success' | 'warning' | 'danger' | 'muted';
  spec?: string;
};

export const copy = {
  "text1": "Codex",
  "text2": "0.171.0 · Ready",
  "text3": "Codex",
  "text4": "Codex dispatch defaults",
  "text5": "Model and effort",
  "text6": "Model and effort",
  "text8": "Codex",
  "text9": "0.171.0",
  "text10": "Official setup",
  "text11": "Close",
  "text12": "Agents",
  "text13": "Refresh",
  "text14": "Installed",
  "text15": "Quota",
  "text16": "Agent settings",
  "notInstalled": "Not installed",
};

export const agentCards: AgentCardSample[] = [
  { brand: 'codex', name: 'Codex', meta: '0.171.0 · Ready', enabled: true, quotaLabel: 'Weekly 78%', quotaTone: 'success', spec: 'GPT-6.2-Sol' },
  { brand: 'deepseek', name: 'DeepSeek Harness', meta: '0.2.2 · Ready', enabled: true, quotaLabel: 'Shared plan', quotaTone: 'muted', spec: 'Default' },
  { brand: 'claude-code', name: 'Claude Code', meta: '2.1.327 · Ready', enabled: true, quotaLabel: 'Weekly 88%', quotaTone: 'success', spec: 'Claude 5.5' },
  { brand: 'antigravity', name: 'Antigravity', meta: '1.5.14 · Ready', enabled: true, quotaLabel: 'Weekly 93%', quotaTone: 'success', spec: 'Gemini 4 Neon' },
  { brand: 'cursor', name: 'Cursor Agent', meta: '2026.09 · Disabled', enabled: false, spec: 'Default' },
  { brand: 'opencode', name: 'OpenCode', meta: '2.2.6 · Disabled', enabled: false, spec: 'Default' },
];

export const uninstalledAgents = [
  { brand: 'pi' as const, name: 'Pi' },
];

export const samples = {
  "sample7": [
    "Agent default"
  ]
};

export const nativeCopy = {
  "text1": "This native Agent is ready. It does not require",
  "text2": "a provider account in ARC.",
  "text3": "Refresh",
  "text4": "Settings"
};
export const nativeCopySamples = {};
