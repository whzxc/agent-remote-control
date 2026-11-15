import './TaskPresentation.css';
import type { ComponentProps, ReactNode } from "react";
import { ShieldAlert } from "lucide-react";
import { Button, Icon } from "../ui/index";

import "../ui/TaskPresentation.css";
export function TaskMessage({ queued = false, className = "", ...props }: ComponentProps<"article"> & { queued?: boolean }) {
  return <article {...props} className={`task-message ${queued ? "task-message-queued" : ""} ${className}`} />;
}

export function RequestEntry({ title, summary, action, onOpen }: { title: string; summary?: string; action: string; onOpen: () => void }) {
  return <div className="request-entry"><Icon icon={ShieldAlert} size={18} /><div><strong>{title}</strong><span>{summary}</span></div>
    <Button aria-haspopup="dialog" onClick={onOpen}>{action}</Button></div>;
}

export function ReviewUnavailable({ children, action }: { children: ReactNode; action: ReactNode }) {
  return <div className="review-unavailable" role="alert"><span>{children}</span>{action}</div>;
}

export function OwnershipTag(props: ComponentProps<"span">) { return <span {...props} className="ownership-tag" />; }

export function RoutingRow({ children }: { children: ReactNode }) { return <div className="request-routing-inline">{children}</div>; }

export function TaskBackButton(props: ComponentProps<typeof Button>) { return <Button {...props} variant="ghost" className="task-back-button" />; }

export function StatePill({ state, children }: { state: string; children: ReactNode }) {
  return <span className="task-state" role="status" data-state={state}>{children}</span>;
}

export function TaskSpecTrigger(props: ComponentProps<'button'>) {
  return <button type="button" {...props} className="task-spec-choice" />;
}

export function TaskDateHeading({ children, attention = false }: { children: ReactNode; attention?: boolean }) {
  return <h3 className="agent-task-section-heading" data-attention={attention || undefined}>{children}</h3>;
}
