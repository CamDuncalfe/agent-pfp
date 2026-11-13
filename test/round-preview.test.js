import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { compositeLayers, createRaster } from '../src/composite.js';
import {
  ROUND_PREVIEW_MAX_SIDE,
  ROUND_PREVIEW_WIDTH,
  middleSquare,
  roundPreviewPicture,
  roundPreviewSide,
} from '../src/round-preview.js';
import { scaleDown } from '../src/scale.js';

const readWeb = (path) => readFile(new URL(`../web/${path}`, import.meta.url), 'utf8');

function pixel(raster, x, y) {
  const i = (y * raster.width + x) * 4;
  return Array.from(raster.data.slice(i, i + 4));
}

/** Opaque pixels, each one a colour that says where it is. */
function numbered(width, height) {
  const raster = createRaster(width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      raster.data.set([x, y, (x * 7 + y * 13) % 256, 255], (y * width + x) * 4);
    }
  }
  return raster;
}

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

/** A length in px as a number. Anything else fails the test. */
function px(value) {
  assert.match(value ?? '', /^\d+px$/, `"${value}" is a length in px`);
  return Number.parseInt(value, 10);
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

test('the round preview of a square picture holds the same pixels as the picture', () => {
  const picture = numbered(8, 8);
  const round = roundPreviewPicture(picture);
  assert.equal(round.width, 8);
  assert.equal(round.height, 8);
  assert.deepEqual(Array.from(round.data), Array.from(picture.data));
  // A copy: the picture Download saves is not the one the round preview holds.
  assert.notEqual(round.data, picture.data);
  assert.notEqual(round.data.buffer, picture.data.buffer);
});

test('the round preview of a wide picture is its middle square, pixel for pixel', () => {
  const picture = numbered(96, 64);
  const round = roundPreviewPicture(picture);
  assert.equal(round.width, 64);
  assert.equal(round.height, 64);
  for (let y = 0; y < 64; y += 1) {
    for (let x = 0; x < 64; x += 1) {
      assert.deepEqual(pixel(round, x, y), pixel(picture, x + 16, y));
    }
  }
});

test('the round preview of a tall picture is its middle square, pixel for pixel', () => {
  const picture = numbered(5, 12);
  const round = roundPreviewPicture(picture);
  assert.equal(round.width, 5);
  assert.equal(round.height, 5);
  for (let y = 0; y < 5; y += 1) {
    for (let x = 0; x < 5; x += 1) {
      assert.deepEqual(pixel(round, x, y), pixel(picture, x, y + 3));
    }
  }
});

test('see-through pixels stay as they are and the picture is left alone', () => {
  const picture = createRaster(6, 4);
  picture.data.set([200, 100, 50, 128], (1 * 6 + 2) * 4);
  const before = Array.from(picture.data);
  const round = roundPreviewPicture(picture);
  assert.deepEqual(pixel(round, 1, 1), [200, 100, 50, 128]);
  assert.deepEqual(pixel(round, 0, 0), [0, 0, 0, 0]);
  assert.deepEqual(Array.from(picture.data), before);
});

test('the round preview follows the picture when a layer changes', () => {
  const background = numbered(6, 4);
  const stack = (dot) => {
    const layer = createRaster(6, 4);
    layer.data.set(dot, (2 * 6 + 3) * 4);
    return compositeLayers(6, 4, [background, layer]);
  };
  const first = roundPreviewPicture(stack([255, 0, 0, 255]));
  const second = roundPreviewPicture(stack([0, 255, 0, 255]));
  // Canvas pixel 3,2 is pixel 2,2 of the middle square.
  assert.deepEqual(pixel(first, 2, 2), [255, 0, 0, 255]);
  assert.deepEqual(pixel(second, 2, 2), [0, 255, 0, 255]);
});

test('something that is not a picture is refused', () => {
  for (const value of [null, {}, { width: 2, height: 2, data: new Uint8ClampedArray(3) }]) {
    assert.throws(() => roundPreviewPicture(value), TypeError);
  }
});

test('the round preview holds two pixels for each of its 96 CSS pixels at most', () => {
  assert.equal(ROUND_PREVIEW_WIDTH, 96);
  assert.equal(ROUND_PREVIEW_MAX_SIDE, 192);
  assert.equal(ROUND_PREVIEW_MAX_SIDE, ROUND_PREVIEW_WIDTH * 2);
});

test('the side of the round picture is the middle square, or 192 px when the square is bigger', () => {
  assert.equal(roundPreviewSide({ width: 64, height: 64 }), 64);
  assert.equal(roundPreviewSide({ width: 96, height: 64 }), 64);
  assert.equal(roundPreviewSide({ width: 192, height: 192 }), 192);
  assert.equal(roundPreviewSide({ width: 193, height: 193 }), 192);
  assert.equal(roundPreviewSide({ width: 1024, height: 1024 }), 192);
  assert.equal(roundPreviewSide({ width: 2000, height: 500 }), 192);
  assert.equal(roundPreviewSide({ width: 2000, height: 100 }), 100);
  assert.throws(() => roundPreviewSide({ width: 0, height: 4 }), RangeError);
});

test('a square of 192 px stays as it is, pixel for pixel', () => {
  const picture = numbered(192, 192);
  const round = roundPreviewPicture(picture);
  assert.equal(round.width, 192);
  assert.deepEqual(Array.from(round.data), Array.from(picture.data));
});

test('a bigger square picture is averaged down to 192 px with scaleDown', () => {
  for (const side of [193, 500, 1024]) {
    const picture = numbered(side, side);
    const round = roundPreviewPicture(picture);
    assert.equal(round.width, 192);
    assert.equal(round.height, 192);
    assert.deepEqual(Array.from(round.data), Array.from(scaleDown(picture, 192, 192).data), `${side} px`);
  }
});

test('a big tall picture comes out as its middle square scaled down', () => {
  const picture = numbered(300, 500);
  const middle = createRaster(300, 300);
  for (let y = 0; y < 300; y += 1) {
    for (let x = 0; x < 300; x += 1) {
      middle.data.set(pixel(picture, x, y + 100), (y * 300 + x) * 4);
    }
  }
  const round = roundPreviewPicture(picture);
  assert.equal(round.width, 192);
  assert.equal(round.height, 192);
  assert.deepEqual(Array.from(round.data), Array.from(scaleDown(middle, 192, 192).data));
});

test('a big wide picture comes out as its middle square scaled down', () => {
  const picture = numbered(600, 400);
  const middle = createRaster(400, 400);
  for (let y = 0; y < 400; y += 1) {
    for (let x = 0; x < 400; x += 1) {
      middle.data.set(pixel(picture, x + 100, y), (y * 400 + x) * 4);
    }
  }
  const round = roundPreviewPicture(picture);
  assert.equal(round.width, 192);
  assert.equal(round.height, 192);
  assert.deepEqual(Array.from(round.data), Array.from(scaleDown(middle, 192, 192).data));
});

/** The lengths of the pixel buffers made while `run` runs. */
function buffersMadeBy(run) {
  const Original = globalThis.Uint8ClampedArray;
  const lengths = [];
  globalThis.Uint8ClampedArray = class extends Original {
    constructor(...args) {
      super(...args);
      if (typeof args[0] === 'number') lengths.push(args[0]);
    }
  };
  try {
    run();
  } finally {
    globalThis.Uint8ClampedArray = Original;
  }
  return lengths;
}

test('a big square picture goes straight to scaleDown, with no full-size copy', () => {
  const picture = numbered(400, 400);
  let round;
  const lengths = buffersMadeBy(() => {
    round = roundPreviewPicture(picture);
  });
  // One buffer is made: the 192 px result.
  assert.deepEqual(lengths, [192 * 192 * 4]);
  assert.deepEqual(Array.from(round.data), Array.from(scaleDown(picture, 192, 192).data));
  assert.notEqual(round.data.buffer, picture.data.buffer);
});

test('a big picture that is not square gets no full-size copy of its middle square either', () => {
  for (const [width, height] of [[600, 400], [400, 600], [193, 2000]]) {
    const picture = numbered(width, height);
    const lengths = buffersMadeBy(() => roundPreviewPicture(picture));
    assert.deepEqual(lengths, [192 * 192 * 4], `${width}x${height}`);
  }
});

test('the biggest buffer made is 192 px a side, whatever the size of the canvas', () => {
  for (const [width, height] of [[64, 64], [96, 64], [192, 192], [1024, 1024], [1500, 1000]]) {
    const picture = createRaster(width, height);
    const lengths = buffersMadeBy(() => roundPreviewPicture(picture));
    assert.equal(lengths.length, 1, `${width}x${height} makes one buffer`);
    assert.ok(lengths[0] <= 192 * 192 * 4, `${width}x${height}`);
  }
});

test('a square picture of 192 px or less is still copied, so the round preview never shares pixels with Download', () => {
  const picture = numbered(192, 192);
  let round;
  const lengths = buffersMadeBy(() => {
    round = roundPreviewPicture(picture);
  });
  assert.deepEqual(lengths, [192 * 192 * 4]);
  assert.notEqual(round.data, picture.data);
});

test('a line one pixel wide in a big picture is still there after the scaling', () => {
  const picture = createRaster(1024, 1024);
  for (let i = 0; i < picture.data.length; i += 4) picture.data.set([255, 255, 255, 255], i);
  // One black column, at an x no "every few pixels" sampling is sure to hit.
  for (let y = 0; y < 1024; y += 1) picture.data.set([0, 0, 0, 255], (y * 1024 + 517) * 4);
  const round = roundPreviewPicture(picture);
  const column = Math.floor((517 * 192) / 1024);
  for (const y of [0, 95, 191]) {
    const [red, , , alpha] = pixel(round, column, y);
    assert.ok(red < 255, `row ${y} is darker where the line is`);
    assert.equal(alpha, 255);
    assert.deepEqual(pixel(round, column + 2, y), [255, 255, 255, 255]);
  }
});

test('the picture and the canvas the page makes for it have the same side', () => {
  for (const [width, height] of [[64, 64], [96, 64], [5, 12], [192, 192], [300, 200], [1024, 1024]]) {
    const round = roundPreviewPicture(createRaster(width, height));
    assert.equal(round.width, roundPreviewSide({ width, height }), `${width}x${height}`);
    assert.equal(round.height, round.width);
  }
});

test('the round preview module takes a finished picture and stacks no layers', async () => {
  const source = await readFile(new URL('../src/round-preview.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /compositeLayers\(|^import[^;]*compositeLayers/m);
  assert.doesNotMatch(source, /fetch\(|document\.|drawImage/);
});

test('the page has a second preview canvas next to the main one', async () => {
  const html = await readWeb('index.html');
  const previews = /<div class="previews">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? '';
  const ids = [...previews.matchAll(/<canvas[^>]*\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(ids, ['preview', 'round-preview']);
  const round = /<canvas[^>]*\bid="round-preview"[^>]*>/.exec(previews)[0];
  assert.match(round, /role="img"/);
  assert.match(round, /aria-label="[^"]*circle[^"]*"/);
  assert.doesNotMatch(html, /\sstyle="/, 'no inline style');

});

test('the previews sit side by side when the column has room, and the round one goes under when it does not', async () => {
  const css = await readWeb('builder.css');
  const row = rule(css, '.previews');
  assert.equal(row.display, 'flex');
  assert.equal(row['flex-direction'], undefined, 'a row, the big preview first');
  assert.equal(row['flex-wrap'], 'wrap', 'the round preview wraps to the next line');
  assert.equal(row['align-items'], 'flex-start', 'top-aligned');
  assert.equal(row['justify-content'], undefined, 'a wrapped line starts on the left');
  assert.equal(row.gap, '16px');

  // The big preview is 320 px wide and never wider than its column. It neither grows nor shrinks to make room.
  const big = rule(css, '#preview');
  assert.equal(big.width, '320px');
  assert.equal(big['max-width'], '100%');
  assert.equal(big.flex, 'none');
  assert.equal(big.height, 'auto');
});

test('the page is wide enough for both previews side by side and the controls line up with the big one', async () => {
  const css = await readWeb('builder.css');
  const big = px(rule(css, '#preview').width);
  const round = px(rule(css, '#round-preview').width);
  const gap = px(rule(css, '.previews').gap);
  assert.equal(big + gap + round, 432);

  // Two columns: the left one fits both previews, the right one is as wide as on a 720 px page.
  const [wide, narrow] = rulesFor(css, '.layout');
  assert.equal(wide['grid-template-columns'], `minmax(0, ${big + gap + round}px) minmax(0, 320px)`);
  const main = rule(css, 'main');
  assert.equal(main.padding, '40px 24px 64px');
  assert.equal(px(main['max-width']), 24 + 432 + px(wide.gap) + 320 + 24);
  assert.equal(main['max-width'], '832px');

  // At 560 px and under the page is one column.
  assert.deepEqual(narrow, { 'grid-template-columns': 'minmax(0, 1fr)' });
  assert.match(
    withoutComments(css),
    /@media \(max-width: 560px\) \{\s*\.layout \{\s*grid-template-columns: minmax\(0, 1fr\);\s*\}\s*\}/,
  );
  // The one other query, from 900 px up, only keeps the preview column in view (test/builder-page.test.js).
  assert.deepEqual(
    withoutComments(css).match(/@media[^{]*/g).map((query) => query.trim()),
    ['@media (max-width: 560px)', '@media (min-width: 900px)'],
    'no other width changes the layout',
  );
  assert.match(withoutComments(css), /@media \(min-width: 900px\) \{\s*\.preview-column \{[^}]*\}\s*\}/);

  // The controls under the preview are as wide as the big preview at most.
  assert.equal(px(rule(css, '.actions')['max-width']), big);
});

test('the stylesheet makes the round preview a circle 96 px wide, the width src/round-preview.js has', async () => {
  const css = await readWeb('builder.css');
  const round = rule(css, '#round-preview');
  assert.equal(round.width, `${ROUND_PREVIEW_WIDTH}px`);
  assert.equal(round.height, `${ROUND_PREVIEW_WIDTH}px`);
  // The canvas holds two pixels per CSS pixel at most.
  assert.equal(ROUND_PREVIEW_MAX_SIDE, px(round.width) * 2);
  assert.equal(round.width, '96px');
  assert.equal(round.height, '96px');
  assert.equal(round['border-radius'], '50%');
  // Nothing takes room from the 96 px or lets the row squeeze it.
  assert.equal(round.border, undefined);
  assert.equal(round.padding, undefined);
  assert.equal(round.flex, 'none');
  // No other rule, and no media query, gives it another size.
  assert.equal(withoutComments(css).match(/#round-preview/g).length, 1);
});

test('the page draws both previews from the one finished picture, in one function', async () => {
  const js = await readWeb('builder.js');
  assert.match(
    js,
    /function showPicture\(picture\) \{\n\s*putPicture\(previewEl, picture\);\n\s*putPicture\(roundPreviewEl, roundPreviewPicture\(picture\)\);\n\}/,
  );
  // Each render shows the picture compositeLayers just drew, and nothing else writes to a preview.
  assert.match(js, /const picture = compositeLayers\(width, height, rasters\);\n\s*showPicture\(picture\);/);
  assert.equal(js.match(/showPicture\(/g).length, 2, 'defined once, called once');
  assert.equal(js.match(/roundPreviewPicture\(/g).length, 1);
  assert.equal(js.match(/putImageData\(/g).length, 1, 'one place puts pixels on a canvas');
  // Pixels go on at 0,0 and the page does no cropping or scaling of its own.
  assert.match(js, /putImageData\(new ImageData\(picture\.data, picture\.width, picture\.height\), 0, 0\)/);
  assert.doesNotMatch(js, /\.clip\(|\.arc\(|\b96\b|\b192\b|scaleDown|middleSquare/);
});

test('the round canvas gets the side src/round-preview.js gives and is emptied with the main one', async () => {
  const js = await readWeb('builder.js');
  assert.match(
    js,
    /const side = roundPreviewSide\(manifest\.canvas\);\n\s*roundPreviewEl\.width = side;\n\s*roundPreviewEl\.height = side;/,
  );
  assert.match(js, /for \(const canvasEl of \[previewEl, roundPreviewEl\]\) \{\n\s*canvasEl\.getContext\('2d'\)\.clearRect\(/);
  assert.equal(js.match(/clearRect\(/g).length, 1);
  assert.match(js, /function clearStyle\(\) \{[^}]*clearPreviews\(\);/);
});
