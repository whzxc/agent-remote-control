import type { ReactNode } from "react";
import type { AgentPhase } from "../../types";
import "./TaskPhase.css";

export function PhaseLabel({ phase, running = false, completed = false, children }: {
  phase: AgentPhase; running?: boolean; completed?: boolean; children: ReactNode;
}) {
  return <span className="phase-label" data-phase={completed ? "completed" : phase} data-running={running || undefined}>{children}
    {running && <span className="phase-shimmer" aria-hidden="true"><span>{children}</span></span>}
  </span>;
}
