import '../style.css';
import '../product.css';
import './browser.css';
import { createRoot } from 'react-dom/client';
import UiProvider from '../components/UiProvider';
import BrowserApp from './BrowserApp';
import { scenarioName } from '../scenarioMode';

const ready = import.meta.env.DEV && scenarioName ? await (await import('../scenarios')).installScenario(scenarioName) : undefined;
createRoot(document.getElementById('app')!).render(<UiProvider><BrowserApp /></UiProvider>);
if (ready) requestAnimationFrame(() => { void ready().catch(async error => { (await import('../state/scenarioReadiness')).finishScenario(String(error)); }); });
