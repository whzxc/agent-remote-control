import { createStore, preference } from '../state/store';
import { parseStudioPhase, type StudioTone } from './model';
const preview = import.meta.env.DEV && typeof location !== 'undefined' ? new URLSearchParams(location.search).get('studio') : null;
const fixture = preview !== null;
export const studioEnabled = fixture ? createStore(preview !== null) : preference('arc.display.enabled', false, raw => raw === 'true');
export const studioPhase = fixture ? createStore(parseStudioPhase(preview ?? 'auto')) : preference('arc.display.phase', 'auto', parseStudioPhase, value => value);
// A presentation override never changes the user's saved application theme.
export const studioTone = createStore<StudioTone | null>(null);
