import type { HTMLAttributes } from 'react';
import './DeviceFacts.css';

const variants = {"detail": "device-detail", "fingerprint": "device-fingerprint", "identity": "device-identity"} as const;
type Props = HTMLAttributes<HTMLElement> & { as?: 'div' | 'section' | 'article' | 'li'; variant: keyof typeof variants };

export function DeviceFacts({ as: Element = 'div', variant, className = '', ...props }: Props) {
  return <Element {...props} className={`${variants[variant]} ${className}`} />;
}
