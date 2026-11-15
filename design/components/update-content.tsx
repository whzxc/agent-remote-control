import { Frame } from 'adg';
export function UpdateContent({ children, class: extra = '' }: { children: unknown; class?: string }) { return <div class={extra}>{children}</div>; }
export default () => <Frame name="content" width={480}><UpdateContent class="text-body leading-5 text-text-secondary">
  <h3 class="text-small leading-4 font-semibold text-text">Fixes</h3>
  <ul class="mt-2 pl-5 list-disc"><li>Restore the previous task after reopening.</li></ul>
</UpdateContent></Frame>;
