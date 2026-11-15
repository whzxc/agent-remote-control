import type { HTMLAttributes } from 'react';
import './ServiceInventory.css';

const variants = {"server": "mcp-server", "tool": "mcp-tool", "import": "mcp-import"} as const;
type Props = HTMLAttributes<HTMLElement> & { as?: 'div' | 'section' | 'article' | 'li'; variant: keyof typeof variants };

export function ServiceInventory({ as: Element = 'div', variant, className = '', ...props }: Props) {
  return <Element {...props} className={`${variants[variant]} ${className}`} />;
}
