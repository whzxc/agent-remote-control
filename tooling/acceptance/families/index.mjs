import { readdir } from 'node:fs/promises';

const modules = await Promise.all((await readdir(new URL('.', import.meta.url)))
  .filter(name => name.endsWith('.mjs') && !['index.mjs', 'shared.mjs'].includes(name))
  .sort().map(name => import(new URL(name, import.meta.url))));
const checks = modules.flatMap(module => module.checks ?? []).sort((a, b) => a.order - b.order);

export const requiresBothThemes = fixture => modules.some(module => module.bothThemes?.(fixture));
export async function runScenarioChecks(stage, context) {
  for (const check of checks) {
    if (check.stage === stage && (context.behavior || check.visual)) await check.run(context);
  }
}
