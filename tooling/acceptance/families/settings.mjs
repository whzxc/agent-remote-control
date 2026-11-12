import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chooseSpec, escapeRegex } from './shared.mjs';
export const checks = [
    { stage: "prepare", order: 4, visual: true, async run(context) {
            const { page, fixture, name, key, root, out, screenshots } = context;
            let { model } = context;
            try {
                if (name.startsWith('agent-settings-')) {
                    const messages = JSON.parse(await readFile(path.join(root, 'ui/locales', `${fixture.language}.json`), 'utf8'));
                    await page.getByRole('button', { name: new RegExp(`${escapeRegex(messages.manageAgents)}|${escapeRegex(messages.addAgent)}`) }).click();
                    if (fixture.agentDisplay) {
                        await page.getByRole('button', { name: messages.agentDisplaySettings, exact: true }).click();
                        const density = page.getByRole('radiogroup', { name: messages['activity.density'], exact: true });
                        if (await density.count()) {
                            const standard = density.getByRole('radio', { name: messages['activity.density.standard'], exact: true });
                            await standard.press('ArrowRight', { delay: 50 });
                            await density.getByRole('radio', { name: messages['activity.density.detailed'], exact: true, checked: true }).waitFor({ timeout: 3000 });
                            await density.getByRole('radio', { name: messages['activity.density.detailed'], exact: true }).press('ArrowLeft', { delay: 50 });
                            await density.getByRole('radio', { name: messages['activity.density.standard'], exact: true, checked: true }).waitFor({ timeout: 3000 });
                        }
                        else {
                            const trigger = page.getByRole('combobox', { name: messages['activity.density'], exact: true });
                            await trigger.press('Enter');
                            await page.getByRole('option', { name: messages['activity.density.detailed'], exact: true }).click();
                            await trigger.press('Enter');
                            await page.getByRole('option', { name: messages['activity.density.standard'], exact: true }).click();
                            if (!await trigger.evaluate(element => element === document.activeElement))
                                throw new Error('Density menu did not restore trigger focus.');
                        }
                    }
                    if (fixture.agentDetail) {
                        await page.getByRole('button', { name: 'Codex', exact: true }).first().click();
                        await page.getByRole('button', { name: messages['dispatchDefaults.spec'], exact: true }).click();
                        await chooseSpec(page, messages, 'GPT-6.1 Sol', messages['dispatchSpec.effort.max']);
                        if (screenshots)
                            await page.screenshot({ path: path.join(out, `${key}-effort.png`), animations: 'disabled' });
                        // An effort the newly selected model does not support falls back to the Agent default.
                        await chooseSpec(page, messages, 'GPT-5.6 Sol');
                        await page.locator(`[role=slider][aria-valuetext="${messages['dispatchDefaults.inherit']}"]`).waitFor();
                        await page.keyboard.press('Escape');
                    }
                }
            }
            finally {
                context.model = model;
            }
        } },
    { stage: "prepare", order: 5, visual: true, async run(context) {
            const { page, fixture, row, root } = context;
            let { model } = context;
            try {
                if (fixture.agentDisplay || fixture.page === 'settings') {
                    const settings = page.locator('.settings-stack').last();
                    await settings.waitFor();
                    const issues = await settings.evaluate(root => [...root.querySelectorAll('.setting')].flatMap(row => {
                        const copy = row.querySelector('.setting-copy').getBoundingClientRect();
                        const control = row.querySelector('.setting-control').getBoundingClientRect();
                        return copy.right > control.left || row.scrollWidth > row.clientWidth + 1
                            ? [row.textContent.trim()] : [];
                    }));
                    if (issues.length)
                        throw new Error(`Settings rows overlap or overflow: ${issues.join('; ')}`);
                }
            }
            finally {
                context.model = model;
            }
        } },
    { stage: "verify", order: 23, visual: true, async run(context) {
            const { page, fixture, name, root } = context;
            let { model } = context;
            try {
                if (fixture.settingsExtras) {
                    // Regression: experimental pets were exposed as a primary navigation page.
                    const messages = JSON.parse(await readFile(path.join(root, 'ui/locales', `${fixture.language}.json`), 'utf8'));
                    await page.getByRole('radio', { name: messages['topology.experimental'] }).click();
                    const pets = page.getByRole('switch', { name: messages['pets.show'], exact: true });
                    const studio = page.getByRole('switch', { name: messages['studio.enabled'], exact: true });
                    if (await pets.isChecked() !== !!fixture.pets || await studio.isChecked() !== !!fixture.studio)
                        throw new Error('Experimental defaults differ from fixture preferences');
                    await pets.click();
                    await pets.click();
                }
            }
            finally {
                context.model = model;
            }
        } }
];
