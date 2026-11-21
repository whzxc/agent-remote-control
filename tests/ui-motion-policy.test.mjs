import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { checkMotion } from '../tooling/check-ui-motion.mjs';

const reset = ':root[data-reduced-motion="true"] { *, *::before, *::after { animation-duration: 0s !important; transition-duration: 0ms !important; } }';
const timed = 'var(--motion-fast) var(--ease-enter)';
async function fixture(t, files, exceptions = []) {
  const root = await mkdtemp(path.join(tmpdir(), 'arc-motion-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const design = await readFile(new URL('../design/tokens.css', import.meta.url), 'utf8');
  for (const [file, content] of Object.entries({
    'design/tokens.css': design,
    'ui/style.css': reset,
    'tooling/ui-motion-running-selectors.json': JSON.stringify(['.job-spinner']),
    'tooling/ui-motion-allowlist.json': JSON.stringify(exceptions),
    ...files,
  })) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
  return root;
}

test('CSS motion policy separates tracks, token roles, loops and reduced-motion coverage', async t => {
  // Algorithmic core: shorthand parsing must validate each track, including implicit timing and nested fallback values.
  const root = await fixture(t, {
    'ui/topology/controls.css': `.ok { transition: color ${timed}, transform ${timed}; }
      .job-spinner { animation: spin var(--motion-running) var(--ease-running) infinite; }
      .mixed { transition: color ${timed}, opacity 1s var(--ease-enter); }
      .implicit { transition: color var(--motion-fast); }
      .idle { animation: pulse ${timed} infinite; }
      .job-spinner { animation: a ${timed} infinite, b ${timed} infinite; }
      .fallback { animation-duration: var(--motion-fast, 350ms); }
      @keyframes bad { to { animation-timing-function: steps(2); } }
      .wait { transition-delay: 350ms; }
      .defaults { transition-duration: var(--motion-base); }
      .alias { --duration: var(--motion-fast); transition: color var(--duration) var(--ease-enter); }
      .split { transition: color var(--motion-fast); transition-timing-function: var(--ease-exit); }`,
    'ui/components/ui/nested.css': '.wrong { transition-timing-function: var(--motion-fast); }',
    'ui/tokens.css': ':root { --motion-fast: 2s; }',
    'ui/style.css': reset.replace(', *::after', ''),
  });
  const result = checkMotion(root);
  assert.deepEqual(result.inventory.filter(row => row.issues?.length).map(row => row.selector).sort(),
    ['.mixed', '.implicit', '.idle', '.job-spinner', '.fallback', 'to', '.wait', '.defaults', '.wrong', ':root'].sort());
  assert.equal(result.errors.filter(error => error.includes('on *::after')).length, 2);
  await writeFile(path.join(root, 'design/tokens.css'), ':root { --ease-enter: linear; --motion-base: 10s; }');
  assert.equal(checkMotion(root).errors.filter(error => error.startsWith('design/tokens.css:')).length, 7);
});

test('motion exceptions belong to the exact artwork declaration and expire with it', async t => {
  // Algorithmic core: an approved artwork clock must not authorize another selector, file or property.
  const entry = { file: 'ui/scene.css', selector: '.leaf', property: 'animation', reason: 'Window artwork: sways a leaf.' };
  const root = await fixture(t, {
    'ui/scene.css': '.leaf { animation: sway 5s linear infinite; animation-delay: 2s; } .other { animation: sway 5s linear infinite; }',
    'ui/other.css': '.leaf { animation: sway 5s linear infinite; }',
  }, [entry]);
  assert.equal(checkMotion(root).errors.length, 3);
  await writeFile(path.join(root, entry.file), '.leaf { animation: none; }');
  assert.ok(checkMotion(root).errors.some(error => error.includes('Stale motion exception')));
  const list = path.join(root, 'tooling/ui-motion-allowlist.json');
  await writeFile(list, JSON.stringify([entry, entry]));
  assert.throws(() => checkMotion(root), /Duplicate/);
  await writeFile(list, JSON.stringify([{ ...entry, reason: 'artwork' }]));
  assert.throws(() => checkMotion(root), /naming the artwork/);
});

test('script policy follows CSS and Motion timing to their source', async t => {
  // Algorithmic core: aliases, instant branches and Motion and Web Animations units must preserve timing provenance.
  const root = await fixture(t, {
    'ui/part.tsx': `import { motion, animate as play } from 'motion/react';
      import { motionTransition as timing } from './motion/tokens';
      const good = reduced ? { duration: 0 } : timing();
      const bad = { ...timing(), duration: .4 };
      const styles = { transition: 'opacity ${timed}', animationDelay: '35ms' };
      const a = <motion.div animate={{ opacity: 1 }} transition={good} style={styles}/>;
      const b = <motion.div layout transition={bad}/>;
      const c = <motion.div animate={{ opacity: 0 }}/>;
      const d = <i style={{ animationTimingFunction: 'linear' }}/>;
      play(el, { opacity: 1 }, timing());
      play(el, { opacity: 0 }, { ...timing(), ease: [0, 0, 1, 1] });
      play(el, { opacity: 0 });`,
    'ui/topology/animate.ts': 'const step = (dt: number) => 1 - Math.exp(-dt / 140);',
    'ui/clock.js': `import { motionTransition } from './motion/tokens';
      el.style.transitionDuration = '20ms';
      el.style.setProperty('animation-delay', '4s');
      el.animate(frames, { duration: 100, easing: 'linear' });
      new KeyframeEffect(el, frames, 200);
      el.animate(frames, { duration: motionTransition().duration * 1000,
        easing: getComputedStyle(document.documentElement).getPropertyValue('--ease-enter').trim() });
      const record = { duration: 123 };
      function draw() { requestAnimationFrame(draw); }
      requestAnimationFrame(() => el.focus());
      el.style.setProperty('--motion-fast', '2s');
      el.animate([{ opacity: 1, easing: 'ease' }], 0); `,
  });
  const result = checkMotion(root);
  assert.deepEqual(result.inventory.filter(row => row.issues?.length).map(row => [row.file, row.line]), [
    ['ui/clock.js', 2], ['ui/clock.js', 3], ['ui/clock.js', 4], ['ui/clock.js', 5], ['ui/clock.js', 9], ['ui/clock.js', 11], ['ui/clock.js', 12],
    ['ui/part.tsx', 5], ['ui/part.tsx', 7], ['ui/part.tsx', 8], ['ui/part.tsx', 9], ['ui/part.tsx', 11], ['ui/part.tsx', 12],
  ]);
});

test('artwork clock producers and consumers require independent exact exceptions', async t => {
  // Algorithmic core: an approved CSS consumer must not launder unowned inline timing.
  const entry = { file: 'ui/art.css', selector: '.bird', property: 'animation', reason: 'Bird artwork: steps its wing poses.' };
  const clock = { ...entry, file: 'ui/Bird.tsx', property: '--beat', reason: 'Bird artwork: picks the pose cadence.' };
  const root = await fixture(t, {
    'ui/art.css': '.bird { animation: flap var(--beat) steps(4) infinite; }',
    'ui/Bird.tsx': 'const Bird = () => <i className="bird" style={{ "--beat": tempo }}/>;',
  }, [entry]);
  assert.equal(checkMotion(root).errors.length, 1);
  await writeFile(path.join(root, 'tooling/ui-motion-allowlist.json'), JSON.stringify([entry, clock]));
  assert.deepEqual(checkMotion(root).errors, []);
});
