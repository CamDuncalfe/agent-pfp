import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { middleSquare } from '../src/round-preview.js';

const readWeb = (path) => readFile(new URL(`../web/${path}`, import.meta.url), 'utf8');

/** A stylesheet with its comments left out. */
const withoutComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** The declarations of each rule with this selector, in the order of the stylesheet. */
function rulesFor(css, selector) {
  return [...withoutComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, selectors]) => selectors.split(',').some((item) => item.trim() === selector))
    .map(([, , body]) =>
      Object.fromEntries(
        body
          .split(';')
          .filter((line) => line.includes(':'))
          .map((line) => [line.slice(0, line.indexOf(':')).trim(), line.slice(line.indexOf(':') + 1).trim()]),
      ),
    );
}

/** The declarations of the one rule with this selector. */
function rule(css, selector) {
  const found = rulesFor(css, selector);
  assert.equal(found.length, 1, `one rule for ${selector}`);
  return found[0];
}

test('the middle square of a square canvas is the whole canvas', () => {
  assert.deepEqual(middleSquare({ width: 64, height: 64 }), { x: 0, y: 0, side: 64 });
  assert.deepEqual(middleSquare({ width: 1024, height: 1024 }), { x: 0, y: 0, side: 1024 });
});

test('a wide canvas loses the same width on each side, and a tall one the same height', () => {
  assert.deepEqual(middleSquare({ width: 96, height: 64 }), { x: 16, y: 0, side: 64 });
  assert.deepEqual(middleSquare({ width: 64, height: 100 }), { x: 0, y: 18, side: 64 });
  // An odd pixel left over stays on the right or at the bottom.
  assert.deepEqual(middleSquare({ width: 9, height: 4 }), { x: 2, y: 0, side: 4 });
  assert.deepEqual(middleSquare({ width: 4, height: 9 }), { x: 0, y: 2, side: 4 });
});

test('a canvas without a whole positive size is refused', () => {
  for (const canvas of [{ width: 0, height: 4 }, { width: 4, height: -1 }, { width: 4.5, height: 4 }, {}]) {
    assert.throws(() => middleSquare(canvas), RangeError);
  }
});

test('the page has one preview canvas, and its Circle switch cuts that preview to a circle', async () => {
  const html = await readWeb('index.html');
  assert.equal(html.match(/<canvas\b/g).length, 1, 'one canvas in the page markup: the preview');
  assert.match(html, /<canvas id="preview"/);
  assert.doesNotMatch(html, /round-preview/);
  // The switch is a checkbox in a label, so it has a name and keeps focus.
  assert.match(html, /<label class="circle-switch">\s*<input type="checkbox" id="circle" \/>\s*<span>Circle<\/span>/);

  // Round, the preview is clipped to the circle in its middle square: half the shorter side, centred.
  const css = await readWeb('builder.css');
  assert.equal(rule(css, '.stage-card.round #preview')['clip-path'], 'circle(closest-side at 50% 50%)');

  // The switch only toggles that class. It draws nothing and leaves the picture Download saves alone.
  const js = await readWeb('builder.js');
  assert.match(js, /if \(target === circleEl\) stageCardEl\.classList\.toggle\('round', circleEl\.checked\);/);
  assert.doesNotMatch(js, /roundPreview/);
});

test('the circle CSS draws is the circle in middleSquare', () => {
  // closest-side at the centre of a w x h box is a circle of radius min(w, h) / 2 around (w / 2, h / 2).
  for (const canvas of [{ width: 64, height: 64 }, { width: 96, height: 64 }, { width: 64, height: 100 }]) {
    const { x, y, side } = middleSquare(canvas);
    assert.equal(side / 2, Math.min(canvas.width, canvas.height) / 2);
    assert.ok(Math.abs(x + side / 2 - canvas.width / 2) <= 0.5);
    assert.ok(Math.abs(y + side / 2 - canvas.height / 2) <= 0.5);
  }
});
