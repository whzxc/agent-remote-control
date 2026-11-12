import path from 'node:path';
export const checks = [
    { stage: "verify", order: 36, visual: false, async run(context) {
            const { page, width, height, row, setup } = context;
            let { model } = context;
            try {
                if (setup) {
                    // Regression: a fixed 496px shell scrolled before using the available viewport height.
                    const layout = await page.getByRole('dialog', { includeHidden: true }).evaluateAll(dialogs => {
                        return dialogs.filter(dialog => dialog.querySelector('.setup-steps')).map(dialog => {
                            const rect = dialog.getBoundingClientRect(), body = dialog.querySelector('.dialog-body');
                            const viewportMargin = Number.parseFloat(getComputedStyle(dialog).getPropertyValue('--layer-side-margin'));
                            const tiles = [...dialog.querySelectorAll('.choice-tiles .choice-radio')].map(grid => [...grid.children].map(tile => {
                                const r = tile.getBoundingClientRect();
                                return { width: r.width, top: r.top };
                            }));
                            return { recessed: dialog.inert, stacked: !!dialog.querySelector('.setup-return'),
                                x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height,
                                growthRoom: innerHeight - viewportMargin - rect.bottom,
                                scroll: body.scrollHeight - body.clientHeight, horizontalScroll: body.scrollWidth - body.clientWidth, tiles };
                        });
                    });
                    row.layout = layout;
                    if (!layout.length)
                        throw new Error('Setup dialog was not rendered');
                    for (const dialog of layout.filter(d => !d.recessed)) {
                        if (dialog.x < 0 || dialog.y < 0 || dialog.right > width || dialog.bottom > height)
                            throw new Error('Setup dialog exceeds the viewport');
                        if (dialog.horizontalScroll > 1)
                            throw new Error('Setup content scrolls horizontally');
                        if (dialog.scroll > 1 && dialog.growthRoom > 1)
                            throw new Error(`Setup body scrolls by ${dialog.scroll}px with ${dialog.growthRoom}px of unused viewport height`);
                        for (const tiles of dialog.tiles) {
                            if (tiles.length >= 3 && (Math.abs(tiles[0].width - tiles[1].width) > 1 || Math.abs(tiles[1].width - tiles[2].width) > 1 || tiles[0].top !== tiles[2].top))
                                throw new Error('Platform grid is not three equal columns');
                        }
                        if (dialog.stacked && !layout.some(parent => parent.recessed && Math.abs(parent.x - dialog.x) <= 1
                            && Math.abs(parent.width - dialog.width) <= 1))
                            throw new Error('Stacked setup dialogs must share their horizontal slot and width');
                    }
                }
            }
            finally {
                context.model = model;
            }
        } }
];
