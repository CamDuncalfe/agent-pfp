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

/**
 * makeStyle with an Eyewear group between the eyes and the hat that may
 * cover the eyes. `lens` is the eyewear layer.
 */
function withEyewear(lens, settings = {}) {
  const { optional = true } = settings;
  const seeThrough = 'seeThrough' in settings ? settings.seeThrough : true;
  const style = makeStyle();
  const option = { id: 'clear', label: 'Clear', src: 'eyewear/clear.png' };
  if (seeThrough !== undefined) option.seeThrough = seeThrough;
  style.manifest.groups.splice(3, 0, {
    id: 'eyewear',
    label: 'Eyewear',
    optional,
    over: ['eyes'],
    options: [option],
  });
  style.layers['eyewear/clear.png'] = lens;
  return style;
}

// A frame row above and below the eyes, lenses left empty.
const EMPTY_LENSES = [[4, 6, 8, 1], [4, 9, 8, 1]];
// The same frame with opaque lenses over the whole eye zone.
const PAINTED_LENSES = [[4, 6, 8, 4, [90, 120, 200, 255]]];

test('a see-through option that hides the eyes is reported as covered, naming both options', async () => {
  const { manifest, load } = withEyewear(layer(PAINTED_LENSES));
  const report = await checkManifest(manifest, load);
  assert.deepEqual(kinds(report), ['covered']);
  const [issue] = report.issues;
  assert.equal(issue.group, 'eyewear');
  assert.equal(issue.option, 'clear');
  assert.equal(issue.otherGroup, 'eyes');
  assert.equal(issue.otherOption, 'bar');
  assert.equal(issue.defaultOption, 'dots');
  assert.equal(issue.message, 'eyewear/clear is see-through, but over it eyes/bar gives the same picture as eyes/dots');
  assert.match(formatReport(report), /covered \(1\)/);
});

test('a see-through option with empty lenses passes', async () => {
  const { manifest, load } = withEyewear(layer(EMPTY_LENSES));
  const report = await checkManifest(manifest, load);
  assert.deepEqual(report.issues, []);
});

test('tinted lenses that let the eyes show pass', async () => {
  const { manifest, load } = withEyewear(layer([[4, 6, 8, 4, [90, 120, 200, 128]]]));
  assert.deepEqual((await checkManifest(manifest, load)).issues, []);
});

test('an option not marked see-through may hide the eyes', async () => {
  for (const seeThrough of [undefined, false]) {
    const { manifest, load } = withEyewear(layer(PAINTED_LENSES), { seeThrough });
    assert.deepEqual((await checkManifest(manifest, load)).issues, [], `seeThrough ${seeThrough}`);
  }
});

test('see-through compares each option of the covered group with its default, also when that is None', async () => {
  const { manifest, layers, load } = withEyewear(layer(PAINTED_LENSES));
  // Optional eyes default to None, so both eye options are compared with no eyes.
  manifest.groups[2].optional = true;
  let report = await checkManifest(manifest, load);
  assert.deepEqual(
    report.issues.map((issue) => [issue.otherOption, issue.defaultOption]),
    [['dots', null], ['bar', null]],
  );
  assert.match(report.issues[0].message, /eyes\/dots gives the same picture as eyes\/none/);

  // A group with one choice has nothing to compare.
  manifest.groups[2].optional = false;
  manifest.groups[2].options.pop();
  delete layers['eyes/bar.png'];
  report = await checkManifest(manifest, load);
  assert.deepEqual(report.issues, []);
});

test('see-through checks an option of a required group too', async () => {
  const { manifest, load } = withEyewear(layer(PAINTED_LENSES), { optional: false });
  assert.deepEqual(kinds(await checkManifest(manifest, load)), ['covered']);
});

test('see-through checks each option marked, with the default picks for the other groups', async () => {
  const { manifest, layers, load } = withEyewear(layer(EMPTY_LENSES));
  manifest.groups[3].options.push({ id: 'painted', label: 'Painted', src: 'eyewear/painted.png', seeThrough: true });
  layers['eyewear/painted.png'] = layer(PAINTED_LENSES);
  // The background has two options; the comparison draws its default, the first.
  manifest.groups[0].options.push({ id: 'dark', label: 'Dark', src: 'background/dark.png' });
  layers['background/dark.png'] = layer([[0, 0, SIZE, SIZE, [40, 40, 40, 255]]]);
  const report = await checkManifest(manifest, load);
  assert.deepEqual(
    report.issues.map((issue) => `${issue.kind} ${issue.option} ${issue.otherOption}`),
    ['covered painted bar'],
  );
});

