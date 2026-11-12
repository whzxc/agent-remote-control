export const checks = [{ stage: 'verify', order: 17.5, visual: true, async run({ page, fixture }) {
  if (!['polish', 'capsules'].includes(fixture.homepage?.check)) return;
  // Regression: left-wing Anthropic artwork overlapped the capsule's attention disc.
  const errors = await page.evaluate(() => {
    const errors = [];
    const overlaps = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > .5
      && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > .5;
    for (const capsule of document.querySelectorAll('.node-capsule')) {
      if (capsule.closest('[inert]')) continue;
      const logo = capsule.querySelector('.node-capsule-logo'), cap = logo.getBoundingClientRect();
      const graphics = [...logo.querySelectorAll('svg,img')].map(graphic => graphic.getBoundingClientRect());
      const left = capsule.closest('[data-wing]').getAttribute('data-wing') === 'left';
      for (const disc of capsule.querySelectorAll('.node-capsule-disc')) {
        const item = disc.getBoundingClientRect();
        if (graphics.some(graphic => overlaps(item, graphic))) errors.push('Capsule artwork overlaps a task disc.');
        if (left ? item.right > cap.x + cap.width / 2 : item.left < cap.x + cap.width / 2) errors.push('Capsule items do not extend outward from the logo cap.');
      }
    }
    return errors;
  });
  if (errors.length) throw new Error([...new Set(errors)].join(' '));
} }];
