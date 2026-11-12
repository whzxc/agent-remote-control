import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { escapeRegex } from './shared.mjs';
export const checks = [
    { stage: "prepare", order: 3, visual: true, async run(context) {
            const { page, fixture, name, root } = context;
            let { model } = context;
            try {
                if (fixture.accountAdd) {
                    const messages = JSON.parse(await readFile(path.join(root, 'ui/locales', `${fixture.language}.json`), 'utf8'));
                    await page.getByRole('button', { name: messages['accounts.addAgentAccount'], exact: true }).click();
                    const dialog = page.getByRole('dialog', { name: messages['accountAdd.title'], exact: true });
                    await dialog.waitFor();
                    if (fixture.accountAdd !== 'oauth')
                        await dialog.getByRole('radio', { name: messages['accountAdd.credentials'], exact: true }).click();
                    if (fixture.accountAdd === 'external')
                        await dialog.getByRole('radio', { name: messages['accountAdd.external'], exact: true }).click();
                }
            }
            finally {
                context.model = model;
            }
        } },
    { stage: "afterCapture", order: 44, visual: false, async run(context) {
            const { page, fixture, name, width, key, root } = context;
            let { model } = context;
            try {
                if (name.startsWith('agent-platform-') && width === 1280) {
                    // Regression: account management disappeared with zero or one account and quota failure looked like expired authorization.
                    const messages = JSON.parse(await readFile(path.join(root, 'ui/locales', `${fixture.language}.json`), 'utf8'));
                    const button = (target, key) => target.getByRole('button', { name: messages[key], exact: true });
                    const add = button(page, 'accounts.addAgentAccount');
                    const card = name => page.getByRole('region', { name, exact: true });
                    await add.waitFor();
                    if (name === 'agent-platform-empty')
                        await page.getByText(messages['accounts.empty'], { exact: true }).waitFor();
                    if (name === 'agent-platform-single') {
                        await button(card('Personal'), 'accounts.reauth').waitFor();
                        if (await button(card('Personal'), 'accounts.removeAction').count())
                            throw new Error('Native account is removable');
                    }
                    if (name === 'agent-platform-lifecycle') {
                        const team = card('Team'), personal = card('Personal'), studio = card('Studio');
                        await team.getByRole('meter').nth(1).waitFor();
                        if (await button(team, 'accounts.reauth').count() || await button(personal, 'accounts.reauth').count()) {
                            throw new Error('A signed-in account offered reauthentication');
                        }
                        await team.getByText('team@example.com', { exact: true }).waitFor();
                        await button(team, 'accounts.editAliasAction').click();
                        const edit = page.getByRole('dialog', { name: messages['accounts.editAliasAction'], exact: true });
                        await edit.getByRole('textbox', { name: messages['accounts.alias'], exact: true }).fill('Renamed Team');
                        await button(edit, 'save').click();
                        await card('Renamed Team').waitFor();
                        async function authorize(dialog, retryExpired = false) {
                            await dialog.getByRole('combobox', { name: messages['accountAdd.browser'], exact: true }).click();
                            await page.getByRole('option', { name: 'Google Chrome · Profile A', exact: true }).click();
                            await button(dialog, 'accountAdd.login').click();
                            await dialog.getByRole('status').filter({ hasText: 'Google Chrome · Profile A' }).waitFor();
                            const code = dialog.getByRole('textbox', { name: messages['accountAdd.authorizationCode'], exact: true });
                            if (retryExpired) {
                                await code.fill('fixture-expired-code');
                                await button(dialog, 'accountAdd.submitCode').click();
                                await dialog.getByText(messages['accountAdd.expired'], { exact: true }).waitFor();
                                await button(dialog, 'accountAdd.retry').click();
                            }
                            await code.fill('fixture-authorization-code');
                            await button(dialog, 'accountAdd.submitCode').click();
                            await dialog.waitFor({ state: 'hidden' });
                        }
                        await button(studio, 'accounts.reauth').click();
                        await authorize(page.getByRole('dialog', { name: messages['accountAdd.reauthTitle'].replace('{alias}', 'Studio'), exact: true }), true);
                        await studio.getByRole('meter').nth(1).waitFor();
                        if (await button(studio, 'accounts.reauth').count())
                            throw new Error('Reauthorized account still offers sign-in');
                        await add.click();
                        await authorize(page.getByRole('dialog', { name: messages['accountAdd.claudeTitle'], exact: true }));
                        const added = card('New Claude');
                        await added.waitFor();
                        await button(added, 'accounts.removeAction').click();
                        const remove = page.getByRole('dialog', { name: messages['accounts.removeTitle'].replace('{alias}', 'New Claude'), exact: true });
                        await button(remove, 'accounts.removeAction').click();
                        await added.waitFor({ state: 'hidden' });
                        await card('Renamed Team').waitFor();
                    }
                    const platform = name === 'agent-platform-single' ? 'Codex' : 'Claude Code';
                    const panel = page.getByRole('dialog', { name: platform, exact: true });
                    await button(panel, 'close').click();
                    await panel.waitFor({ state: 'hidden' });
                    await page.getByRole('button', { name: new RegExp(`^${escapeRegex(platform)}(?::|$)`) }).press('Enter');
                    await add.waitFor();
                }
            }
            finally {
                context.model = model;
            }
        } },
    { stage: "afterCapture", order: 45, visual: false, async run(context) {
            const { page, fixture, name, width, root } = context;
            let { model } = context;
            try {
                if (fixture.accountAdd && width === 1280) {
                    const messages = JSON.parse(await readFile(path.join(root, 'ui/locales', `${fixture.language}.json`), 'utf8'));
                    const dialog = page.getByRole('dialog', { name: messages['accountAdd.title'], exact: true });
                    if (fixture.accountAdd === 'oauth') {
                        await dialog.getByRole('button', { name: messages['accountAdd.login'], exact: true }).click();
                        await dialog.getByRole('status').waitFor();
                        await dialog.waitFor({ state: 'hidden', timeout: 10000 });
                    }
                    else {
                        await dialog.getByRole('button', { name: messages['accountAdd.import'], exact: true }).click();
                        const credentials = dialog.getByRole('textbox', { name: messages['accountAdd.auth'], exact: true });
                        await page.waitForFunction(node => document.activeElement === node && node.getAttribute('aria-invalid') === 'true', await credentials.elementHandle());
                        await credentials.fill(JSON.stringify({ tokens: { access_token: 'fixture-access', account_id: 'fixture-imported' } }));
                        if (fixture.accountAdd === 'external') {
                            await dialog.getByRole('textbox', { name: messages['accountAdd.program'], exact: true }).fill('/usr/bin/credential-manager');
                            await dialog.getByRole('textbox', { name: messages['accountAdd.args'], exact: true }).fill('["--account","fixture"]');
                        }
                        await dialog.getByRole('button', { name: messages['accountAdd.import'], exact: true }).click();
                        await dialog.waitFor({ state: 'hidden' });
                    }
                    await page.getByRole('button', { name: messages['accounts.addAgentAccount'], exact: true }).waitFor();
                }
            }
            finally {
                context.model = model;
            }
        } },
    { stage: "verify", order: 38, visual: false, async run(context) {
            const { page, fixture, name, root, setup } = context;
            let { model } = context;
            try {
                if (name === 'accounts') {
                    // Regression: the accounts fixture targeted retired UI and matched both hub and Platforms add-source buttons.
                    const messages = JSON.parse(await readFile(path.join(root, 'ui/locales', `${fixture.language}.json`), 'utf8'));
                    const platforms = page.getByRole('region', { name: messages['platforms.title'], exact: true });
                    await platforms.getByRole('heading', { name: messages['platforms.title'], exact: true }).waitFor({ state: 'visible' });
                    const source = await page.evaluate(async () => {
                        // Vite serves ui/ at the browser root.
                        const { scenarioResponse } = await import('/scenarios.ts');
                        const { controlSource } = await import('/controlSources.ts');
                        const source = scenarioResponse('source', 'GET').sources.find(source => source.product === 'chatgpt');
                        if (!source?.authorizationFacts?.email)
                            throw new Error('Account fixture is missing its connected source identity');
                        return { label: source.label, email: source.authorizationFacts.email, productName: controlSource(source.product).displayName };
                    });
                    const card = platforms.getByRole('region', { name: source.label, exact: true });
                    await card.getByRole('heading', { name: source.label, exact: true }).waitFor({ state: 'visible' });
                    // Regression: AX-26 copying a selection spanning an ordinary label and masked identity discarded the label.
                    // Sensitive preserves @ in email stand-ins and labels its outer span with accounts.hidden.
                    const identity = card.getByRole('definition').filter({ hasText: /@/ }).getByLabel(messages['accounts.hidden'], { exact: true });
                    const standIn = await identity.innerText();
                    if (!standIn || standIn === source.email)
                        throw new Error('Account identity is not privacy-masked');
                    const copied = await page.evaluate(({ label, identity }) => {
                        const selection = window.getSelection(), range = document.createRange();
                        range.setStartBefore(label);
                        range.setEndAfter(identity);
                        selection.removeAllRanges();
                        selection.addRange(range);
                        try {
                            const selected = selection.toString(), clipboard = new DataTransfer();
                            clipboard.setData('text/plain', selected);
                            const event = new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: clipboard });
                            identity.dispatchEvent(event);
                            return { selected, text: clipboard.getData('text/plain'), handled: event.defaultPrevented };
                        }
                        finally {
                            selection.removeAllRanges();
                        }
                    }, { label: await card.getByText(messages['platforms.email'], { exact: true }).elementHandle(), identity: await identity.elementHandle() });
                    if (!copied.selected.includes(messages['platforms.email']) || !copied.selected.includes(standIn))
                        throw new Error('Copy selection does not span ordinary text and the masked identity');
                    if (!copied.handled || !copied.text.includes(messages['platforms.email']) || !copied.text.includes(source.email) || copied.text.includes(standIn))
                        throw new Error('Mixed account copy lost ordinary text or failed to restore the real fixture identity');
                    await card.getByRole('button', { name: messages['platforms.rename'].replace('{name}', source.label), exact: true }).click();
                    const renamed = `${source.label} fixture`;
                    await card.getByRole('textbox', { name: messages['platforms.name'], exact: true }).fill(renamed);
                    await page.getByRole('button', { name: messages.settings, exact: true }).click();
                    const keepEditing = platforms.getByRole('button', { name: messages['layers.keepEditing'], exact: true });
                    await keepEditing.waitFor();
                    if (!await keepEditing.evaluate(element => element === document.activeElement))
                        throw new Error('Dirty workspace switching must focus Keep editing.');
                    await keepEditing.click();
                    if (await card.getByRole('textbox', { name: messages['platforms.name'], exact: true }).inputValue() !== renamed)
                        throw new Error('Workspace switching discarded the connector draft.');
                    await card.getByRole('button', { name: messages.save, exact: true }).click();
                    await platforms.getByRole('region', { name: renamed, exact: true }).getByRole('heading', { name: renamed, exact: true }).waitFor({ state: 'visible' });
                    await platforms.getByRole('button', { name: messages.addControlSource, exact: true }).click();
                    const addProduct = messages['setup.addProduct'].replace('{name}', source.productName);
                    const menu = page.getByRole('menu', { name: messages.addControlSource, exact: true });
                    await menu.getByRole('menuitem', { name: addProduct, exact: true }).click();
                    const dialog = page.getByRole('dialog', { name: addProduct, exact: true });
                    await dialog.waitFor({ state: 'visible' });
                    await page.keyboard.press('Escape');
                    await dialog.waitFor({ state: 'hidden' });
                }
            }
            finally {
                context.model = model;
            }
        } }
];
