export const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function checkNodePanelBounds(box, viewportWidth, viewportHeight, top) {
  if (!box) throw new Error('The node panel has no visible bounds.');
  const width = viewportWidth < 760 || viewportHeight > viewportWidth ? viewportWidth - 32 : 560;
  const x = (viewportWidth - width) / 2;
  if (Math.abs(box.x - x) > 1 || Math.abs(box.y + box.height / 2 - (top + viewportHeight - 16) / 2) > 1 || Math.abs(box.width - width) > 1
    || box.y + box.height > viewportHeight - 15) throw new Error(`Node panel must use the centered M slot: ${JSON.stringify(box)}`);
}
export async function checkOverviewGrowth(dialog, initial, viewportWidth, viewportHeight, top) {
  checkNodePanelBounds(initial, viewportWidth, viewportHeight, top);
  const frames = await dialog.evaluate(async (element, initialHeight) => {
    const bounds = [];
    let previousHeight = initialHeight, stableFrames = 0;
    for (let frame = 0; frame < 40; frame++) {
      await new Promise(requestAnimationFrame);
      const { x, y, width, height } = element.getBoundingClientRect();
      bounds.push({ x, y, width, height });
      stableFrames = height > initialHeight + 1 && Math.abs(height - previousHeight) < 0.5 ? stableFrames + 1 : 0;
      if (stableFrames >= 3) return bounds;
      previousHeight = height;
    }
    throw new Error('The overview did not grow when its data arrived.');
  }, initial.height);
  for (const box of frames) { checkNodePanelBounds(box, viewportWidth, viewportHeight, top); if (box.height + 1 < initial.height) throw new Error("Loading shortened the open panel."); }
  return frames.at(-1);
}
// Picks a model from the picker's nested menu and, when given, moves the effort slider to that step.
export async function chooseSpec(page, messages, model, effort) {
  await page.getByRole('button', { name: new RegExp(`^${escapeRegex(messages['dispatchDefaults.model'])}: `) }).click();
  await page.getByRole('menuitemradio', { name: model, exact: true }).click();
  await page.getByRole('button', { name: `${messages['dispatchDefaults.model']}: ${model}`, exact: true }).waitFor();
  if (!effort) return;
  const slider = page.getByRole('slider', { name: messages['dispatchDefaults.effort'] });
  await slider.focus();
  await slider.press('End');
  await page.locator(`[role=slider][aria-valuetext="${effort}"]`).waitFor();
}
