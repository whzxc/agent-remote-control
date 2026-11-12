import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chooseSpec, escapeRegex } from './shared.mjs';
export const checks = [
    { stage: "verify", order: 27, visual: false, async run(context) {
            const { page, fixture, name, root } = context;
            let { model } = context;
            try {
                if (name === 'antigravity-task') {
                    // Regression: Antigravity replies and denied actions disappeared from completed task details.
                    const messages = JSON.parse(await readFile(path.join(root, 'ui/locales', `${fixture.language}.json`), 'utf8'));
                    const task = fixture.tasks[0];
                    const panel = page.getByRole('dialog', { name: task.title, exact: true });
                    await panel.getByRole('status').filter({ hasText: messages['detail.state.done'] }).waitFor();
                    await panel.getByText(task.entries.find(entry => entry.phase === 'final_answer').text, { exact: true }).waitFor();
                    await panel.getByRole('button', { name: new RegExp(`^${escapeRegex(messages['detail.process'].split('{')[0])}`) }).click();
                    for (const entry of task.entries.filter(entry => entry.type === 'error')) {
                        await panel.getByText(entry.text, { exact: true }).waitFor();
                    }
                    await panel.getByRole('status').filter({ hasText: messages['detail.state.done'] }).waitFor();
                }
            }
            finally {
                context.model = model;
            }
        } },
    { stage: "verify", order: 28, visual: true, async run(context) {
            const { page, fixture, name, key, root, out, screenshots } = context;
            let { model } = context;
            try {
                if (name === 'task-states' || name === 'task-review-unavailable' || name === 'dispatch-states') {
                    // Regression: activity disappearance and unrelated review failures changed execution results.
                    const messages = JSON.parse(await readFile(path.join(root, 'ui/locales', `${fixture.language}.json`), 'utf8'));
                    if (name === 'task-review-unavailable') {
                        const panel = page.getByRole('dialog', { name: fixture.tasks[0].title, exact: true });
                        await panel.getByRole('status').filter({ hasText: messages['detail.state.done'] }).waitFor();
                        const reviewFailure = panel.getByRole('alert');
                        await reviewFailure.waitFor();
                        if (!(await reviewFailure.innerText()).includes(messages['detail.reviewUnavailable']))
                            throw new Error('Review read failure was not reported');
                        await reviewFailure.getByRole('button', { name: messages.retry, exact: true }).click();
                        await reviewFailure.waitFor();
                        await reviewFailure.getByRole('button', { name: messages.retry, exact: true }).waitFor();
                        await panel.getByRole('status').filter({ hasText: messages['detail.state.done'] }).waitFor();
                        const view = await page.evaluate(() => window.__ARC_VIEW_MODEL__());
                        if (view.taskDetail?.state && view.taskDetail.state !== 'done')
                            throw new Error('Review availability changed execution state');
                    }
                    if (name === 'task-states') {
                        const panel = page.getByRole('dialog', { name: 'Codex', exact: true });
                        const expected = ['running', 'needsYou', 'done', 'failed', 'interrupted', 'unknown'];
                        for (const [index, state] of expected.entries()) {
                            const button = panel.getByRole('button', { name: new RegExp(`^${fixture.tasks[index].title} ·`) });
                            await button.waitFor();
                            if (!await button.getByText(messages[`detail.state.${state}`], { exact: true }).count() && state !== 'running')
                                throw new Error(`Missing ${state} execution state`);
                        }
                    }
                    if (name === 'dispatch-states') {
                        const source = page.getByRole('dialog', { name: 'Claude', exact: true });
                        const heading = source.getByRole('banner').getByRole('heading', { name: 'Claude', exact: true });
                        const earlier = source.getByRole('button', { name: /Earlier completed dispatch/ });
                        await earlier.getByText(messages['detail.state.done'], { exact: true }).waitFor();
                        await page.getByRole('button', { name: /Current running dispatch/ }).getByText(messages['detail.state.running'], { exact: true }).waitFor();
                        await page.getByRole('button', { name: /Submission awaiting-approval/ }).getByText(messages['sourcePanel.awaitingApproval'], { exact: true }).waitFor();
                        await page.getByRole('button', { name: /Submission reserved/ }).getByText(messages['sourcePanel.submitting'], { exact: true }).waitFor();
                        const top = await heading.boundingBox();
                        await earlier.scrollIntoViewIfNeeded();
                        const after = await heading.boundingBox();
                        if (!top || !after || Math.abs(top.y - after.y) > 1)
                            throw new Error('The source header moved while scrolling dispatch history.');
                        await earlier.click();
                        await page.getByRole('status').filter({ hasText: messages['detail.state.done'] }).waitFor();
                        await page.getByText(messages['detail.selectedTurn'].replace('{count}', '1'), { exact: true }).waitFor();
                    }
                    if (screenshots)
                        await page.screenshot({ path: path.join(out, `${key}-states.png`), animations: 'disabled' });
                }
            }
            finally {
                context.model = model;
            }
        } },
    { stage: "verify", order: 29, visual: false, async run(context) {
            const { page, fixture, name, row } = context;
            let { model } = context;
            try {
                if (fixture.metadataOnlyHistory) {
                    // Regression: opening and paging history prefetched one full timeline per row and stalled list rendering.
                    const started = performance.now();
                    for (const count of [20, 40, 60]) {
                        const row = page.getByRole('button', { name: new RegExp(`^Review project change ${count} ·`) });
                        await row.waitFor();
                        await row.scrollIntoViewIfNeeded();
                    }
                    row.historyPaginationMs = Math.round(performance.now() - started);
                    await page.getByRole('button', { name: /^Review project change 1 ·/ }).scrollIntoViewIfNeeded();
                }
            }
            finally {
                context.model = model;
            }
        } },
    { stage: "verify", order: 30, visual: false, async run(context) {
            const { page, fixture, name, root } = context;
            let { model } = context;
            try {
                if (name === 'dispatch-spec') {
                    const [three, five, historical] = fixture.tasks.map(task => page.getByRole('group', { name: task.title, exact: true }));
                    const messages = JSON.parse(await readFile(path.join(root, 'ui/locales', `${fixture.language}.json`), 'utf8'));
                    await three.getByRole('img', { name: new RegExp(`Example Three.*${messages['dispatchSpec.effort.medium']}.*${messages['activity.fast']}`) }).waitFor();
                    await five.getByRole('img', { name: new RegExp(`Example Five.*${messages['dispatchSpec.effort.high']}`) }).waitFor();
                    if (await five.getByRole('img', { name: new RegExp(messages['activity.fast']) }).count())
                        throw new Error('Default service tier displayed Fast');
                    await historical.getByText(fixture.tasks[2].spec.effort, { exact: true }).waitFor();
                }
            }
            finally {
                context.model = model;
            }
        } },
    { stage: "verify", order: 32, visual: true, async run(context) {
            const { page, fixture, name, key, root, out, screenshots } = context;
            let { model } = context;
            try {
                if (name === 'task-queue-overflow') {
                    // Regression: overflow hid running tasks, and View all opened the Agent panel instead of temporarily revealing the queue.
                    const messages = JSON.parse(await readFile(path.join(root, 'ui/locales', `${fixture.language}.json`), 'utf8'));
                    const summary = page.getByRole('button', { name: new RegExp(`${messages['activity.viewAll']}$`) });
                    const taskButton = task => page.getByRole('button', { name: new RegExp(`^${task.title} ·`) });
                    for (const task of fixture.tasks.filter(task => !task.completed)) {
                        if (!await taskButton(task).isVisible())
                            throw new Error('Overflow hid unfinished work behind completed tasks');
                    }
                    await summary.click();
                    for (const task of fixture.tasks)
                        await taskButton(task).waitFor({ state: 'visible' });
                    const expanded = await page.evaluate(() => window.__ARC_VIEW_MODEL__());
                    if (expanded.panels.agent || expanded.panels.source || await page.getByRole('dialog').count())
                        throw new Error('View all opened a detail panel');
                    if (screenshots)
                        await page.screenshot({ path: path.join(out, `${key}-expanded.png`), animations: 'disabled' });
                    await page.keyboard.press('Escape');
                    await summary.waitFor({ state: 'visible' });
                    await taskButton(fixture.tasks[1]).waitFor({ state: 'hidden' });
                    if (!await summary.evaluate(element => element === document.activeElement))
                        throw new Error('Escape did not restore overflow trigger focus');
                    await summary.press('Enter');
                    for (const task of fixture.tasks)
                        await taskButton(task).waitFor({ state: 'visible' });
                    if (!await taskButton(fixture.tasks[1]).evaluate(element => element === document.activeElement))
                        throw new Error('Keyboard expansion did not focus a revealed task');
                    await page.getByRole('main').click({ position: { x: 1, y: 1 } });
                    await summary.waitFor({ state: 'visible' });
                    await taskButton(fixture.tasks[1]).waitFor({ state: 'hidden' });
                }
            }
            finally {
                context.model = model;
            }
        } },
    { stage: "verify", order: 33, visual: true, async run(context) {
            const { page, fixture, key, root, out, screenshots } = context;
            let { model } = context;
            try {
                if (fixture.taskRelationships) {
                    const { verifyTaskRelationships } = await import('../task-relationships.mjs');
                    const messages = JSON.parse(await readFile(path.join(root, 'ui/locales', `${fixture.language}.json`), 'utf8'));
                    await verifyTaskRelationships(page, fixture, messages, out, key, screenshots);
                }
            }
            finally {
                context.model = model;
            }
        } },
    { stage: "verify", order: 34, visual: false, async run(context) {
            const { page, fixture, name, row, root } = context;
            let { model } = context;
            try {
                if (fixture.detailTask !== undefined) {
                    const task = fixture.tasks[fixture.detailTask];
                    if (name === 'timeline-recent') {
                        // Regression: a long finished task could not show its latest reply before older turns loaded.
                        const messages = JSON.parse(await readFile(path.join(root, 'ui/locales', `${fixture.language}.json`), 'utf8'));
                        const reply = task.finalAnswer.split('\n')[0];
                        const detail = page.getByRole('dialog', { name: task.title, exact: true });
                        const latest = detail.getByRole('paragraph').filter({ hasText: new RegExp(`^${escapeRegex(reply)}$`) });
                        await latest.waitFor();
                        const older = detail.getByRole('button', { name: new RegExp(escapeRegex(reply)) });
                        if (await older.count())
                            throw new Error('Older turns loaded before the recent reply was shown');
                        await detail.getByLabel(messages['timeline.title'], { exact: true }).press('Home');
                        await older.waitFor();
                        await latest.waitFor();
                    }
                    if (task.parent !== undefined) {
                        // Regression: a detail scenario exposed faded queue buttons behind its panel instead of limiting interaction to the panel.
                        const messages = JSON.parse(await readFile(path.join(root, 'ui/locales', `${fixture.language}.json`), 'utf8'));
                        const detail = page.getByRole('dialog', { name: task.title, exact: true });
                        if (await page.locator('.activity-slot').getByRole('button').count())
                            throw new Error('The replaced task queue remains accessible behind the detail panel');
                        const parent = fixture.tasks[task.parent];
                        await detail.getByRole('button', { name: `${messages['activity.parentThread']} ${parent.title}`, exact: true }).click();
                        await page.waitForFunction(id => window.__ARC_VIEW_MODEL__().panels.agent?.session?.id === id, `fixture-task-${task.parent}`);
                        await page.getByRole('dialog', { name: parent.title, exact: true }).waitFor();
                        await page.keyboard.press('Escape');
                        await page.getByRole('dialog').waitFor({ state: 'hidden' });
                        await page.getByRole('button', { name: new RegExp(`^${escapeRegex(task.title)} · ${escapeRegex(messages[`activity.relation.${task.relationKind ?? 'subagent'}`])} ·`) }).click();
                        await page.waitForFunction(id => window.__ARC_VIEW_MODEL__().panels.agent?.session?.id === id, `fixture-task-${fixture.detailTask}`);
                        await detail.waitFor();
                    }
                    // Semantic snapshots exclude aria-hidden Radix form inputs and visual announcement mirrors.
                    row.taskAccessibility = await page.getByRole('dialog', { name: fixture.tasks[fixture.detailTask].title, exact: true }).ariaSnapshot();
                }
            }
            finally {
                context.model = model;
            }
        } },
    { stage: "verify", order: 35, visual: false, async run(context) {
            const { page, fixture, name, root } = context;
            let { model } = context;
            try {
                if (fixture.taskModelChoice) {
                    const messages = JSON.parse(await readFile(path.join(root, 'ui/locales', `${fixture.language}.json`), 'utf8'));
                    await page.getByRole('button', { name: messages['taskDispatch.title'], exact: true }).click();
                    const dialog = page.getByRole('dialog', { name: messages['taskDispatch.title'], exact: true });
                    await dialog.getByRole('button', { name: messages['dispatchDefaults.spec'], exact: true }).click();
                    await chooseSpec(page, messages, 'GPT-6.1 Sol', messages['dispatchSpec.effort.max']);
                    // Escape closes the picker first, then the dialog, restoring the task detail it was opened from.
                    await page.keyboard.press('Escape');
                    await page.getByRole('dialog', { name: messages['dispatchDefaults.spec'], exact: true }).waitFor({ state: 'hidden' });
                    // The next Escape belongs to the task dialog once focus returns to the picker trigger.
                    await page.waitForFunction(label => document.activeElement?.getAttribute('aria-label') === label, messages['dispatchDefaults.spec']);
                    await page.keyboard.press('Escape');
                    await page.getByRole('dialog', { name: fixture.tasks[fixture.detailTask].title, exact: true }).waitFor();
                    await page.getByRole('button', { name: messages['taskDispatch.title'], exact: true }).click();
                    await dialog.getByRole('button', { name: messages['dispatchDefaults.spec'], exact: true })
                        .getByRole('img', { name: new RegExp(`GPT-6\\.1 Sol.*${escapeRegex(messages['dispatchSpec.effort.max'])}`) }).waitFor();
                    await page.keyboard.press('Escape');
                }
            }
            finally {
                context.model = model;
            }
        } },
    { stage: "afterCapture", order: 46, visual: false, async run(context) {
            const { page, fixture, name, width, height, row, root } = context;
            let { model } = context;
            try {
                if (width >= 1280 && !fixture.homepage && !fixture.page && !fixture.panel && fixture.detailTask === undefined && fixture.tasks.some(task => task.completed)) {
                    // Regression: dragging a completed card left a click guard that swallowed its mark-read action.
                    const messages = JSON.parse(await readFile(path.join(root, 'ui/locales', `${fixture.language}.json`), 'utf8'));
                    const completed = fixture.tasks.flatMap((task, index) => task.completed && model.topology.tasks.some(row => row.taskId === `fixture-task-${index}`)
                        ? [{ task, id: `fixture-task-${index}` }] : []);
                    const unread = [];
                    for (const target of completed) {
                        const group = page.getByRole('group', { name: target.task.title, exact: true });
                        if (await group.getByRole('img', { name: messages['activity.unread'], exact: true }).isVisible())
                            unread.push(target);
                    }
                    if (!unread.length && completed.some(({ task, id }) => model.taskBubbles.some(bubble => bubble.agent === task.agent && bubble.id === id && bubble.unread))) {
                        throw new Error('Expected unread completed tasks expose no unread bubbles');
                    }
                    for (const { task, id } of unread) {
                        const title = task.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                        const taskGroup = page.getByRole('group', { name: task.title, exact: true });
                        const bubble = taskGroup.getByRole('button', { name: new RegExp(`^${title} ·`) });
                        const bounds = await bubble.boundingBox();
                        if (!bounds)
                            throw new Error('Completed task is unavailable for mark-read acceptance');
                        await bubble.dragTo(bubble, {
                            sourcePosition: { x: bounds.width / 2, y: bounds.height / 2 },
                            targetPosition: { x: bounds.width * 0.6, y: bounds.height * 0.6 },
                        });
                        if (!await taskGroup.isVisible())
                            throw new Error(`Dragged task left the visible queue: ${task.title}`);
                        const markRead = taskGroup.getByRole('button', { name: messages['activity.markRead'], exact: true });
                        await markRead.click();
                        await page.waitForFunction(({ agent, id }) => window.__ARC_VIEW_MODEL__().taskBubbles.some(bubble => bubble.agent === agent && bubble.id === id && bubble.completed && !bubble.unread), { agent: task.agent, id });
                        await bubble.getByRole('img', { name: messages['activity.unread'], exact: true }).waitFor({ state: 'hidden' });
                        if (await page.getByRole('dialog').count())
                            throw new Error('Mark-read opened a task detail panel');
                    }
                }
            }
            finally {
                context.model = model;
            }
        } }
];
