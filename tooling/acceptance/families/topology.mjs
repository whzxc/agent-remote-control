import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { verifyPortraitTopology } from '../portrait-topology.mjs';
export const checks = [
    { stage: 'afterCapture', order: 48, visual: false, async run({ page, name }) {
        if (name !== 'topology-tuning-light') return;
        const trigger = page.getByRole('button', { name: 'Home topology tuning', exact: true });
        await trigger.click();
        const tuner = page.getByRole('dialog', { name: 'Home topology tuning' });
        const input = tuner.locator('.topology-parameter input:not([type="range"])').first();
        const original = await input.inputValue();
        await input.fill('99999');
        await input.press('Escape');
        if (!await tuner.isVisible() || await input.inputValue() !== original)
            throw new Error('Escape must revert a parameter edit before dismissing the tuner.');
        await page.keyboard.press('Escape');
        await tuner.waitFor({ state: 'hidden' });
    } },
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