test('several see-through options over several covered groups on half-transparent layers give each result once', async () => {
  const { manifest, layers, load } = withEyewear(layer(EMPTY_LENSES));
  manifest.canvas.opaque = false;
  // Half-transparent layers under the covered groups, so the shared bottom is blended.
  layers['background/plain.png'] = layer([[0, 0, SIZE, SIZE, [200, 200, 200, 128]]]);
  layers['face/square.png'] = layer([[3, 3, 10, 10, [240, 210, 160, 200]]]);
  manifest.groups[1].options.push({ id: 'wide', label: 'Wide', src: 'face/wide.png' });
  layers['face/wide.png'] = layer([[2, 3, 12, 10, [240, 210, 160, 200]]]);
  manifest.groups[2].options.push({ id: 'full', label: 'Full', src: 'eyes/full.png' });
  layers['eyes/full.png'] = layer([[4, 6, 8, 3]]);
  const eyewear = manifest.groups[3];
  eyewear.over = ['face', 'eyes'];
  eyewear.options.push(
    { id: 'painted', label: 'Painted', src: 'eyewear/painted.png', seeThrough: true },
    { id: 'tinted', label: 'Tinted', src: 'eyewear/tinted.png', seeThrough: true },
    { id: 'shades', label: 'Shades', src: 'eyewear/shades.png' },
  );
  layers['eyewear/painted.png'] = layer(PAINTED_LENSES);
  layers['eyewear/tinted.png'] = layer([[4, 6, 8, 4, [90, 120, 200, 128]]]);
  layers['eyewear/shades.png'] = layer(PAINTED_LENSES);
  const report = await checkManifest(manifest, load);
  assert.deepEqual(
    report.issues.map((issue) => `${issue.kind} ${issue.option} ${issue.otherGroup}/${issue.otherOption} like ${issue.defaultOption}`),
    ['covered painted eyes/bar like dots', 'covered painted eyes/full like dots'],
  );
});

test('see-through needs an "over" list to compare against', async () => {
  const { manifest, load } = withEyewear(layer([[4, 10, 8, 1]]));
  delete manifest.groups[3].over;
  assert.deepEqual((await checkManifest(manifest, load)).issues, []);
});

test('a layer that cannot be loaded is not compared for see-through', async () => {
  const { manifest, layers, load } = withEyewear(layer(PAINTED_LENSES));
  delete layers['eyes/bar.png'];
  assert.deepEqual(kinds(await checkManifest(manifest, load)), ['missing']);
});

test('seeThrough has to be true or false', async () => {
  const { manifest, load } = withEyewear(layer(EMPTY_LENSES), { seeThrough: 'yes' });
  const report = await checkManifest(manifest, load);
  assert.deepEqual(kinds(report), ['manifest']);
  assert.match(report.issues[0].message, /options\[0\]\.seeThrough must be true or false/);
});

test('above maxCombinations the check samples with the seed', async () => {
  const { manifest, load } = makeStyle();
  const report = await checkManifest(manifest, load, { maxCombinations: 3, seed: 5 });
  assert.deepEqual(report.combinations, { total: 4, checked: 3, failed: 0, exhaustive: false });
  assert.match(formatReport(report), /a sample of 3 different ones out of 4/);
});

test('a style with too many combinations to count reports a null total that survives JSON', async () => {
  const size = 4;
  const manifest = {
    version: 1,
    style: 'huge',
    name: 'Huge',
    canvas: { width: size, height: size },
    groups: Array.from({ length: 20 }, (_, g) => ({
      id: `g${g}`,
      label: `Group ${g}`,
      base: true,
      options: Array.from({ length: 10 }, (_, o) => ({ id: `o${o}`, label: `Option ${o}`, src: `g${g}/o${o}.png` })),
    })),
  };
  const dot = layer([[1, 1, 1, 1]], size);
  const report = await checkManifest(manifest, () => dot, { maxCombinations: 25 });
  assert.equal(report.ok, true);
  assert.deepEqual(report.combinations, { total: null, checked: 25, failed: 0, exhaustive: false });
  assert.deepEqual(JSON.parse(JSON.stringify(report)).combinations, report.combinations);
  assert.match(formatReport(report), /a sample of 25 different ones out of more than 2\^53/);
});

test('results depend on alpha only, so a colour shift in a layer does not change them', async () => {
  const run = async (shift) => {
    const { manifest, layers, load } = makeStyle();
    layers['hat/flat.png'] = layer([[3, 2, 10, 6, [200, 60, 60, 128]]]);
    layers['background/plain.png'].data.set([200, 200, 200, 128], 4);
    for (const raster of Object.values(layers)) {
      for (let i = 0; i < raster.data.length; i += 4) {
        raster.data[i] += shift;
        raster.data[i + 1] += shift;
        raster.data[i + 2] += shift;
      }
    }
    return checkManifest(manifest, load);
  };
  const exact = await run(0);
  assert.equal(exact.ok, false);
  assert.deepEqual(await run(4), exact);
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
