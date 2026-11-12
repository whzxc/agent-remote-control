import { readFile } from 'node:fs/promises';
import path from 'node:path';
export const checks = [
    { stage: "verify", order: 24, visual: true, async run(context) {
            const { page, fixture, name, root } = context;
            let { model } = context;
            try {
                if (fixture.studio && !fixture.coordination) {
                    // Regression: changing studio lighting must not replace the saved application theme.
                    const messages = JSON.parse(await readFile(path.join(root, 'ui/locales', `${fixture.language}.json`), 'utf8'));
                    const settings = page.getByRole('button', { name: messages['studio.settings'], exact: true });
                    await page.getByLabel(messages['studio.clock'], { exact: true }).waitFor({ state: 'visible' });
                    await settings.click();
                    const phase = fixture.studio === 'night' ? 'day' : 'night';
                    await page.getByRole('radio', { name: messages[`studio.${phase}`], exact: true }).click();
                    await page.waitForFunction(expected => window.__ARC_VIEW_MODEL__().theme === expected, phase === 'day' ? 'light' : 'dark');
                    await page.keyboard.press('Escape');
                    await page.getByRole('button', { name: messages.settings, exact: true }).click();
                    await page.getByRole('button', { name: messages['topology.experimental'], exact: true }).click();
                    const enabled = page.getByRole('switch', { name: messages['studio.enabled'], exact: true });
                    await enabled.click();
                    await page.waitForFunction(expected => window.__ARC_VIEW_MODEL__().theme === expected, fixture.theme);
                    await enabled.click();
                    await page.getByRole('button', { name: messages.backToHome, exact: true }).click();
                    await settings.click();
                    await page.getByRole('radio', { name: messages[`studio.${fixture.studio}`], exact: true }).click();
                    await page.keyboard.press('Escape');
                    await settings.waitFor({ state: 'visible' });
                }
            }
            finally {
                context.model = model;
            }
        } },
    { stage: "verify", order: 25, visual: false, async run(context) {
            const { page, fixture, name, root } = context;
            let { model } = context;
            try {
                if (name === 'studio-no-connections') {
                    // Regression: a remote check failure without any configured connection hid the add-connection entry.
                    const messages = JSON.parse(await readFile(path.join(root, 'ui/locales', `${fixture.language}.json`), 'utf8'));
                    await page.getByRole('img', { name: messages['hub.remoteHealthy'], exact: true }).waitFor();
                    await page.getByRole('button', { name: messages['hub.viewConnections'], exact: true }).press('Enter');
                    const connections = page.getByRole('dialog', { name: messages['connections.title'], exact: true });
                    await connections.getByRole('button', { name: messages['source.newConnection'], exact: true }).click();
                    const setup = page.getByRole('dialog', { name: messages['source.newConnection'], exact: true });
                    await setup.waitFor();
                    await page.keyboard.press('Escape');
                    await setup.waitFor({ state: 'hidden' });
                    await connections.waitFor();
                    await page.keyboard.press('Escape');
                    await connections.waitFor({ state: 'hidden' });
                }
            }
            finally {
                context.model = model;
            }
        } },
    { stage: "verify", order: 26, visual: true, async run(context) {
            const { page, fixture, name, width, height, key, root, out, screenshots } = context;
            let { model } = context;
            try {
                if (['studio-connections', 'studio-stopped', 'studio-unavailable'].includes(name)) {
                    // Regression: an unavailable local client made the remote arc partial and the mark coupled two lifecycles.
                    const messages = JSON.parse(await readFile(path.join(root, 'ui/locales', `${fixture.language}.json`), 'utf8'));
                    const button = key => page.getByRole('button', { name: messages[key], exact: true });
                    const arc = key => page.getByRole('img', { name: messages[key], exact: true });
                    const dialog = key => page.getByRole('dialog', { name: messages[key], exact: true });
                    if (name === 'studio-connections') {
                        await arc('hub.coreHealthy').waitFor();
                        await arc('hub.remoteUnavailable').waitFor();
                        const coreArcPoint = await arc('hub.coreHealthy').evaluate(svg => {
                            const point = new DOMPoint(50, 82).matrixTransform(svg.getScreenCTM());
                            return { x: point.x, y: point.y };
                        });
                        await page.mouse.click(coreArcPoint.x, coreArcPoint.y);
                        await arc('hub.coreHealthy').waitFor();
                        if (await page.getByRole('dialog').count())
                            throw new Error('The status arc activated an operation');
                        // Regression: the recovery action displaced Connections while a remote connection was unavailable.
                        const remotePoint = await arc('hub.remoteUnavailable').evaluate(svg => {
                            const point = new DOMPoint(50, 18).matrixTransform(svg.getScreenCTM());
                            return { x: point.x, y: point.y };
                        });
                        await page.mouse.move(remotePoint.x, remotePoint.y);
                        const connectionsBounds = await button('hub.viewConnections').boundingBox();
                        const connectionsCenter = { x: connectionsBounds.x + connectionsBounds.width / 2, y: connectionsBounds.y + connectionsBounds.height / 2 };
                        await page.mouse.move(connectionsCenter.x, connectionsCenter.y, { steps: 8 });
                        if (screenshots)
                            await page.screenshot({ path: path.join(out, `${key}-remote-actions.png`) });
                        await page.mouse.click(connectionsCenter.x, connectionsCenter.y);
                        await dialog('connections.title').getByRole('button', { name: messages['source.newConnection'] }).waitFor();
                        await page.keyboard.press('Escape');
                        await dialog('connections.title').waitFor({ state: 'hidden' });
                        await button('hub.remoteRecovery').press('Enter');
                        await dialog('hub.remoteRecoveryTitle').waitFor();
                        if (screenshots)
                            await page.screenshot({ path: path.join(out, `${key}-remote-recovery.png`) });
                        await dialog('hub.remoteRecoveryTitle').getByRole('button', { name: messages['hub.restartConnection'] }).click();
                        await dialog('hub.remoteRecoveryTitle').waitFor({ state: 'hidden' });
                        await arc('hub.remoteHealthy').waitFor();
                        await arc('hub.coreHealthy').waitFor();
                        await button('hub.viewConnections').press('Enter');
                        await dialog('connections.title').waitFor();
                        await page.keyboard.press('Escape');
                        await dialog('connections.title').waitFor({ state: 'hidden' });
                        const corePoint = await arc('hub.coreHealthy').evaluate(svg => {
                            const point = new DOMPoint(50, 82).matrixTransform(svg.getScreenCTM());
                            return { x: point.x, y: point.y };
                        });
                        await page.mouse.move(corePoint.x, corePoint.y);
                        const stopBounds = await button('hub.stopCore').boundingBox();
                        await page.mouse.move(stopBounds.x + stopBounds.width / 2, stopBounds.y + stopBounds.height / 2, { steps: 8 });
                        if (screenshots)
                            await page.screenshot({ path: path.join(out, `${key}-core-hover.png`) });
                        await page.mouse.click(stopBounds.x + stopBounds.width / 2, stopBounds.y + stopBounds.height / 2);
                        await arc('hub.coreStopped').waitFor();
                        await arc('hub.remoteUnavailable').waitFor();
                        await button('hub.remoteRecovery').press('Enter');
                        await dialog('hub.remoteRecoveryTitle').getByRole('button', { name: messages['hub.openCoreRecovery'] }).click();
                    }
                    else {
                        await arc('hub.remoteHealthy').waitFor();
                        await button('hub.coreRecovery').press('Enter');
                    }
                    await dialog('hub.coreRecoveryTitle').waitFor();
                    if (screenshots)
                        await page.screenshot({ path: path.join(out, `${key}-core-recovery.png`) });
                    await dialog('hub.coreRecoveryTitle').getByRole('button', {
                        name: messages[name === 'studio-unavailable' ? 'hub.restartCore' : 'hub.startCore'],
                    }).click();
                    await dialog('hub.coreRecoveryTitle').waitFor({ state: 'hidden' });
                    await arc('hub.coreHealthy').waitFor();
                    await arc('hub.remoteHealthy').waitFor();
                }
            }
            finally {
                context.model = model;
            }
        } }
];
export const bothThemes = fixture => !!fixture.studio;
