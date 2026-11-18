import './TaskPresentation.css';
import type { ComponentProps, ReactNode } from "react";
import { ShieldAlert } from "lucide-react";
import { t } from "../../i18n";
import { Button, Icon } from "../ui/index";

import "../ui/TaskPresentation.css";
export function TaskMessage({ text, status, queued = false, className = "", children, ...props }: ComponentProps<"article"> & { text?: string; status?: string; queued?: boolean }) {
  return <article {...props} className={`task-message ${queued || status ? "task-message-queued" : ""} ${className}`}>
    {text !== undefined ? <p>{text}</p> : children}
    {(status || queued && text !== undefined) && <span>{status || t("relay.queued")}</span>}
  </article>;
}

export function RequestEntry({ title, summary, action, onOpen }: { title: string; summary?: string; action: string; onOpen: () => void }) {
  return <div className="request-entry"><Icon icon={ShieldAlert} size={18} /><div><strong>{title}</strong>{summary && <span>{summary}</span>}</div>
    <Button aria-haspopup="dialog" onClick={onOpen}>{action}</Button></div>;
}

export function ReviewUnavailable({ children, action }: { children: ReactNode; action: ReactNode }) {
  return <div className="review-unavailable" role="alert"><span>{children}</span>{action}</div>;
}

export function OwnershipTag(props: ComponentProps<"span">) { return <span {...props} className="ownership-tag" />; }

export function RoutingRow({ children, inline = true }: { children: ReactNode; inline?: boolean }) {
  return <div className="request-routing-inline" data-inline={inline || undefined}>{children}</div>;
}

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
