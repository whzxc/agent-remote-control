import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { verifyDevices } from '../devices.mjs';
export const checks = [
    { stage: "prepare", order: 7, visual: true, async run(context) {
            const { page, fixture, root } = context;
            let { model } = context;
            try {
                if (fixture.deviceLink) {
                    const messages = JSON.parse(await readFile(path.join(root, 'ui/locales', `${fixture.language}.json`), 'utf8'));
                    await verifyDevices(page, fixture, messages);
                }
            }
            finally {
                context.model = model;
            }
        } }
];
