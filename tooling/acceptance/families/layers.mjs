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
export const checks = [
    { stage: "afterCapture", order: 47, visual: false, async run(context) {
            const { page, fixture, height, row } = context;
            let { model } = context;
            try {
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
