import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { verifyCoordination } from '../coordination.mjs';
export const checks = [
    { stage: "verify", order: 22, visual: true, async run(context) {
            const { page, fixture, key, row, root, out, screenshots } = context;
            let { model } = context;
            try {
                if (fixture.coordination) {
                    const messages = JSON.parse(await readFile(path.join(root, 'ui/locales', `${fixture.language}.json`), 'utf8'));
                    row.coordination = await verifyCoordination(page, fixture, messages, out, key, screenshots);
                }
            }
            finally {
                context.model = model;
            }
        } }
];
