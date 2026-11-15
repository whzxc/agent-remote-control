import type { ComponentProps } from 'react';
import { HoverScope } from '../ui/index';
import './NavCapsule.css';

export function NavCapsule({ children, activeKey, ...props }: ComponentProps<'nav'> & { activeKey?: string }) {
  return <nav {...props} className="navigation-capsule">
    <HoverScope activeKey={activeKey} className="capsule-icons">{children}</HoverScope>
  </nav>;
}
