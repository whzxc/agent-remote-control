import type { HTMLAttributes } from 'react';
import './DeviceFacts.css';

type Props = HTMLAttributes<HTMLElement> & { as?: 'div' | 'section' | 'article' | 'li' };

export function DeviceFacts({ as: Element = 'div', ...props }: Props) {
  return <Element {...props} />;
}
