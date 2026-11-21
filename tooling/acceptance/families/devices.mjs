import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { verifyDevices } from '../devices.mjs';
export const checks = [
    { stage: 'afterCapture', order: 48, visual: false, async run({ page, name }) {
        if (name !== 'device-detail-mac-en') return;
        // Restored detail has no live click trigger.
        await page.keyboard.press('Escape');
        const device = page.getByRole('button', { name: 'Cedar Mac', exact: true });
        await page.waitForFunction(node => document.activeElement === node, await device.elementHandle(), { timeout: 3000 });
    } },
    { stage: "prepare", order: 7, visual: true, async run(context) {
            const { page, fixture, root } = context;
            let { model } = context;
            try {
                if (fixture.deviceLink && !fixture.homepage) {
                    const messages = JSON.parse(await readFile(path.join(root, 'ui/locales', `${fixture.language}.json`), 'utf8'));
                    await verifyDevices(page, fixture, messages);
                }
            }
            finally {
                context.model = model;
            }
        } }
];
