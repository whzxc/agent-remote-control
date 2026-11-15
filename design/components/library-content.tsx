import {Frame} from 'adg';
export function LibraryContent({children}:{children:unknown}){return <div class="text-small text-text-secondary">{children}</div>}
export default ()=><Frame name="library" width={480}><LibraryContent><h3 class="text-body font-[650] text-text">Mascot</h3><p>Installed</p></LibraryContent></Frame>;
