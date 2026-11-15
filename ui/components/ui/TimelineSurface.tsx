import type { ComponentProps } from 'react';
import './TimelineSurface.css';

/** Shared typography and semantic states for a task timeline and its input layer. */
export function TimelineSurface({ className = '', ...props }: ComponentProps<'section'>) {
  return <section {...props} className={`task-detail-layer ${className}`} />;
}
export function ActivityHeading({ className = '', ...props }: ComponentProps<'div'>) {
  return <div {...props} className={`agent-panel-heading ${className}`} />;
}
export function TaskFeedSection({ className = '', ...props }: ComponentProps<'section'>) {
  return <section {...props} className={`homepage-task-section ${className}`} />;
}
export function TaskFilter({ className = '', ...props }: ComponentProps<'div'>) {
  return <div {...props} className={`homepage-task-filter ${className}`} />;
}
