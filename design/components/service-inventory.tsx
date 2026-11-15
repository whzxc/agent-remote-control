import { Frame } from 'adg';
import { Card } from './card';
export function ServiceInventory({ children }: { children: unknown }) { return <div class="text-small text-text-secondary">{children}</div>; }
export default () => <Frame name="content" width={480}><ServiceInventory><Card padded>Connected</Card></ServiceInventory></Frame>;
