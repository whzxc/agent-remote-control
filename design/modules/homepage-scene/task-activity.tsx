import type { ReactNode } from "react";
import { Icon } from 'adg';

export type TaskStepKind = 'reading' | 'editing' | 'command' | 'thinking' | 'waiting';

export type TaskStep = { kind: TaskStepKind; text: string; status: 'completed' | 'running' | 'pending'; elapsed?: string };

export type TaskPlan = { completed: number; total: number; current: string };

export type TaskChange = { kind: 'file' | 'diff' | 'command'; summary: string; added?: number; removed?: number; output?: string };

const icons: Record<TaskStepKind, string> = {
  reading: 'file-search', editing: 'file-pen-line', command: 'terminal', thinking: 'brain', waiting: 'clock-3',
};

export function TaskActivityIcon({ kind, size = 14 }: { kind: TaskStepKind; size?: number }) {
  return <Icon name={icons[kind]} size={size} />;
}

export function PhaseLabel({ children, phase = 'thinking', running = false }: { children: ReactNode; phase?: string; running?: boolean }) {
  return <span data-free className="relative min-w-0 overflow-hidden text-ellipsis" style={{ color: `var(--phase-${phase})` }}>
    {children}{running && <span className="absolute inset-0 opacity-15" aria-hidden="true">{children}</span>}
  </span>;
}
