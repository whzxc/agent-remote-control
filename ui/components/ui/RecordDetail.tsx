import type { HTMLAttributes } from 'react';
import './RecordDetail.css';

type BlockProps = HTMLAttributes<HTMLElement> & { as?: 'div' | 'span' | 'section' | 'footer' | 'details' | 'li'; variant?: 'record' | 'issue' };
export function RecordDetail({ as: Element = 'section', variant = 'record', className = '', ...props }: BlockProps) {
  return <Element {...props} className={`${variant === 'issue' ? 'ax-detail' : 'center-detail'} ${className}`} />;
}
export function RecordListRow({ as: Element = 'div', className = '', ...props }: BlockProps) {
  return <Element {...props} className={`ax-row-body ${className}`} />;
}
export function RecordFooter({ as: Element = 'footer', variant = 'record', className = '', ...props }: BlockProps) {
  return <Element {...props} className={`${variant === 'issue' ? 'ax-footer' : 'center-footer'} ${className}`} />;
}
export function RecordEmpty({ as: Element = 'div', className = '', ...props }: BlockProps) {
  return <Element {...props} className={`center-empty ${className}`} />;
}
export function RecordDisclosure({ className = '', ...props }: HTMLAttributes<HTMLDetailsElement>) {
  return <details {...props} className={`center-technical ${className}`} />;
}
export function RecordEvent({ className = '', ...props }: HTMLAttributes<HTMLLIElement>) {
  return <li {...props} className={`center-event ${className}`} />;
}
export function RecordSurface({ variant = 'record', className = '', ...props }: Omit<BlockProps, 'as'>) {
  return <div {...props} className={`${variant === 'issue' ? 'ax-panel' : 'coordination-center'} ${className}`} />;
}
