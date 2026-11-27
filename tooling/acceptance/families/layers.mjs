async function setMotion(page, reduced) {
    await page.evaluate(async value => {
        const { setScenarioReducedMotion } = await import('/scenarios.ts');
        const { refreshAppEnvironment } = await import('/state/appEnvironment.ts');
        setScenarioReducedMotion(value);
        await refreshAppEnvironment();
    }, reduced);
    await page.waitForFunction(value => document.documentElement.dataset.reducedMotion === String(value), reduced);
}

async function verifyReducedMotionAndFocus(page) {
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
    });
    const panel = page.locator('.layer-panel');
    await setMotion(page, true);
    await page.keyboard.press('Escape');
    await panel.waitFor({ state: 'hidden', timeout: 1200 });
    await page.locator('[data-page="settings"]').click();
    await panel.waitFor({ state: 'visible', timeout: 1200 });
    await page.locator('[data-page="relay-hosting"]').click();
    await panel.getByRole('heading', { name: 'Relay hosting', exact: true }).waitFor();
}

export const checks = [
    { stage: "afterCapture", order: 47, visual: false, async run(context) {
            const { page, fixture, row } = context;
            let { model } = context;
            try {
                if (fixture.layerEntryCheck || (context.name === 'relay-hosting-light' && context.width === 1280 && context.behavior)) {
                    await verifyReducedMotionAndFocus(page);
                    row.layerShell = { verified: true };
                }
            }
            finally {
                context.model = model;
            }
        } }
];
