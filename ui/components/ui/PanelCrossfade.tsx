import { Component, type ReactNode } from 'react';
import { motionTransition } from '../../motion/tokens';

const regions = ':scope > .dialog-header, :scope > .layer-custom-header, :scope > .dialog-body';
const paintSheets = new WeakMap<CSSStyleSheet, CSSStyleSheet>();

function sheetForPaint(source: CSSStyleSheet) {
  const cached = paintSheets.get(source);
  if (cached) return cached;

  const href = source.href;
  const sheet = new CSSStyleSheet({ baseURL: href ?? document.baseURI, media: source.media.mediaText });
  let css = Array.from(source.cssRules, rule => rule.cssText).join('\n');
  if (href) {
    // Chromium ignores baseURL. Resolve Vite's relative asset URLs in the serialized CSSOM.
    css = css.replace(/url\("([^"\\]+)"\)/g, (value, url: string) => {
      if (/^(?:#|\/|[\w+.-]+:)/.test(url)) return value;
      return `url("${new URL(url, href).href}")`;
    });
  }
  sheet.replaceSync(css);
  paintSheets.set(source, sheet);
  return sheet;
}

/** Keep the old paint outside the live form, accessibility tree and height measurement. */
function capturePanel(content: HTMLElement) {
  const shell = content.parentElement!;
  const bounds = shell.getBoundingClientRect();
  const overlay = document.createElement('div');
  overlay.className = 'panel-outgoing';
  overlay.inert = true;
  overlay.setAttribute('aria-hidden', 'true');
  const shadow = overlay.attachShadow({ mode: 'closed' });
  const surface = shell.cloneNode(false) as HTMLElement;
  Object.assign(surface.style, { position: 'relative', inset: 'auto', width: bounds.width + 'px',
    height: bounds.height + 'px', background: 'none', boxShadow: 'none', opacity: '1' });
  const layout = content.cloneNode(false) as HTMLElement;
  surface.append(layout);
  const scroll: Array<() => void> = [];
  for (const part of content.querySelectorAll<HTMLElement>(regions)) {
    const box = part.getBoundingClientRect();
    if (!box.width || !box.height) continue;
    const copy = part.cloneNode(true) as HTMLElement;
    Object.assign(copy.style, { position: 'absolute', margin: '0', top: box.y - bounds.y + 'px',
      left: box.x - bounds.x + 'px', width: box.width + 'px', height: box.height + 'px', opacity: '1' });
    layout.append(copy);
    const originals = [part, ...part.querySelectorAll<HTMLElement>('*')];
    const copies = [copy, ...copy.querySelectorAll<HTMLElement>('*')];
    originals.forEach((el, index) => {
      const { scrollTop, scrollLeft } = el;
      if (scrollTop || scrollLeft) scroll.push(() => copies[index].scrollTo(scrollLeft, scrollTop));
    });
    copy.querySelectorAll('iframe, object, embed, audio, video').forEach(el => el.remove());
  }
  return { overlay, mount() {
    shell.append(overlay);
    // Connect the host first so WebKit applies adopted styles as soon as the content is inserted.
    shadow.adoptedStyleSheets = Array.from(document.styleSheets).filter(sheet => !sheet.disabled).map(sheetForPaint);
    shadow.append(surface);
    scroll.forEach(restore => restore());
  } };
}

/** One transition per physical panel. A new owner can arrive through a different React portal. */
export class PanelPaint {
  private outgoing?: ReturnType<typeof capturePanel>;
  private animations: Animation[] = [];

  settle() {
    for (const animation of this.animations) animation.cancel();
    this.animations = [];
    this.outgoing?.overlay.remove();
    this.outgoing = undefined;
  }

  capture(content: HTMLElement) {
    this.settle();
    this.outgoing = capturePanel(content);
  }

  enter(content: HTMLElement) {
    const outgoing = this.outgoing;
    if (!outgoing || this.animations.length) return;
    const timing: KeyframeAnimationOptions = { duration: motionTransition('fast').duration * 1000,
      easing: getComputedStyle(content).getPropertyValue('--ease-enter').trim(), fill: 'both' };
    outgoing.mount();
    const exit = outgoing.overlay.animate([{ opacity: 1 }, { opacity: 0 }], timing);
    this.animations = [exit, ...Array.from(content.querySelectorAll<HTMLElement>(regions),
      part => part.animate([{ opacity: 0 }, { opacity: 1 }], timing))];
    exit.onfinish = () => { if (this.outgoing === outgoing) this.settle(); };
  }
}

type Props = { paint: PanelPaint; content: HTMLElement | null; identity: string; enabled: boolean; children: ReactNode };

/** Read the outgoing portal before React rewrites it, including a retiring owner's last commit. */
export class PanelCrossfade extends Component<Props> {
  private capture() {
    const { content, paint, enabled } = this.props;
    if (enabled && content?.isConnected && !content.parentElement?.hasAttribute('data-exiting')) paint.capture(content);
  }
  getSnapshotBeforeUpdate(previous: Props) {
    if (previous.identity !== this.props.identity) this.capture();
    return null;
  }
  componentWillUnmount() { this.capture(); }
  componentDidMount() { this.enter(); }
  componentDidUpdate() { this.enter(); }
  private enter() {
    const { content, paint, enabled } = this.props;
    if (enabled && content) paint.enter(content);
    else paint.settle();
  }
  render() { return this.props.children; }
}
