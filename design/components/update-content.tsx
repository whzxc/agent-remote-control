import { Frame } from 'adg';
import { Card } from './card';
export function UpdateContent({ children }: { children: unknown }) { return <div class="text-small text-text-secondary">{children}</div>; }
export default () => <Frame name="content" width={480}><UpdateContent><Card padded>Connected</Card></UpdateContent></Frame>;
