import path from 'node:path';
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
