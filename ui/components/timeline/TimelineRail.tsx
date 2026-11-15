import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Icon } from '../ui/index';
import './TimelineRail.css';

export function TimelineRailStep({ icon, phase, live, children }: { icon?: LucideIcon; phase?: string; live?: boolean; children: ReactNode }) {
  return <li className="relay-step" data-phase={phase} data-live={live || undefined}>
    <span className="relay-step-node" aria-hidden="true">{icon ? <Icon icon={icon} size={13} /> : <span className="relay-step-dot" />}</span>
    <div className="relay-step-content">{children}</div>
  </li>;
}

export function TurnProgress({ children }: { children: ReactNode }) {
  return <div className="task-turn-progress">{children}</div>;
}
