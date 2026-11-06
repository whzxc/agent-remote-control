import { memo, useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { Minus, Plus } from 'lucide-react';
import { Button, IconButton, SingleChoice } from './components/ui';
import { dark, theme, type Theme } from './theme';
import './style.css';
import './design-gallery.css';

type Asset = { name: string; path: string };
type Manifest = { assets: Asset[]; revision: number };
type Box = { x: number; y: number; width: number; height: number };
type View = { x: number; y: number; scale: number };
const modules = [
  { title: 'Essentials', names: ['button', 'icon-button', 'switch', 'single-choice', 'field', 'search', 'tag', 'state-pill', 'tile', 'card', 'panel', 'tooltip', 'notice', 'copy-field'] },
  { title: 'Homepage & topology', names: ['homepage-topology-empty', 'homepage-topology-tasks', 'homepage-topology-accounts', 'homepage-topology-studio', 'homepage-topology-portrait', 'topology-mark', 'topology-node', 'topology-scene', 'nav-capsule'] },
  { title: 'Agents & quota', names: ['agent-panel', 'agent-platform', 'quota-overview', 'quota-card', 'effort-gauge', 'effort-slider'] },
  { title: 'Tasks & interactions', names: ['task-detail', 'approval', 'task-bubble', 'dispatch-spec', 'task-message', 'prompt', 'request-routing'] },
  { title: 'Connections & platforms', names: ['setup', 'connections', 'platforms', 'source-panel', 'setup-choice', 'mcp-hub'] },
  { title: 'Settings & extensions', names: ['settings', 'coordination', 'pets-settings', 'relay-hosting', 'updates', 'settings-row', 'gallery'] },
];
const assigned = new Set(modules.flatMap(group => group.names));
const groupAssets = (assets: Asset[]) => modules.map((group, index) => ({
  ...group, x: index % 3 * 1592, y: Math.floor(index / 3) * 1696,
  assets: [...group.names.flatMap(name => assets.filter(asset => asset.name === name)),
    ...(index === 5 ? assets.filter(asset => !assigned.has(asset.name)) : [])],
}));
const world = { x: 0, y: 0, width: 4680, height: 3288 };
const themes = [{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }];
const clamp = (scale: number) => Math.min(16, Math.max(.05, scale));
const assetBox = (group: ReturnType<typeof groupAssets>[number], index: number): Box => {
  const row = group.assets.length > 9 ? 248 : 416;
  return { x: group.x + 56 + index % 3 * 464, y: group.y + 200 + Math.floor(index / 3) * row, width: 432, height: row - 16 };
};

const Drawing = memo(function Drawing({ asset, visible, detail, theme, revision }: {
  asset: Asset; visible: boolean; detail: boolean; theme: string; revision: number;
}) {
  const url = `/asset/${asset.path}?theme=${theme}&v=${revision}`;
  const [drawing, setDrawing] = useState<{ url: string; svg: string }>();
  const [error, setError] = useState('');
  useEffect(() => {
    setError('');
    if (!visible || !detail) { setDrawing(undefined); return; }
    const controller = new AbortController();
    void fetch(`${url}&inline=1`, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error(`Cannot load ${asset.name} (HTTP ${response.status}).`);
      setDrawing({ url, svg: await response.text() });
    }).catch(error => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, [url, visible, detail, asset.name]);
  return <div className="gallery-drawing">
    {error ? <span role="alert">{error}</span> : visible && (detail && drawing?.url === url
      ? <div className="gallery-vector" aria-hidden="true" dangerouslySetInnerHTML={{ __html: drawing.svg }} />
      : <img src={url} alt="" decoding="async" draggable={false} onError={() => setError(`Cannot load ${asset.name}.`)} />)}
  </div>;
});

function Gallery({ assets, revision }: Manifest) {
  const groups = useMemo(() => groupAssets(assets), [assets]);
  const viewport = useRef<HTMLDivElement>(null);
  const camera = useRef<View>({ x: 0, y: 0, scale: .25 });
  const [view, setView] = useState(camera.current);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [active, setActive] = useState<number | null>(null);
  const selectedTheme = theme.use();
  const isDark = dark.use();
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef({ moved: false, startX: 0, startY: 0, asset: '' });
  const animation = useRef(0);
  const commit = (next: View) => {
    camera.current = next;
    if (!animation.current) animation.current = requestAnimationFrame(() => { animation.current = 0; setView(camera.current); });
  };
  const frame = (box: Box) => {
    const el = viewport.current;
    if (!el) return;
    const scale = clamp(Math.min((el.clientWidth - 48) / box.width, (el.clientHeight - 48) / box.height));
    commit({ scale, x: (el.clientWidth - box.width * scale) / 2 - box.x * scale, y: (el.clientHeight - box.height * scale) / 2 - box.y * scale });
  };
  const fit = () => { setActive(null); frame(world); };
  const zoom = (scale: number, x?: number, y?: number) => {
    const el = viewport.current;
    if (!el) return;
    const previous = camera.current, next = clamp(scale);
    x ??= el.clientWidth / 2; y ??= el.clientHeight / 2;
    commit({ scale: next, x: x - (x - previous.x) * next / previous.scale, y: y - (y - previous.y) * next / previous.scale });
  };
  const focusAsset = (path: string) => {
    for (const [groupIndex, group] of groups.entries()) {
      const index = group.assets.findIndex(asset => asset.path === path);
      if (index >= 0) { setActive(groupIndex); frame(assetBox(group, index)); return; }
    }
  };
  useEffect(() => {
    const el = viewport.current!;
    let previousWidth = el.clientWidth, previousHeight = el.clientHeight;
    frame(world);
    setSize({ width: el.clientWidth, height: el.clientHeight });
    const resize = new ResizeObserver(() => {
      setSize({ width: el.clientWidth, height: el.clientHeight });
      const current = camera.current;
      commit({ ...current, x: current.x + (el.clientWidth - previousWidth) / 2, y: current.y + (el.clientHeight - previousHeight) / 2 });
      previousWidth = el.clientWidth; previousHeight = el.clientHeight;
    });
    resize.observe(el);
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? el.clientHeight : 1);
      zoom(camera.current.scale * Math.exp(-Math.max(-300, Math.min(300, delta)) * .002), event.clientX - rect.left, event.clientY - rect.top);
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => { cancelAnimationFrame(animation.current); resize.disconnect(); el.removeEventListener('wheel', wheel); };
  }, []);
  const down = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 && event.button !== 1) return;
    event.preventDefault();
    const points = pointers.current;
    points.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (points.size === 1) gesture.current = { moved: false, startX: event.clientX, startY: event.clientY, asset: (event.target as HTMLElement).closest<HTMLElement>('[data-asset]')?.dataset.asset ?? '' };
    else gesture.current.moved = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus({ preventScroll: true });
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const points = pointers.current, previousPoint = points.get(event.pointerId);
    if (!previousPoint) return;
    const before = [...points.values()];
    points.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (Math.hypot(event.clientX - gesture.current.startX, event.clientY - gesture.current.startY) > 4) gesture.current.moved = true;
    const current = camera.current;
    if (points.size === 1) commit({ ...current, x: current.x + event.clientX - previousPoint.x, y: current.y + event.clientY - previousPoint.y });
    else if (points.size === 2) {
      const after = [...points.values()], rect = event.currentTarget.getBoundingClientRect();
      const distance = (p: typeof before) => Math.hypot(p[1].x - p[0].x, p[1].y - p[0].y);
      const oldDistance = distance(before);
      if (oldDistance < 1) return;
      const scale = clamp(current.scale * distance(after) / oldDistance);
      const oldX = (before[0].x + before[1].x) / 2 - rect.left, oldY = (before[0].y + before[1].y) / 2 - rect.top;
      const newX = (after[0].x + after[1].x) / 2 - rect.left, newY = (after[0].y + after[1].y) / 2 - rect.top;
      commit({ scale, x: newX - (oldX - current.x) * scale / current.scale, y: newY - (oldY - current.y) * scale / current.scale });
    }
  };
  const up = (event: PointerEvent<HTMLDivElement>) => {
    const tracked = pointers.current.delete(event.pointerId);
    if (!tracked) return;
    if (event.type === 'pointerup' && !gesture.current.moved && gesture.current.asset) focusAsset(gesture.current.asset);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return <div className="design-gallery" onKeyDown={event => {
    if (event.key === 'Escape') { fit(); viewport.current?.focus({ preventScroll: true }); }
  }}>
    <header className="gallery-header"><h1>Design canvas</h1><div className="gallery-theme"><SingleChoice label="Theme" options={themes} value={selectedTheme} onChange={value => theme.set(value as Theme)} /></div><Button onClick={fit}>Fit all</Button></header>
    <nav className="gallery-modules" aria-label="Design modules"><h2>Modules</h2>{groups.map((group, index) => <button key={group.title} type="button" aria-current={active === index ? 'location' : undefined} onClick={() => { setActive(index); frame({ ...group, width: 1496, height: 1592 }); }}><span>{index === 4 ? 'Connections & MCP' : group.title}</span><span>{group.assets.length}</span></button>)}</nav>
    <main className="gallery-viewport" ref={viewport} tabIndex={0} aria-label="Design canvas" aria-describedby="canvas-controls"
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onLostPointerCapture={up}
      onKeyDown={event => {
        if (event.target !== event.currentTarget) return;
        const current = camera.current;
        if (event.key === '+' || event.key === '=') zoom(current.scale * 1.25);
        else if (event.key === '-') zoom(current.scale / 1.25);
        else if (event.key === '0') fit();
        else if (event.key === '1') zoom(1);
        else if (event.key.startsWith('Arrow')) commit({ ...current, x: current.x + (event.key === 'ArrowLeft' ? 80 : event.key === 'ArrowRight' ? -80 : 0), y: current.y + (event.key === 'ArrowUp' ? 80 : event.key === 'ArrowDown' ? -80 : 0) });
        else return;
        event.preventDefault();
      }}>
      <div className="gallery-world" style={{ width: world.width, height: world.height, transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}>
        {groups.map(group => <section className="gallery-group" key={group.title} aria-label={group.title} style={{ left: group.x, top: group.y }}>
          <h2>{group.title}<span>{group.assets.length}</span></h2>
          {group.assets.map((asset, index) => {
            const box = assetBox(group, index);
            const visible = view.x + (box.x + box.width) * view.scale > -100 && view.x + box.x * view.scale < size.width + 100
              && view.y + (box.y + box.height) * view.scale > -100 && view.y + box.y * view.scale < size.height + 100;
            return <button className="gallery-asset" key={asset.path} data-asset={asset.path} title={asset.path} aria-label={`View ${asset.name}`} style={{ left: box.x - group.x, top: box.y - group.y, width: box.width, height: box.height }}
              onClick={event => { if (event.detail === 0) focusAsset(asset.path); }} onFocus={event => { if (event.target.matches(':focus-visible')) focusAsset(asset.path); }}>
              <Drawing asset={asset} visible={visible} detail={view.scale >= .8} theme={isDark ? 'dark' : 'light'} revision={revision} />
              <span>{asset.name.replace('homepage-topology-', '').replace('topology-', '')}</span>
            </button>;
          })}
        </section>)}
      </div>
    </main>
    <div className="gallery-zoom" aria-label="Canvas zoom"><IconButton icon={Minus} label="Zoom out" onClick={() => zoom(view.scale / 1.25)} /><output aria-label="Zoom">{Math.round(view.scale * 100)}%</output><IconButton icon={Plus} label="Zoom in" onClick={() => zoom(view.scale * 1.25)} /><Button variant="ghost" onClick={() => zoom(1)}>100%</Button></div>
    <p id="canvas-controls" className="gallery-sr">Drag to pan. Scroll or pinch to zoom. Use arrow keys to pan, plus and minus to zoom, zero to fit all, and one for 100%. Select an asset to fit it. Escape returns to the overview.</p>
  </div>;
}

function DesignMode() {
  const [manifest, setManifest] = useState<Manifest>();
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    const refresh = async () => {
      try {
        const response = await fetch('/manifest', { signal: controller.signal });
        if (!response.ok) throw new Error(`Cannot load design assets (HTTP ${response.status}).`);
        setManifest(await response.json()); setError('');
      } catch (error) { if (!controller.signal.aborted) setError((error as Error).message); }
    };
    const events = new EventSource('/events');
    events.onmessage = () => { void refresh(); };
    events.onerror = () => setError('Design server disconnected. Reconnecting…');
    return () => { controller.abort(); events.close(); };
  }, []);
  return <>{manifest && <Gallery {...manifest} />}{error && <div className="gallery-error" role="alert">{error}</div>}</>;
}

createRoot(document.getElementById('root')!).render(<DesignMode />);
