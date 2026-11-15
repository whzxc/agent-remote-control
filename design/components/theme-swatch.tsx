import { Frame } from 'adg';
import { copy } from '../fixtures/display-settings';

export function ThemeSwatch({ value }: { value: string }) { return (<svg width="16" height="16" viewBox="0 0 16 16">
                    <circle cx="8" cy="8" r="8" fill={`var(--theme-swatch-${value}-left)`} />
                    <path d="M8 0a8 8 0 0 1 0 16Z" fill={`var(--theme-swatch-${value}-right)`} />
                  </svg>); }
export default () => <Frame name="theme-swatch" width={16}><div class="flex w-full bg-surface-raised"><ThemeSwatch value={copy.text40} /></div></Frame>;
