import { readFile } from 'node:fs/promises';
import path from 'node:path';
export const checks = [
    { stage: "verify", order: 10, visual: false, async run(context) {
            const { page, fixture, name, width, height, root } = context;
            let { model } = context;
            try {
                if (name.startsWith('request-sheet-')) {
                    const messages = JSON.parse(await readFile(path.join(root, 'ui/locales', `${fixture.language}.json`), 'utf8'));
                    const entry = page.getByRole('button', { name: messages['detail.openRequest'], exact: true });
                    await entry.click();
                    const dialog = page.getByRole('dialog', { name: messages['detail.needsYou'], exact: true });
                    await dialog.waitFor();
                    const bounds = await dialog.boundingBox();
                    if (!bounds || Math.abs(bounds.x - 16) > 1 || Math.abs(bounds.width - (width - 32)) > 1
                        || Math.abs(bounds.y + bounds.height / 2 - (20 + height - 16) / 2) > 1 || bounds.y + bounds.height > height - 15) {
                        throw new Error('Narrow requests must use the capped portrait dialog slot.');
                    }
                    if (fixture.tasks[fixture.detailTask].question === true) {
                        await dialog.getByRole('radio', { name: /Alpha/ }).click();
                        await page.keyboard.press('Escape');
                        const keepEditing = dialog.getByRole('button', { name: messages['layers.keepEditing'], exact: true });
                        await keepEditing.waitFor();
                        if (!await keepEditing.evaluate(element => element === document.activeElement))
                            throw new Error('The safe dismissal action did not receive focus.');
                        await keepEditing.click();
                        if (!await dialog.getByRole('radio', { name: /Alpha/ }).isChecked())
                            throw new Error('The answer draft was lost.');
                    }
                    else {
                        await dialog.getByRole('button', { name: messages['detail.approve'], exact: true }).waitFor();
                    }
                    await dialog.getByRole('button', { name: messages.close, exact: true }).click();
                    await dialog.waitFor({ state: 'hidden' });
                    await page.waitForFunction(element => element === document.activeElement, await entry.elementHandle(), { timeout: 3000 });
                    await entry.click();
                    await dialog.waitFor();
                    if (fixture.tasks[fixture.detailTask].question === true && !await dialog.getByRole('radio', { name: /Alpha/ }).isChecked())
                        throw new Error('Reopening the request lost its draft.');
                    await dialog.getByRole('button', { name: messages.close, exact: true }).click();
                    await dialog.waitFor({ state: 'hidden' });
                }
            }
            finally {
                context.model = model;
            }
        } }
];
