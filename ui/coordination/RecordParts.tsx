import './RecordParts.css';
type BlockProps = import('react').HTMLAttributes<HTMLElement> & {as?:'div'|'span'|'section'|'footer'|'details'|'li';variant?:'record'|'issue'};
import type { HTMLAttributes } from 'react';
import '../components/ui/RecordDetail.css';
export function RecordListRow({ as: Element = 'div', className = '', ...props }: BlockProps) {
  return <Element {...props} className={`ax-row-body ${className}`} />;
}

export function RecordFooter({ as: Element = 'footer', variant = 'record', className = '', ...props }: BlockProps) {
  return <Element {...props} className={`${variant === 'issue' ? 'ax-footer' : 'center-footer'} ${className}`} />;
}

export function RecordDisclosure({ className = '', ...props }: HTMLAttributes<HTMLDetailsElement>) {
  return <details {...props} className={`center-technical ${className}`} />;
}

export function RecordEvent({ className = '', ...props }: HTMLAttributes<HTMLLIElement>) {
  return <li {...props} className={`center-event ${className}`} />;
}
