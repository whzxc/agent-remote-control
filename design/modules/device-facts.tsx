import type { ReactNode } from "react";
import { Frame } from 'adg';
export function DeviceFacts({ children, variant = 'detail', className: extra }: { children: ReactNode; variant?: 'detail' | 'fingerprint' | 'identity'; className?: string }) {
  return <div className={extra ?? (variant === 'fingerprint' ? 'text-small' : '')}>{children}</div>;
}
export default () => <Frame name="content" width={480}><DeviceFacts className="flex flex-col gap-4">
  <DeviceFacts variant="identity"><strong className="text-body font-semibold">Cedar Mac</strong><p className="text-meta leading-4 text-text-secondary">Online · LAN · 4 ms</p></DeviceFacts>
  <DeviceFacts variant="fingerprint"><strong className="text-small font-semibold">Identity fingerprint · SHA-256</strong><p className="mt-1 font-mono text-meta leading-5 text-text-secondary">b10c b10c b10c b10c</p></DeviceFacts>
</DeviceFacts></Frame>;
