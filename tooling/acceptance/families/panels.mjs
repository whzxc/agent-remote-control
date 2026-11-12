import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { checkNodePanelBounds, checkOverviewGrowth } from './shared.mjs';
export const checks = [
    { stage: "verify", order: 19, visual: true, async run(context) {
            const { page, fixture, name, width, height, key, out, screenshots } = context;
            let { model } = context;
            try {
                if (name === 'agent-panel-short' || name === 'agent-panel-loading') {
                    const dialog = page.getByRole('dialog', { name: 'Codex', exact: true });
                    const top = await page.evaluate(async () => (await import('/platform.ts')).isDesktop ? 48 : 20);
                    let loadingBox;
                    if (fixture.historyDelayMs) {
                        await dialog.getByText('正在加载…', { exact: true }).waitFor();
                        loadingBox = await dialog.boundingBox();
                        if (screenshots)
                            await page.screenshot({ path: path.join(out, `${key}-loading.png`) });
                    }
                    await dialog.getByRole('button', { name: /^Review project change 1/ }).waitFor();
                    const loadedBox = fixture.historyDelayMs ? await checkOverviewGrowth(dialog, loadingBox, width, height, top) : await dialog.boundingBox();
                    checkNodePanelBounds(loadedBox, width, height, top);
                    if (!loadedBox || loadedBox.height >= height * 0.75)
                        throw new Error('The short Agent overview did not fit its content.');
                }
            }
            finally {
                context.model = model;
            }
        } },
    { stage: "verify", order: 21, visual: true, async run(context) {
            const { page, fixture, name, width, height, key, out, screenshots } = context;
            let { model } = context;
            try {
                if (fixture.slowDock) {
                    const dialog = page.getByRole('dialog');
                    const loading = dialog.getByRole('status').filter({ hasText: '正在加载…' });
                    await loading.waitFor();
                    const initial = await dialog.boundingBox();
                    if (screenshots)
                        await page.screenshot({ path: path.join(out, `${key}-loading.png`) });
                    const content = fixture.slowDock === 'accounts' ? dialog.getByRole('region', { name: 'Studio' })
                        : dialog.getByRole('button', { name: /Review the example change/ });
                    await content.waitFor();
                    await checkOverviewGrowth(dialog, initial, width, height, await page.evaluate(async () => (await import('/platform.ts')).isDesktop ? 48 : 20));
                    await loading.waitFor({ state: 'hidden' });
                }
            }
            finally {
                context.model = model;
            }
        } },
    { stage: "verify", order: 31, visual: true, async run(context) {
            const { page, fixture, name, key, root, out, screenshots } = context;
            let { model } = context;
            try {
                if (name === 'agent-panel-unread') {
                    // Regression: completed unread tasks were mixed into date groups instead of appearing between Running and Today.
                    const messages = JSON.parse(await readFile(path.join(root, 'ui/locales', `${fixture.language}.json`), 'utf8'));
                    const panel = page.getByRole('dialog', { name: 'Codex', exact: true });
                    const unread = panel.getByRole('region', { name: messages['agentPanel.unread'], exact: true });
                    const today = panel.getByRole('region', { name: messages['agentPanel.today'], exact: true });
                    await unread.waitFor({ state: 'visible' });
                    await today.waitFor({ state: 'visible' });
                    const sections = await panel.getByRole('region').evaluateAll(elements => elements.map(element => element.getAttribute('aria-label')));
                    const runningIndex = sections.indexOf(messages['agentPanel.running']);
                    if (runningIndex < 0 || sections[runningIndex + 1] !== messages['agentPanel.unread'] || sections[runningIndex + 2] !== messages['agentPanel.today'])
                        throw new Error('Unread is not between Running and Today');
                    const completed = fixture.tasks.filter(task => task.completed);
                    if (await unread.getByRole('button').count() !== completed.length)
                        throw new Error('Unread group count does not match observed unread completions');
                    if (screenshots)
                        await page.screenshot({ path: path.join(out, `${key}-unread.png`), animations: 'disabled' });
                    for (const task of completed) {
                        const name = new RegExp(`^${task.title} ·`);
                        if (await today.getByRole('button', { name }).count())
                            throw new Error('Unread task is duplicated in Today');
                        await unread.getByRole('button', { name }).click();
                        await page.getByRole('button', { name: messages.back, exact: true }).click();
                        await today.getByRole('button', { name }).waitFor({ state: 'visible' });
                        await unread.getByRole('button', { name }).waitFor({ state: 'hidden' });
                    }
                    await unread.waitFor({ state: 'hidden' });
                }
            }
            finally {
                context.model = model;
            }
        } },
    { stage: "afterCapture", order: 43, visual: true, async run(context) {
            const { page, name, width, height, key, out, screenshots } = context;
            let { model } = context;
            try {
                if (name === 'agent-panel-short') {
                    await page.keyboard.press('Escape');
                    await page.getByRole('dialog').waitFor({ state: 'hidden' });
                    await page.getByRole('button', { name: /^OpenCode:/i }).click();
                    const opened = page.getByRole('dialog', { name: 'OpenCode', exact: true });
                    await opened.getByRole('button', { name: /^Review project change 1/ }).waitFor();
                    checkNodePanelBounds(await opened.boundingBox(), width, height, await page.evaluate(async () => (await import('/platform.ts')).isDesktop ? 48 : 20));
                    if (screenshots)
                        await page.screenshot({ path: path.join(out, `${key}-clicked-node.png`) });
                }
            }
            finally {
                context.model = model;
            }
        } }
];
