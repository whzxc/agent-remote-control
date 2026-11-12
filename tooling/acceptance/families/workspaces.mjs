import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { verifyWorkspace } from '../workspaces.mjs';
export const checks = [
    { stage: "prepare", order: 6, visual: true, async run(context) {
            const { page, fixture, width, height, root } = context;
            let { model } = context;
            try {
                if (fixture.page || fixture.connectionsOpen || fixture.coordination) {
                    const messages = JSON.parse(await readFile(path.join(root, 'ui/locales', `${fixture.language}.json`), 'utf8'));
                    await verifyWorkspace(page, fixture, messages, width, height);
                }
            }
            finally {
                context.model = model;
            }
        } }
];
