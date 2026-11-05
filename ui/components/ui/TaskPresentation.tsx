import type { ComponentProps, ReactNode } from "react";
import { ShieldAlert } from "lucide-react";
import { Button, Icon } from "./index";
import { Card } from "./card";
import "./TaskPresentation.css";

export function TaskCard({ reply = false, className = "", ...props }: ComponentProps<"section"> & { reply?: boolean }) {
  return <Card asChild padded variant={reply ? "reply" : "default"}><section {...props} className={className} /></Card>;
}
export function TaskMessage({ queued = false, className = "", ...props }: ComponentProps<"article"> & { queued?: boolean }) {
  return <article {...props} className={`task-message ${queued ? "task-message-queued" : ""} ${className}`} />;
}
export function RequestEntry({ title, summary, action, onOpen }: { title: string; summary?: string; action: string; onOpen: () => void }) {
  return <div className="request-entry"><Icon icon={ShieldAlert} size={18} /><div><strong>{title}</strong><span>{summary}</span></div>
    <Button aria-haspopup="dialog" onClick={onOpen}>{action}</Button></div>;
}
export function ReviewUnavailable({ children, action }: { children: ReactNode; action: ReactNode }) {
  return <div className="review-unavailable" role="status"><span>{children}</span>{action}</div>;
}
export function OwnershipTag(props: ComponentProps<"span">) { return <span {...props} className="ownership-tag" />; }
export function RoutingRow({ children }: { children: ReactNode }) { return <div className="request-routing-inline">{children}</div>; }
export function AgentPhaseTile({ children }: { children: ReactNode }) { return <span className="agent-phase-tile">{children}</span>; }

export function TaskBackButton(props: ComponentProps<typeof Button>) { return <Button {...props} variant="ghost" className="task-back-button" />; }
