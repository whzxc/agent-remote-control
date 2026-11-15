import type { ComponentProps, ReactNode } from 'react';
import { TaskContentCard } from '../ui/TaskPresentation';
import './TaskContent.css';

export function TaskReplyCard(props: ComponentProps<typeof TaskContentCard>) {
  return <TaskContentCard {...props} reply className={`task-final ${props.className ?? ''}`} />;
}
export function ContentProse({ children, className = '', ...props }: ComponentProps<'div'>) {
  return <div {...props} className={`markdown timeline-markdown ${className}`}>{children}</div>;
}
export function PlanContent({ children, settled, label }: { children: ReactNode; settled?: boolean; label: string }) {
  return <section className="task-plan" aria-label={label} data-settled={settled || undefined}>{children}</section>;
}
