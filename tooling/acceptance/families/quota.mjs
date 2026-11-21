export const checks = [
  { stage: 'prepare', order: 4, visual: true, async run({ name, page }) {
    if (name !== 'quota-overview') return;
    await page.getByRole('button', { name: '管理 Agent', exact: true }).click();
    await page.getByRole('button', { name: '订阅额度', exact: true }).click();
  } },
  { stage: 'verify', order: 24, visual: true, async run({ name, page }) {
    if (name !== 'quota-overview') return;
    const dialog = page.getByRole('dialog', { name: '订阅额度', exact: true });
    const forecast = dialog.getByRole('button', { name: '5h 限额 · 预计重置时已用 36%' });
    await forecast.waitFor();
    const actual = await dialog.getByRole('meter').evaluateAll(meters => meters.map(meter => ({
      current: meter.getAttribute('aria-valuenow'),
      forecast: meter.getAttribute('aria-valuetext'),
    })));
    if (actual.map(row => row.current).join(',') !== '15,0,4,0' ||
        actual[0].forecast !== '15% · 预计重置时已用 36%' ||
        actual.slice(1).some(row => row.forecast.includes('预计'))) {
      throw new Error(`Unexpected quota readings: ${JSON.stringify(actual)}`);
    }
  } },
];
