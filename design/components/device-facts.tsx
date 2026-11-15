import { Frame } from 'adg';
export function DeviceFacts({ children, variant = 'detail', class: extra }: { children: unknown; variant?: 'detail' | 'fingerprint' | 'identity'; class?: string }) {
  return <div class={extra ?? (variant === 'fingerprint' ? 'text-small' : '')}>{children}</div>;
}
export default () => <Frame name="content" width={480}><DeviceFacts class="flex flex-col gap-4">
  <DeviceFacts variant="identity"><strong class="text-body font-semibold">Cedar Mac</strong><p class="text-meta leading-4 text-text-secondary">Online · LAN · 4 ms</p></DeviceFacts>
  <DeviceFacts variant="fingerprint"><strong class="text-small font-semibold">Identity fingerprint · SHA-256</strong><p class="mt-1 font-mono text-meta leading-5 text-text-secondary">b10c b10c b10c b10c</p></DeviceFacts>
</DeviceFacts></Frame>;
