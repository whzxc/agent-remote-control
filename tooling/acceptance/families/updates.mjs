import { readFile } from 'node:fs/promises';
import path from 'node:path';
export const checks = [
    { stage: "verify", order: 37, visual: false, async run(context) {
            const { page, fixture, name, root } = context;
            let { model } = context;
            try {
                if (fixture.update && !fixture.coordination) {
                    // Regression: downloaded updates must expose a direct restart action.
                    const messages = JSON.parse(await readFile(path.join(root, 'ui/locales', `${fixture.language}.json`), 'utf8'));
                    if (fixture.page === 'settings') {
                        await page.getByRole('heading', { name: messages.aboutApp, exact: true }).waitFor({ state: 'visible' });
                        const history = page.getByRole('button', { name: messages['updates.history'], exact: true });
                        await history.waitFor();
                        if (name === 'updates-history') {
                            await history.click();
                            const dialog = page.getByRole('dialog', { name: messages['updates.history'], exact: true });
                            await dialog.getByRole('heading', { name: '0.9.50', exact: true }).waitFor();
                            await dialog.getByRole('listitem').filter({ hasText: '修复概览面板的位置偏移。' }).waitFor();
                        }
                    }
                    else {
                        const entry = page.locator('.navigation-capsule').getByRole('button', { name: messages.viewUpdate, exact: true });
                        await entry.waitFor({ state: 'visible' });
                        if (fixture.updatePanel === false)
                            await entry.click();
                        const panel = page.getByRole('dialog', { name: messages.appUpdates, exact: true });
                        await panel.waitFor({ state: 'visible' });
                        if (fixture.update.phase === 'downloading') {
                            await panel.getByRole('progressbar').waitFor();
                            await page.evaluate(async () => {
                                (await import('/scenarios.ts')).setScenarioReducedMotion(false);
                                await (await import('/state/appEnvironment.ts')).refreshAppEnvironment();
                            });
                            await page.waitForFunction(() => getComputedStyle(document.querySelector('.update-ring')).animationName === 'update-spin');
                            await page.keyboard.press('Escape');
                            await page.locator('[data-page="settings"]').click();
                            await entry.click();
                            await panel.getByRole('progressbar').waitFor();
                            const ownerClose = page.locator('.layer-panel').getByRole('button', { name: messages.backToHome, exact: true });
                            const rect = await ownerClose.boundingBox();
                            await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
                            await panel.waitFor({ state: 'hidden' });
                            await page.locator('.settings-page').waitFor();
                        }
                        else if (fixture.update.phase === 'installing') {
                            if (!await panel.getByRole('button', { name: messages['updates.installing'] }).isDisabled())
                                throw new Error('The update button is active while installation is running.');
                        }
                        else if (fixture.update.ready) {
                            await panel.getByRole('button', { name: messages['updates.restartNow'] }).waitFor();
                        }
                        if (name === 'updates-available-panel')
                            await panel.getByRole('listitem').filter({ hasText: '恢复旧 Codex 会话续跑时的任务气泡。' }).waitFor();
                        if (name === 'updates-download-failed') {
                            await panel.getByRole('alert').waitFor();
                            await panel.getByRole('button', { name: messages['updates.retryDownload'] }).waitFor();
                        }
                    }
                }
            }
            finally {
                context.model = model;
            }
        } }
];
