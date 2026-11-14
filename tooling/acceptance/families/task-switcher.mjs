import { readFile } from 'node:fs/promises';
import path from 'node:path';
export const bothThemes = fixture => fixture.homepage?.check === 'switcher';
export const checks = [{ stage: 'beforeNavigate', order: 1, visual: true, async run({ fixture, page }) {
  if (fixture.homepage?.motion) await page.emulateMedia({ reducedMotion: 'no-preference' });
} }, { stage: 'verify', order: 19, visual: true, async run({ fixture, page, root, width, row }) {
  if (fixture.homepage?.layout === 'stack') {
    const fills = await page.locator('.task-stack').evaluate(deck => {
      const box = deck.getBoundingClientRect(), card = deck.querySelector('article[aria-current=true] .task-snapshot').getBoundingClientRect();
      return box.height > 0 && Math.abs(card.bottom - box.bottom) <= 2 && card.height > box.height - 80;
    });
    if (!fills) throw new Error('The stack snapshot did not fill the available page height.');
  }
  if (fixture.homepage?.check === 'switcher-window') {
    // Regression: hundreds of hidden task cards mounted snapshots and polled timelines during every deck gesture.
    const deck = page.getByRole('list', { name: 'Tasks', exact: true });
    const counts = async () => ({ shells: await deck.getByRole('article', { includeHidden: true }).count(), details: await deck.locator('[data-task-snapshot]').count() });
    const before = await counts();
    if (before.shells > 9 || before.details > 4) throw new Error(`Unbounded initial deck: ${JSON.stringify(before)}`);
    const current = () => deck.locator('article[aria-current=true]');
    const firstTitle = await current().getAttribute('aria-label');
    if (await page.evaluate(() => window.__ARC_VIEW_MODEL__().homepage.tasks.length) !== 200) throw new Error('Large fixture lost tasks.');
    await deck.hover(); await page.mouse.wheel(-100000, 0);
    await page.waitForFunction(title => document.querySelector('article[aria-current=true]')?.getAttribute('aria-label') !== title, firstTitle);
    const lastTitle = await current().getAttribute('aria-label');
    const after = await counts();
    if (after.shells > 9 || after.details > 4) throw new Error(`Unbounded final deck: ${JSON.stringify(after)}`);
    await current().getByRole('button', { name: `Open task detail: ${lastTitle}`, exact: true }).click();
    await page.getByRole('dialog', { name: lastTitle, exact: true }).waitFor();
    await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await deck.hover(); await page.mouse.wheel(100000, 0);
    await page.waitForFunction(title => document.querySelector('article[aria-current=true]')?.getAttribute('aria-label') === title, firstTitle);
    row.deckWindow = { tasks: 200, before, after, lastTaskOpened: true };
    return;
  }
  if (fixture.homepage?.check !== 'switcher') return;
  // Regression: homepage cards required handling requests and had no switcher navigation or snapshot return path.
  const messages = JSON.parse(await readFile(path.join(root, 'ui/locales', `${fixture.language}.json`), 'utf8'));
  const text = key => messages[`homepage.${key}`];
  const feed = page.getByRole('main', { name: text('tasks'), exact: true });
  if (await feed.getByRole('button', { name: text('answer'), exact: true }).count()
    || await feed.getByRole('button', { name: text('approve'), exact: true }).count()) throw new Error('Status snapshots exposed request actions.');
  const filter = page.getByRole('combobox', { name: text('filter'), exact: true });
  if (width < 500) {
    if (await filter.count()) throw new Error('Mobile retained the status filter.');
  } else {
    await filter.click();
    await page.getByRole('option', { name: new RegExp(`^${text('filter.running')} `) }).click();
    if (await feed.getByRole('article', { name: 'Choose the deployment window', exact: true }).count()) throw new Error('Running filter retained a waiting task.');
    await feed.getByRole('article', { name: 'Inspect the dispatch queue', exact: true }).waitFor();
    await filter.click(); await page.getByRole('option', { name: new RegExp(`^${text('filter.all')} `) }).click();
  }
  const chooseLayout = async layout => {
    const radio = page.getByRole('radio', { name: text(layout), exact: true });
    if (await radio.count()) await radio.click();
    else { await page.getByRole('combobox', { name: text('layout'), exact: true }).click(); await page.getByRole('option', { name: text(layout), exact: true }).click(); }
  };
  await chooseLayout('stack');
  if (await page.evaluate(() => JSON.parse(localStorage.getItem('arc.homepage-task-layout'))) !== 'stack') throw new Error('Stack layout was not persisted.');
  const deck = feed.getByRole('list', { name: text('tasks'), exact: true });
  const settled = () => page.waitForFunction(() => document.querySelector('[aria-keyshortcuts="ArrowLeft ArrowRight Enter"]')?.getAttribute('aria-busy') === 'false');
  const current = () => deck.locator('article[aria-current=true]');
  const initial = await current().getAttribute('aria-label');
  await deck.focus(); await page.keyboard.press('ArrowRight');
  await page.waitForFunction(title => [...document.querySelectorAll('article[aria-current=true]')].some(card => card.getAttribute('aria-label') !== title), initial);
  await settled();
  await page.keyboard.press('ArrowLeft');
  await page.waitForFunction(title => [...document.querySelectorAll('article[aria-current=true]')].some(card => card.getAttribute('aria-label') === title), initial);
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
  // Horizontal wheel and native touch input browse the same deck.
  const beforeWheel = await current().getAttribute('aria-label');
  await deck.hover(); await page.mouse.wheel(-180, 0);
  await page.waitForFunction(title => document.querySelector('article[aria-current=true]')?.getAttribute('aria-label') !== title, beforeWheel);
  await settled();
  const box = await deck.boundingBox();
  const touch = await page.context().newCDPSession(page);
  const beforeTouch = await current().getAttribute('aria-label');
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + 90, y }] });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await touch.detach();
  await page.waitForFunction(title => document.querySelector('article[aria-current=true]')?.getAttribute('aria-label') !== title, beforeTouch);
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
