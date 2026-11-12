export const modeCopy = {
  label: 'Homepage mode', topology: 'Topology', execution: 'Execution',
  date: 'January 1 · Thu', time: '08:00', board: 'Board',
};
export const modeForms = [
  { name: 'mode-switch-topology-attention', mode: 'topology', attention: 2 },
  { name: 'mode-switch-execution', mode: 'execution', attention: 2 },
] as const;
