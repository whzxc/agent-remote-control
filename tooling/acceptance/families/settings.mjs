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
                    const grid = page.getByRole('dialog', { name: messages.agents, exact: true }).locator('.agent-grid');
                    await grid.waitFor();
                    if (!await grid.evaluate(element => {
                        const columns = getComputedStyle(element).gridTemplateColumns.trim().split(/\s+/).length;
                        const expected = Math.max(1, Math.floor((element.clientWidth + 12) / (272 + 12)));
                        return columns === expected && !element.querySelector('[data-reorderable]');
                    })) throw new Error('Installed Agents must use the responsive inventory grid.');
                    if (fixture.agentDisplay) {
                        await page.getByRole('button', { name: messages.agentDisplaySettings, exact: true }).click();
                        const quota = page.getByRole('radiogroup', { name: messages.agentQuotaDisplay, exact: true });
                        if (await quota.count()) {
                            await quota.getByRole('radio', { name: messages.usageUsed, exact: true }).click();
                            await quota.getByRole('radio', { name: messages.usageUsed, exact: true, checked: true }).waitFor();
                        } else {
                            await page.getByRole('combobox', { name: messages.agentQuotaDisplay, exact: true }).click();
                            await page.getByRole('option', { name: messages.usageUsed, exact: true }).click();
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
                        await page.getByRole('slider', { name: messages['dispatchDefaults.effort'] }).and(page.locator(`[aria-valuetext="${messages['dispatchDefaults.inherit']}"]`)).waitFor();
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
                if (name === 'settings-about-light') {
                    const messages = JSON.parse(await readFile(path.join(root, 'ui/locales', `${fixture.language}.json`), 'utf8'));
                    const label = messages['desktopRecovery.setting'];
                    const choice = page.getByRole('combobox', { name: label, exact: true });
                    if (await choice.count()) {
                        await choice.getByText(messages['desktopRecovery.prompt'], { exact: true }).waitFor();
                        await choice.click();
                        await page.getByRole('option', { name: messages['desktopRecovery.restart'], exact: true }).click();
                        await choice.getByText(messages['desktopRecovery.restart'], { exact: true }).waitFor();
                    } else {
                        const row = page.getByRole('radiogroup', { name: label, exact: true });
                        await row.getByRole('radio', { name: messages['desktopRecovery.prompt'], checked: true }).waitFor();
                        await row.getByRole('radio', { name: messages['desktopRecovery.restart'], exact: true }).click();
                        await row.getByRole('radio', { name: messages['desktopRecovery.restart'], checked: true }).waitFor();
                    }
                }
            }
            finally {
                context.model = model;
            }
        } }
];
