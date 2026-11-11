import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkManifest, analyzeLayer, formatReport } from '../src/render-check.js';
import { createRaster } from '../src/composite.js';

const SIZE = 16;
const INK = [20, 20, 20, 255];

function layer(rects, size = SIZE) {
  const raster = createRaster(size, size);
  for (const [x, y, width, height, colour = INK] of rects) {
    for (let py = y; py < y + height; py += 1) {
      for (let px = x; px < x + width; px += 1) raster.data.set(colour, (py * size + px) * 4);
    }
  }
  return raster;
}

/** A small style: full background, a face, eyes and an optional hat. */
function makeStyle() {
  const manifest = {
    version: 1,
    style: 'unit',
    name: 'Unit test style',
    canvas: { width: SIZE, height: SIZE, opaque: true },
    groups: [
      {
        id: 'background',
        label: 'Background',
        base: true,
        bleed: ['top', 'right', 'bottom', 'left'],
        options: [{ id: 'plain', label: 'Plain', src: 'background/plain.png' }],
      },
      {
        id: 'face',
        label: 'Face',
        base: true,
        options: [{ id: 'square', label: 'Square', src: 'face/square.png' }],
      },
      {
        id: 'eyes',
        label: 'Eyes',
        zone: { x: 4, y: 6, width: 8, height: 3 },
        options: [
          { id: 'dots', label: 'Dots', src: 'eyes/dots.png' },
          { id: 'bar', label: 'Bar', src: 'eyes/bar.png' },
        ],
      },
      {
        id: 'hat',
        label: 'Hat',
        optional: true,
        options: [{ id: 'flat', label: 'Flat', src: 'hat/flat.png' }],
      },
    ],
  };
  const layers = {
    'background/plain.png': layer([[0, 0, SIZE, SIZE, [200, 200, 200, 255]]]),
    'face/square.png': layer([[3, 3, 10, 10, [240, 210, 160, 255]]]),
    'eyes/dots.png': layer([[5, 7, 2, 2], [9, 7, 2, 2]]),
    'eyes/bar.png': layer([[4, 7, 8, 1]]),
    'hat/flat.png': layer([[3, 2, 10, 3, [200, 60, 60, 255]]]),
  };
  const load = (src) => {
    if (!layers[src]) throw new Error('no such file');
    return layers[src];
  };
  return { manifest, layers, load };
}

function kinds(report) {
  return report.issues.map((issue) => issue.kind);
}

test('a clean style passes and every combination is visited', async () => {
  const { manifest, load } = makeStyle();
  const report = await checkManifest(manifest, load);
  assert.deepEqual(report.issues, []);
  assert.equal(report.ok, true);
  assert.equal(report.style, 'unit');
  assert.equal(report.layers, 5);
  // eyes x hat: 2 pairs. Pairs with a base group underneath are allowed and not counted.
  assert.equal(report.pairs, 2);
  assert.deepEqual(report.combinations, { total: 4, checked: 4, failed: 0, exhaustive: true });
});

test('an invalid manifest is reported and nothing is loaded', async () => {
  let loads = 0;
  const report = await checkManifest({ version: 1 }, () => {
    loads += 1;
  });
  assert.equal(report.ok, false);
  assert.equal(loads, 0);
  assert.ok(report.issues.length > 0);
  assert.ok(report.issues.every((issue) => issue.kind === 'manifest'));
});

test('a layer that cannot be loaded is reported as missing', async () => {
  const { manifest, layers, load } = makeStyle();
  delete layers['hat/flat.png'];
  const report = await checkManifest(manifest, load);
  assert.deepEqual(kinds(report), ['missing']);
  assert.equal(report.issues[0].group, 'hat');
  assert.match(report.issues[0].message, /no such file/);
  // The two combinations that use the hat fail, the two without it pass.
  assert.equal(report.combinations.failed, 2);
});

test('a loader that returns something other than a raster is reported as missing', async () => {
  const { manifest, layers, load } = makeStyle();
  layers['hat/flat.png'] = { width: SIZE, height: SIZE, data: 'not pixels' };
  const report = await checkManifest(manifest, load);
  assert.deepEqual(kinds(report), ['missing']);
});

test('a layer of the wrong size is reported and left out of later checks', async () => {
  const { manifest, layers, load } = makeStyle();
  layers['eyes/bar.png'] = layer([[2, 3, 4, 1]], 8);
  const report = await checkManifest(manifest, load);
  assert.deepEqual(kinds(report), ['size']);
  assert.match(report.issues[0].message, /eyes\/bar is 8x8, the canvas is 16x16/);
  assert.equal(report.pairs, 1);
  assert.equal(report.combinations.failed, 2);
});

test('a blank layer is reported as empty', async () => {
  const { manifest, layers, load } = makeStyle();
  layers['hat/flat.png'] = createRaster(SIZE, SIZE);
  const report = await checkManifest(manifest, load);
  assert.deepEqual(kinds(report), ['empty']);
});

test('a layer that touches an edge its group does not bleed on is clipped', async () => {
  const { manifest, layers, load } = makeStyle();
  layers['hat/flat.png'] = layer([[3, 0, 10, 5, [200, 60, 60, 255]]]);
  const report = await checkManifest(manifest, load);
  assert.deepEqual(kinds(report), ['clip']);
  assert.equal(report.issues[0].edge, 'top');
  assert.equal(report.issues[0].pixels, 10);
});

test('each edge is reported separately and bleed allows an edge', async () => {
  const { manifest, layers, load } = makeStyle();
  layers['face/square.png'] = layer([[0, 3, SIZE, 13, [240, 210, 160, 255]]]);
  let report = await checkManifest(manifest, load);
  assert.deepEqual(report.issues.map((issue) => issue.edge).sort(), ['bottom', 'left', 'right']);
  manifest.groups[1].bleed = ['bottom', 'left', 'right'];
  report = await checkManifest(manifest, load);
  assert.equal(report.ok, true);
});

