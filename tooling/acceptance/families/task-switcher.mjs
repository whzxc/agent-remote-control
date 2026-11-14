import { readFile } from 'node:fs/promises';
import path from 'node:path';
export const bothThemes = fixture => fixture.homepage?.check === 'switcher';
export const checks = [{ stage: 'beforeNavigate', order: 1, visual: true, async run({ fixture, page }) {
  if (fixture.homepage?.motion) await page.emulateMedia({ reducedMotion: 'no-preference' });
} }, { stage: 'verify', order: 19, visual: true, async run({ fixture, page, root, width, row, screenshots, out, key }) {
  if (fixture.homepage?.layout === 'stack') {
    const fills = await page.locator('.task-stack').evaluateAll(decks => decks.every(deck => {
      const box = deck.getBoundingClientRect(), card = deck.querySelector('article[aria-current=true] .task-snapshot').getBoundingClientRect();
      return box.height > 0 && Math.abs(card.bottom - box.bottom) <= 2 && card.height > box.height - 80;
    }));
    if (!fills) throw new Error('The stack snapshot did not fill the available page height.');
  }
  if (fixture.homepage?.check === 'switcher-window') {
    // Regression: hundreds of hidden task cards mounted snapshots and polled timelines during every deck gesture.
    const deck = page.getByRole('list', { name: 'Running', exact: true });
    const counts = async () => ({ shells: await deck.getByRole('article', { includeHidden: true }).count(), details: await deck.locator('[data-task-snapshot]').count() });
    const before = await counts();
    if (before.shells > 16 || before.details !== 5) throw new Error(`Unbounded initial deck: ${JSON.stringify(before)}`);
    const current = () => deck.locator('article[aria-current=true]');
    const firstTitle = await current().getAttribute('aria-label');
    await page.getByRole('button', { name: 'Open board', exact: true }).click();
    await page.getByRole('dialog', { name: 'Board', exact: true }).waitFor();
    await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({ state: 'hidden' });
    if (await page.evaluate(() => window.__ARC_VIEW_MODEL__().homepage.tasks.length) !== 200) throw new Error('Large fixture lost tasks.');
    await deck.hover(); await page.mouse.wheel(-100000, 0);
    await page.waitForFunction(title => document.querySelector('article[aria-current=true]')?.getAttribute('aria-label') !== title, firstTitle);
    const lastTitle = await current().getAttribute('aria-label');
    const after = await counts();
    if (after.shells > 16 || after.details > 5) throw new Error(`Unbounded final deck: ${JSON.stringify(after)}`);
    await current().getByRole('button', { name: `Open task detail: ${lastTitle}`, exact: true }).click();
    await page.getByRole('dialog', { name: lastTitle, exact: true }).waitFor();
    await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await deck.hover(); await page.mouse.wheel(100000, 0);
    await page.waitForFunction(title => document.querySelector('article[aria-current=true]')?.getAttribute('aria-label') === title, firstTitle);
    row.deckWindow = { tasks: 200, before, after, lastTaskOpened: true };
    return;
  }
  if (fixture.coldTaskPreviews) {
    // Regression: snapshot fixtures preseeded the cache and hid first-load timeline failures.
    const snapshot = page.getByRole('article', { name: 'Load a native task preview', exact: true });
    await snapshot.getByText('Cold preview ready', { exact: true }).waitFor();
    await snapshot.getByText('Inspect the native history', { exact: true }).waitFor();
    await snapshot.getByText('40 actions', { exact: true }).click();
    await snapshot.getByText('Inspect preview step 1', { exact: true }).waitFor();
    if (await page.getByRole('dialog').count()) throw new Error('A detail layer was required to load a preview.');
    return;
  }
  if (fixture.homepage?.check !== 'switcher') return;
  // Regression: the status dropdown hid tasks and active tasks stacked with sufficient space to spread.
  const messages = JSON.parse(await readFile(path.join(root, 'ui/locales', `${fixture.language}.json`), 'utf8'));
  const text = key => messages[`homepage.${key}`];
  const feed = page.getByRole('main', { name: text('tasks'), exact: true });
  if (await feed.getByRole('button', { name: text('answer'), exact: true }).count()
    || await feed.getByRole('button', { name: text('approve'), exact: true }).count()) throw new Error('Status snapshots exposed request actions.');
  if (await page.getByRole('combobox', { name: text('filter'), exact: true }).count()) throw new Error('The status dropdown is still visible.');
  const running = feed.getByRole('region', { name: text('running'), exact: true });
  const completed = feed.getByRole('region', { name: text('completed'), exact: true });
  await running.getByRole('article', { name: 'Choose the deployment window', exact: true }).waitFor();
  await running.getByRole('article', { name: 'Inspect the dispatch queue', exact: true }).waitFor();
  const chooseLayout = async layout => {
    const radio = page.getByRole('radio', { name: text(layout), exact: true });
    if (await radio.count()) await radio.click();
    else { await page.getByRole('combobox', { name: text('layout'), exact: true }).click(); await page.getByRole('option', { name: text(layout), exact: true }).click(); }
  };
  await chooseLayout('stack');
  if (await page.evaluate(() => JSON.parse(localStorage.getItem('arc.homepage-task-layout'))) !== 'stack') throw new Error('Stack layout was not persisted.');
  if (width >= 1000) {
    const boxes = await Promise.all(['Choose the deployment window', 'Inspect the dispatch queue']
      .map(name => running.getByRole('article', { name, exact: true }).boundingBox()));
    if (!boxes[0] || !boxes[1] || boxes[0].x + boxes[0].width > boxes[1].x || boxes[0].y !== boxes[1].y)
      throw new Error('Running tasks did not spread side by side.');
  }
  const deck = completed.getByRole('list', { name: text('completed'), exact: true });
  const deckHandle = await deck.elementHandle();
  const settled = () => page.waitForFunction(element => element.getAttribute('aria-busy') === 'false', deckHandle);
  const waitForCard = (title, unchanged = false) => page.waitForFunction(([element, title, unchanged]) =>
    (element.querySelector('article[aria-current=true]')?.getAttribute('aria-label') === title) === unchanged,
    [deckHandle, title, unchanged]);
  const current = () => deck.locator('article[aria-current=true]');
  const initial = await current().getAttribute('aria-label');
  await deck.focus(); await page.keyboard.press('ArrowRight');
  await waitForCard(initial);
  await settled();
  await page.keyboard.press('ArrowLeft');
  await waitForCard(initial, true);
  await settled();
  // Observe the actual front snapshot during the gesture, before release settling.
  const title = deck.getByRole('article', { name: initial, exact: true }).getByRole('button', { name: `${text('openDetail')}: ${initial}`, exact: true });
  await title.waitFor();
  const rect = await title.boundingBox();
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.mouse.down();
  await page.mouse.move(rect.x + rect.width / 2 + 20, rect.y + rect.height / 2, { steps: 4 });
  const moved = await title.boundingBox();
  if (Math.abs(moved.x - rect.x - 20) > 2) throw new Error('The held snapshot did not follow the pointer 1:1.');
  await page.mouse.up(); await settled();
  await deck.focus(); await page.keyboard.press('ArrowRight');
  await settled();
  const selected = await current().getAttribute('aria-label');
  const watchMorph = () => page.evaluate(() => {
    window.__ARC_SWITCHER_MORPH__ = new Promise(resolve => {
      const until = performance.now() + 1500;
      const inspect = () => {
        const dialog = document.querySelector('[role="dialog"]');
        const morph = dialog && getComputedStyle(dialog).transform !== 'none';
        if (morph || performance.now() > until) resolve(!!morph); else requestAnimationFrame(inspect);
      };
      requestAnimationFrame(inspect);
    });
  });
  if (fixture.homepage.motion) await watchMorph();
  await page.keyboard.press('Enter');
  const detail = page.getByRole('dialog', { name: selected, exact: true });
  await detail.waitFor();
  if (fixture.homepage.motion) {
    if (!await page.evaluate(() => window.__ARC_SWITCHER_MORPH__)) throw new Error('Opening did not morph the snapshot into its layer.');
    await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.style.transform === '');
    await watchMorph();
  } else if (await detail.evaluate(node => getComputedStyle(node).transform !== 'none')) throw new Error('Reduced motion animated the task layer.');
  await page.keyboard.press('Escape'); await detail.waitFor({ state: 'hidden' });
  if (fixture.homepage.motion && !await page.evaluate(() => window.__ARC_SWITCHER_MORPH__)) throw new Error('Closing did not morph back to the snapshot.');
  await page.waitForFunction(() => !!document.activeElement?.closest('article'), undefined, { timeout: 3000 });
  // Vertical wheel input browses horizontally; passed cards remain spread to the right.
  const beforeWheel = await current().getAttribute('aria-label');
  await deck.hover(); await page.mouse.wheel(0, 120);
  await waitForCard(beforeWheel);
  await settled();
  const previousCard = deck.getByRole('article', { name: beforeWheel, exact: true });
  if (!await previousCard.isVisible()) throw new Error('The previous card disappeared instead of spreading right.');
  const currentBox = await current().boundingBox(), previousBox = await previousCard.boundingBox();
  if (previousBox.x < currentBox.x + currentBox.width - 2) throw new Error('Passed cards did not spread side by side to the right.');
  if (screenshots && fixture.homepage.layout === 'stack' && width >= 1000) await page.screenshot({ path: path.join(out, `${key}-spread.png`) });
  const box = await deck.boundingBox();
  const touch = await page.context().newCDPSession(page);
  const beforeTouch = await current().getAttribute('aria-label');
  const x = box.x + box.width / 4, y = box.y + box.height / 2;
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + 220, y }] });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await touch.detach();
  await waitForCard(beforeTouch);
  await settled();
  await chooseLayout('tile');
  if (await page.evaluate(() => JSON.parse(localStorage.getItem('arc.homepage-task-layout'))) !== 'tile') throw new Error('Tile layout was not persisted.');
  const waiting = feed.getByRole('article', { name: 'Choose the deployment window', exact: true });
  await waiting.getByRole('button', { name: `${text('openDetail')}: Choose the deployment window`, exact: true }).click();
  await page.getByRole('dialog', { name: 'Choose the deployment window', exact: true }).waitFor();
  await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: messages['center.open'], exact: true }).click();
  await page.getByRole('dialog', { name: messages['center.title'], exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await chooseLayout(fixture.homepage.layout);
} }];
