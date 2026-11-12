import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { verifyPortraitTopology } from '../portrait-topology.mjs';
export const checks = [
    { stage: "verify", order: 17, visual: true, async run(context) {
            const { page, fixture, name, key, root, out, screenshots } = context;
            let { model } = context;
            try {
                if (name.startsWith('portrait-topology-')) {
                    const messages = JSON.parse(await readFile(path.join(root, 'ui/locales', `${fixture.language}.json`), 'utf8'));
                    await verifyPortraitTopology(page, fixture, messages, out, key, screenshots);
                    model = await page.evaluate(() => window.__ARC_VIEW_MODEL__());
                }
            }
            finally {
                context.model = model;
            }
        } }
];
