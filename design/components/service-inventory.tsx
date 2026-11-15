import { Frame } from 'adg';
export function ServiceInventory({ children, variant = 'server', class: extra }: { children: unknown; variant?: 'server' | 'tool' | 'import'; class?: string }) {
  const defaults = { server: 'rounded-card bg-surface-subtle p-4 text-text', tool: 'text-meta leading-[14px] text-text-secondary', import: 'text-small text-text-secondary' };
  return <div class={extra ?? defaults[variant]}>{children}</div>;
}
export default () => <Frame name="content" width={480}><ServiceInventory>
  <h3 class="text-body leading-5 font-[650]">workspace</h3>
  <p class="text-meta leading-4 text-text-secondary">stdio · /workspace/tools</p>
  <ServiceInventory variant="tool" class="mt-3 rounded-[14px] bg-surface p-3 text-meta leading-[14px] text-text-secondary">
    <code class="font-mono text-small leading-4 font-medium text-text">read_file</code><p class="mt-1">Read a file in the selected workspace.</p>
  </ServiceInventory>
</ServiceInventory></Frame>;
