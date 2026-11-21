async function setMotion(page, reduced) {
    await page.evaluate(async value => {
        const { setScenarioReducedMotion } = await import('/scenarios.ts');
        const { refreshAppEnvironment } = await import('/state/appEnvironment.ts');
        setScenarioReducedMotion(value);
        await refreshAppEnvironment();
    }, reduced);
    await page.waitForFunction(value => document.documentElement.dataset.reducedMotion === String(value), reduced);
}

async function interruptLayerMotion(page) {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await setMotion(page, false);
    await page.evaluate(() => {
        const capsule = document.createElement('span'), card = document.createElement('article');
        capsule.className = 'node-capsule-disc';
        capsule.dataset.phase = 'running';
        card.className = 'task-card';
        card.dataset.aurora = 'command';
        document.body.append(capsule, card);
        const root = document.documentElement;
        try {
            if (getComputedStyle(capsule).animationName !== 'capsule-pulse' || getComputedStyle(card).animationName !== 'task-aurora')
                throw new Error('System reduction overrode explicit normal motion on a running indicator.');
            delete root.dataset.reducedMotion;
            if (getComputedStyle(capsule).animationName !== 'none')
                throw new Error('The capsule animated before the reduced-motion setting initialized.');
        } finally {
            root.dataset.reducedMotion = 'false';
            capsule.remove();
            card.remove();
        }
        // Lengthen the production tokens so even a slow browser can interrupt a live transition.
        for (const token of ['fast', 'panel']) document.documentElement.style.setProperty('--motion-' + token, '4s');
    });
    const panel = page.locator('.layer-panel');
    await page.keyboard.press('Escape');
    await page.locator('.layer-panel[data-exiting]').waitFor();
    await setMotion(page, true);
    await panel.waitFor({ state: 'hidden', timeout: 1200 });

    await setMotion(page, false);
    await page.locator('[data-page="settings"]').click();
    await page.locator('.layer-panel[data-layer-entering]').waitFor();
    await setMotion(page, true);
    await page.waitForFunction(() => {
        const node = document.querySelector('.layer-panel');
        return node && !node.hasAttribute('data-layer-entering') && getComputedStyle(node).opacity === '1';
    }, null, { timeout: 1200 });
    await setMotion(page, false);
    if (await panel.getAttribute('data-layer-entering') !== null || await panel.evaluate(node => getComputedStyle(node).opacity) !== '1')
        throw new Error('Restoring normal motion replayed entry on the open panel.');

    await panel.locator('#settings-experimental-entry').click();
    const body = panel.locator('.dialog-body');
    await page.waitForFunction(node => Number(getComputedStyle(node).opacity) < 0.99, await body.elementHandle(), { timeout: 1200 });
    await setMotion(page, true);
    await page.waitForFunction(() => [...document.querySelectorAll('.layer-panel :is(.dialog-header,.dialog-body)')]
        .every(node => getComputedStyle(node).opacity === '1'), null, { timeout: 1200 });
}
// Recurring bug class: lifecycle of retained content during replacement and interruption.
async function verifyPanelCrossfade(page) {
    await setMotion(page, false);
    const panel = page.locator('.layer-panel');
    const origin = await panel.boundingBox();
    const stylesheet = '/layer-fixture/assets/panel.css';
    let stylesheetRequests = 0;
    await page.route('**' + stylesheet, route => {
        stylesheetRequests++;
        return route.fulfill({ contentType: 'text/css', body: `
            arc-paint-probe { outline-offset: 7px; }
            arc-paint-probe::before { background-image: url(./marker.svg); }` });
    });
    await page.addStyleTag({ url: stylesheet });
    await page.evaluate(() => {
        window.panelPaintSamples = [];
        customElements.define('arc-paint-probe', class extends HTMLElement {
            connectedCallback() {
                // Sample the actual outgoing subtree at insertion, before a later frame can hide a late sheet.
                if (this.getRootNode() instanceof ShadowRoot) window.panelPaintSamples.push({
                    offset: getComputedStyle(this).outlineOffset,
                    image: getComputedStyle(this, '::before').backgroundImage,
                });
            }
        });
    });
    const markOutgoing = () => panel.locator('.dialog-body').evaluate(body => body.append(document.createElement('arc-paint-probe')));
    await page.evaluate(() => {
        // Stretch both production clocks to make the interior of the fade observable.
        document.documentElement.style.setProperty('--motion-fast', '2s');
        document.documentElement.style.setProperty('--motion-base', '2s');
    });
    const sample = async () => {
        const handle = await page.waitForFunction(() => {
            const shell = document.querySelector('.layer-panel');
            const old = shell.querySelector('.panel-outgoing');
            const header = shell.querySelector('.dialog-header');
            const body = shell.querySelector('.dialog-body');
            if (!old || !header || !body) return false;
            const alpha = element => Number(getComputedStyle(element).opacity);
            const [outgoing, incoming, bodyOpacity] = [old, header, body].map(alpha);
            if ([outgoing, incoming, bodyOpacity].some(value => value <= 0 || value >= 1)) return false;
            const { width, height, y } = shell.getBoundingClientRect();
            return { outgoing, incoming, bodyOpacity, center: y + height / 2, width, height,
                paints: shell.querySelectorAll('.panel-outgoing').length, inert: old.inert };
        });
        const reading = await handle.jsonValue();
        await handle.dispose();
        if (reading.paints !== 1 || !reading.inert || Math.abs(reading.outgoing + reading.incoming - 1) > 0.04
            || Math.abs(reading.incoming - reading.bodyOpacity) > 0.04 || Math.abs(reading.width - origin.width) > 1
            || Math.abs(reading.center - origin.y - origin.height / 2) > 1)
            throw new Error('Panel replacement lost its shared opacity clock or centered shell: ' + JSON.stringify(reading));
        return reading;
    };
    try {
        const settings = page.locator('[data-page="settings"]'), hosting = page.locator('[data-page="relay-hosting"]');
        await markOutgoing();
        await settings.click();
        await panel.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
        const first = await sample();
        await markOutgoing();
        await hosting.click();
        await panel.getByRole('heading', { name: 'Relay hosting', exact: true }).waitFor();
        const interrupted = await sample();
        const firstPaint = await page.evaluate(() => window.panelPaintSamples);
        const image = new URL('./marker.svg', new URL(stylesheet, page.url())).href;
        if (stylesheetRequests !== 1 || firstPaint.length !== 2
            || firstPaint.some(paint => paint.offset !== '7px' || paint.image !== `url("${image}")`))
            throw new Error('Outgoing linked stylesheet at insertion: ' + JSON.stringify({ firstPaint, stylesheetRequests }));
        await setMotion(page, true);
        await page.waitForFunction(() => !document.querySelector('.panel-outgoing'));
        await page.evaluate(() => {
            window.panelFocusCommits = [];
            document.addEventListener('focusin', event => {
                const shell = event.target.closest('.layer-panel');
                if (shell) window.panelFocusCommits.push(shell.getAttribute('aria-labelledby'));
            });
        });
        await settings.click();
        await panel.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const instant = await panel.evaluate(shell => ({
            focused: shell === document.activeElement, commits: window.panelFocusCommits.length,
            outgoing: !!shell.querySelector('.panel-outgoing'),
            opacity: getComputedStyle(shell.querySelector('.dialog-body')).opacity,
            height: shell.getBoundingClientRect().height, targetHeight: Number(shell.dataset.layerFrameHeight)
        }));
        if (!instant.focused || instant.commits !== 1 || instant.outgoing || instant.opacity !== '1'
            || Math.abs(instant.height - instant.targetHeight) > 1 || !(first.height > origin.height && first.height < instant.height))
            throw new Error('Reduced replacement or centered resize failed: ' + JSON.stringify({first, instant}));
        return { first, interrupted, instant, firstPaint, stylesheetRequests };
    } finally {
        await page.evaluate(() => {
            document.documentElement.style.removeProperty('--motion-fast');
            document.documentElement.style.removeProperty('--motion-base');
        });
    }
}
export const checks = [
    { stage: "afterCapture", order: 47, visual: false, async run(context) {
            const { page, fixture, height, row } = context;
            let { model } = context;
            try {
                if (context.name === 'relay-hosting-light' && context.width === 1280 && context.behavior)
                    row.panelCrossfade = await verifyPanelCrossfade(page);
                if (fixture.layerEntryCheck) {
                    const samples = await page.evaluate(() => window.__layerEntrySamples);
                    const entry = samples.filter(row => row.entering);
                    if (new Set(entry.map(row => row.targetHeight)).size < 2)
                        throw new Error('Entry fixture did not receive content during its fade.');
                    if (entry.some(row => Math.abs(row.y - row.targetY) > 1 || Math.abs(row.height - row.targetHeight) > 1))
                        throw new Error('Layer geometry interpolated during its entry fade.');
                    if (samples.at(-1).entering)
                        throw new Error('Entry geometry gate did not finish with the fade.');
                    row.layerEntry = { samples: samples.length, entrySamples: entry.length };
                    await interruptLayerMotion(page);
                }
            }
            finally {
                context.model = model;
            }
        } },
    { stage: "beforeNavigate", order: -1, visual: false, async run(context) {
            const { page, fixture, height } = context;
            let { model } = context;
            try {
                if (fixture.layerEntryCheck)
                    await page.addInitScript(() => {
                        // Regression: opening layers interpolated their initial centered top from the unmeasured position.
                        window.__layerEntrySamples = new Promise(resolve => {
                            const rows = [];
                            let start;
                            const sample = now => {
                                const node = document.querySelector('.layer-panel');
                                if (node && getComputedStyle(node).visibility !== 'hidden') {
                                    start ??= now;
                                    const rect = node.getBoundingClientRect();
                                    rows.push({ entering: node.hasAttribute('data-layer-entering'), y: rect.y, height: rect.height,
                                        targetY: Number(node.dataset.layerFrameTop), targetHeight: Number(node.dataset.layerFrameHeight) });
                                    if (now - start >= 600) {
                                        resolve(rows);
                                        return;
                                    }
                                }
                                requestAnimationFrame(sample);
                            };
                            requestAnimationFrame(sample);
                        });
                    });
            }
            finally {
                context.model = model;
            }
        } }
];