test('pixels outside the group zone are counted', async () => {
  const { manifest, layers, load } = makeStyle();
  layers['eyes/bar.png'] = layer([[3, 7, 10, 1]]);
  const report = await checkManifest(manifest, load);
  assert.deepEqual(kinds(report), ['zone']);
  assert.equal(report.issues[0].pixels, 2);
  assert.equal(report.combinations.failed, 2);
});

test('two groups that share pixels fail unless the upper one lists the lower in "over"', async () => {
  const { manifest, layers, load } = makeStyle();
  layers['hat/flat.png'] = layer([[3, 2, 10, 6, [200, 60, 60, 255]]]);
  let report = await checkManifest(manifest, load);
  assert.deepEqual(kinds(report), ['overlap', 'overlap']);
  const withDots = report.issues.find((issue) => issue.otherOption === 'dots');
  assert.equal(withDots.group, 'hat');
  assert.equal(withDots.otherGroup, 'eyes');
  assert.equal(withDots.pixels, 4);
  assert.equal(report.combinations.failed, 2);

  manifest.groups[3].over = ['eyes'];
  report = await checkManifest(manifest, load);
  assert.equal(report.ok, true);
  assert.equal(report.pairs, 0);
});

test('overlapTolerance allows a few shared pixels', async () => {
  const { manifest, layers, load } = makeStyle();
  layers['hat/flat.png'] = layer([[3, 2, 10, 6, [200, 60, 60, 255]]]);
  const report = await checkManifest(manifest, load, { overlapTolerance: 4 });
  // hat x dots shares 4 px (allowed), hat x bar shares 8 px.
  assert.deepEqual(kinds(report), ['overlap']);
  assert.equal(report.issues[0].otherOption, 'bar');
  assert.equal(report.issues[0].pixels, 8);
});

test('faint pixels under the alpha threshold are not counted as drawn', async () => {
  const { manifest, layers, load } = makeStyle();
  layers['hat/flat.png'] = layer([
    [3, 2, 10, 3, [200, 60, 60, 255]],
    [3, 5, 10, 3, [200, 60, 60, 8]],
  ]);
  assert.equal((await checkManifest(manifest, load)).ok, true);
  const strict = await checkManifest(manifest, load, { alphaThreshold: 1 });
  assert.deepEqual(kinds(strict), ['overlap', 'overlap']);
});

test('a see-through pixel in the finished picture is a hole on an opaque canvas', async () => {
  const { manifest, layers, load } = makeStyle();
  layers['background/plain.png'].data.set([0, 0, 0, 0], 0);
  layers['background/plain.png'].data.set([200, 200, 200, 128], 4);
  let report = await checkManifest(manifest, load);
  assert.deepEqual(kinds(report), ['hole', 'hole', 'hole', 'hole']);
  assert.equal(report.issues[0].pixels, 2);
  assert.deepEqual(report.issues[0].selection, { background: 'plain', face: 'square', eyes: 'dots', hat: null });
  assert.equal(report.combinations.failed, 4);

  manifest.canvas.opaque = false;
  report = await checkManifest(manifest, load);
  assert.equal(report.ok, true);
});

test('a hole that another layer covers is not reported', async () => {
  const { manifest, layers, load } = makeStyle();
  // Clear a background pixel under the face.
  layers['background/plain.png'].data.set([0, 0, 0, 0], (5 * SIZE + 5) * 4);
  assert.equal((await checkManifest(manifest, load)).ok, true);
});

test('above maxCombinations the check samples with the seed', async () => {
  const { manifest, load } = makeStyle();
  const report = await checkManifest(manifest, load, { maxCombinations: 3, seed: 5 });
  assert.deepEqual(report.combinations, { total: 4, checked: 3, failed: 0, exhaustive: false });
  assert.match(formatReport(report), /a sample of 3 out of 4/);
});

test('an async loader works', async () => {
  const { manifest, load } = makeStyle();
  const report = await checkManifest(manifest, async (src) => load(src));
  assert.equal(report.ok, true);
});

test('bad options are refused', async () => {
  const { manifest, load } = makeStyle();
  await assert.rejects(checkManifest(manifest, load, { alphaThreshold: 0 }), RangeError);
  await assert.rejects(checkManifest(manifest, load, { overlapTolerance: -1 }), RangeError);
  await assert.rejects(checkManifest(manifest, load, { maxCombinations: 0 }), RangeError);
  await assert.rejects(checkManifest(manifest, load, { seed: 1.5 }), RangeError);
});

test('analyzeLayer reports bounds, edge counts and the drawn pixel count', () => {
  const analysis = analyzeLayer(layer([[0, 2, 3, 2]]));
  assert.equal(analysis.count, 6);
  assert.deepEqual(analysis.bounds, { minX: 0, minY: 2, maxX: 2, maxY: 3 });
  assert.deepEqual(analysis.edges, { top: 0, right: 0, bottom: 0, left: 2 });
  assert.equal(analyzeLayer(createRaster(4, 4)).bounds, null);
});

test('formatReport groups issues by kind and shortens long lists', async () => {
  const { manifest, layers, load } = makeStyle();
  layers['background/plain.png'].data.set([0, 0, 0, 0], 0);
  const report = await checkManifest(manifest, load);
  const text = formatReport(report, { maxPerKind: 1 });
  assert.match(text, /hole \(4\)/);
  assert.match(text, /\.\.\. and 3 more/);
  assert.match(text, /Render check failed with 4 issues\./);
  assert.match(formatReport(await checkManifest(makeStyle().manifest, makeStyle().load)), /Render check passed\./);
});
