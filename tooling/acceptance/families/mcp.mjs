import { readFile } from 'node:fs/promises';
import path from 'node:path';
export const checks = [
    { stage: "verify", order: 39, visual: false, async run(context) {
            const { page, fixture, name, width, height, root } = context;
            let { model } = context;
            try {
                if (fixture.mcpHub === 'ready') {
                    // Regression: opening the MCP hub clipped its workspace to the content height; the width toggle then changed its height.
                    const messages = JSON.parse(await readFile(path.join(root, 'ui/locales', `${fixture.language}.json`), 'utf8'));
                    const hub = page.getByRole('region', { name: messages['mcp.title'], exact: true });
                    await hub.getByRole('searchbox').waitFor();
                    const initial = await hub.boundingBox();
                    await hub.getByRole('button', { name: messages.expandPanelWidth, exact: true }).click();
                    const restore = hub.getByRole('button', { name: messages.restorePanelWidth, exact: true });
                    await restore.waitFor();
                    const expanded = await hub.boundingBox();
                    if (!initial || !expanded || initial.height !== expanded.height)
                        throw new Error('MCP hub changes height when expanded');
                    await restore.click();
                }
            }
            finally {
                context.model = model;
            }
        } }
];
