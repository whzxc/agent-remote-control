// Native-only fixture: exercise the production controller and official IPC resources.
import { updates, checkUpdate, downloadUpdate, installUpdate, startUpdateChecks } from '../../ui/state/updates';
declare const __UPDATE_ACCEPTANCE_ENDPOINT__: string;
const request = (path: string, options?: RequestInit) => fetch(__UPDATE_ACCEPTANCE_ENDPOINT__ + path, options);
const instance = crypto.randomUUID();
const error = (reason: unknown) => { void request('/error', {method:'POST',body:JSON.stringify({error:String(reason)})}).catch(() => {}); };
window.addEventListener('error', event => error(event.message));
window.addEventListener('unhandledrejection', event => error(event.reason));
const report = () => request('/state', { method: 'POST', body: JSON.stringify({ instance, view: updates.get() }) });
await request('/hello', { method: 'POST', body: JSON.stringify({ instance }) });
updates.subscribe(() => { void report(); });
await report();
startUpdateChecks();
async function execute(command: { id: number; action: 'check' | 'download' | 'install' }) {
  let error: string | undefined;
  try { await ({ check: checkUpdate, download: downloadUpdate, install: installUpdate }[command.action])(); }
  catch (reason) { error = String(reason); }
  await request('/result', { method: 'POST', body: JSON.stringify({ id: command.id, view: updates.get(), error }) });
}
for (;;) {
  const command = await request('/next').then(response => response.json());
  void execute(command);
}
