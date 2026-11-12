import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { escapeRegex } from './shared.mjs';
export const checks = [
    { stage: "verify", order: 11, visual: true, async run(context) {
            const { page, fixture, name, key, root, out, screenshots } = context;
            let { model } = context;
            try {
                if (fixture.browser) {
                    const messages = JSON.parse(await readFile(path.join(root, 'ui/locales', `${fixture.language}.json`), 'utf8'));
                    if (new URL(page.url()).searchParams.has('key'))
                        throw new Error('Browser retained the access key in its URL');
                    if (!await page.evaluate(() => Object.values(localStorage).includes('arc_fixture_browser_key')))
                        throw new Error('Browser did not retain the access key');
                    if (await page.getByRole('banner').count())
                        throw new Error('Browser added a separate status header');
                    await page.getByRole('button', { name: messages.manageAgents, exact: true }).click();
                    await page.getByRole('dialog', { name: messages.agents, exact: true }).waitFor();
                    const switches = page.getByRole('dialog', { name: messages.agents, exact: true }).getByRole('switch');
                    for (const toggle of await switches.all())
                        if (!await toggle.isDisabled())
                            throw new Error('Browser exposed an Agent write control');
                    await page.keyboard.press('Escape');
                    await page.getByRole('dialog').waitFor({ state: 'hidden' });
                    if (await page.getByRole('button', { name: messages.settings, exact: true }).count())
                        throw new Error('Browser exposed desktop settings');
                    const power = page.getByRole('button', { name: messages['hub.stopCore'], exact: true });
                    if (await power.count())
                        throw new Error('Browser exposed ingress controls');
                    await page.getByRole('button', { name: messages.addControlSource, exact: true }).click();
                    await page.getByRole('dialog').waitFor();
                    await page.keyboard.press('Escape');
                    await page.getByRole('dialog').waitFor({ state: 'hidden' });
                    await page.getByRole('button', { name: /^Codex: / }).click();
                    await page.getByRole('dialog').waitFor();
                    if (screenshots)
                        await page.screenshot({ path: path.join(out, `${key}-agent.png`) });
                    const task = page.getByRole('dialog').getByRole('button', { name: new RegExp(escapeRegex(fixture.tasks[0].title)) }).first();
                    await task.click();
                    await page.getByRole('dialog').waitFor();
                    await page.getByRole('dialog').getByText('npm run check', { exact: true }).waitFor();
                    for (const input of await page.getByRole('dialog').getByRole('textbox').all())
                        if (await input.isEnabled())
                            throw new Error('Browser exposed a task composer');
                    if (screenshots)
                        await page.screenshot({ path: path.join(out, `${key}-conversation.png`) });
                    await page.keyboard.press('Escape');
                    await page.getByRole('dialog').waitFor({ state: 'hidden' });
                }
            }
            finally {
                context.model = model;
            }
        } }
];
