import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { compositeLayers, createRaster } from '../src/composite.js';
import { hasOneChoice, resolveSelection, validateManifest } from '../src/manifest.js';
import { readPng } from '../src/png.js';
import { scaleDown } from '../src/scale.js';
import {
  NONE_LABEL,
  NONE_VALUE,
  EDGE_DEPTHS,
  MAX_SHARE,
  THUMBNAIL_MAX_SIDE,
  THUMBNAIL_WIDTH,
  choiceFromValue,
  choiceValue,
  coversCanvas,
  createRedrawTracker,
  drawThumbnail,
  edgeDepth,
  layerBounds,
  pageChoice,
  thumbnailKey,
  thumbnailLayers,
  thumbnailPicture,
  thumbnailSelection,
  thumbnailSources,
  thumbnailSquare,
  traitTiles,
  unionBounds,
} from '../src/thumbnails.js';

const shapesUrl = new URL('../fixtures/shapes/manifest.json', import.meta.url);

async function loadShapes() {
  const manifest = JSON.parse(await readFile(shapesUrl, 'utf8'));
  const pixels = new Map();
  for (const group of manifest.groups) {
    for (const option of group.options) {
      pixels.set(option.src, await readPng(new URL(option.src, shapesUrl)));
    }
  }
  return { manifest, pixelsOf: (src) => pixels.get(src) };
}

/** The alien's manifest. The tests read the JSON only, never its art. */
async function loadAlienManifest() {
  return JSON.parse(await readFile(new URL('../styles/alien/manifest.json', import.meta.url), 'utf8'));
}

/**
 * The shapes fixture with `"over": ["eyes"]` on Headwear, and a cap that
 * comes down over the eyes. The other layers are the fixture's own.
 */
async function loadShapesWithOver() {
  const { manifest, pixelsOf } = await loadShapes();
  const withOver = structuredClone(manifest);
  group(withOver, 'headwear').over = ['eyes'];
  assert.deepEqual(validateManifest(withOver), { ok: true, errors: [] });
  const eyes = layerBounds(pixelsOf('layers/eyes/dots.png'));
  const lowCap = block(64, 64, { x: 12, y: 4, width: 40, height: eyes.y + eyes.height - 4 }, [10, 120, 10, 255]);
  return {
    plain: manifest,
    withOver,
    pixelsOf: (src) => (src === 'layers/headwear/cap.png' ? lowCap : pixelsOf(src)),
  };
}

const group = (manifest, id) => manifest.groups.find((item) => item.id === id);

const selection = { background: 'grey', body: 'round', eyes: 'dots', mouth: 'line', headwear: 'cap' };

/** A raster of one opaque colour inside a rectangle and see-through elsewhere. */
function block(width, height, rect, colour = [200, 10, 10, 255]) {
  const raster = createRaster(width, height);
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) raster.data.set(colour, (y * width + x) * 4);
  }
  return raster;
}

/** The square a thumbnail shows, cut out of a picture by hand. */
function cut(picture, { x, y, side }) {
  const out = createRaster(side, side);
  for (let row = 0; row < side; row += 1) {
    for (let column = 0; column < side; column += 1) {
      const from = ((y + row) * picture.width + x + column) * 4;
      out.data.set(picture.data.slice(from, from + 4), (row * side + column) * 4);
    }
  }
  return out;
}

test('each option gets one tile, with the option label as its name, in manifest order', async () => {
  const { manifest } = await loadShapes();
  for (const item of manifest.groups) {
    const tiles = traitTiles(item);
    const options = tiles.filter((tile) => tile.choice !== null);
    assert.deepEqual(
      options.map(({ choice, value, label }) => ({ choice, value, label })),
      item.options.map((option) => ({ choice: option.id, value: option.id, label: option.label })),
      item.id,
    );
  }
});

test('an optional group starts with a None tile and a required group has none', async () => {
  const { manifest } = await loadShapes();
  const hat = traitTiles(group(manifest, 'headwear'));
  assert.deepEqual(hat[0], { choice: null, value: NONE_VALUE, label: NONE_LABEL });
  assert.equal(hat.length, group(manifest, 'headwear').options.length + 1);
  assert.equal(hat.filter((tile) => tile.choice === null).length, 1);
  for (const id of ['background', 'body', 'eyes', 'mouth']) {
    assert.ok(traitTiles(group(manifest, id)).every((tile) => tile.choice !== null), id);
  }
});

test('the alien has a grid for six of its seven groups, Character has none, and Eyewear and Headwear start with None', async () => {
  const manifest = await loadAlienManifest();
  assert.deepEqual(
    manifest.groups.map((item) => item.label),
    ['Background', 'Character', 'Clothes', 'Mouth', 'Eyes', 'Eyewear', 'Headwear'],
  );
  for (const item of manifest.groups) {
    const tiles = traitTiles(item);
    if (item.id === 'character') {
      assert.deepEqual(tiles, [], 'one option and no None: no tiles');
      continue;
    }
    const startsWithNone = tiles[0].choice === null;
    assert.equal(startsWithNone, ['eyewear', 'headwear'].includes(item.id), item.id);
    assert.equal(tiles.length, item.options.length + (startsWithNone ? 1 : 0), item.id);
  }
});

test('a group with one option and no None gets no tiles, and an optional group with one option keeps both of its tiles', async () => {
  const { manifest } = await loadShapes();
  const one = { ...group(manifest, 'body'), options: [group(manifest, 'body').options[0]] };
  assert.equal(hasOneChoice(one), true);
  assert.deepEqual(traitTiles(one), []);
  const optional = { ...group(manifest, 'headwear'), options: [group(manifest, 'headwear').options[0]] };
  assert.equal(hasOneChoice(optional), false);
  assert.deepEqual(traitTiles(optional).map((tile) => tile.choice), [null, 'cap']);
  for (const item of manifest.groups) assert.equal(hasOneChoice(item), false, item.id);
});

test('pageChoice gives a one-choice group its option and every other group its picked tile', async () => {
  const { manifest } = await loadShapes();
  const one = { ...group(manifest, 'body'), options: [group(manifest, 'body').options[0]] };
  assert.equal(pageChoice(one, undefined), 'round', 'no tile, still the one option');
  assert.equal(pageChoice(group(manifest, 'eyes'), 'bars'), 'bars');
  assert.equal(pageChoice(group(manifest, 'headwear'), NONE_VALUE), null);
  assert.equal(pageChoice(group(manifest, 'eyes'), undefined), null);
});

test('a radio value turns back into the same choice', () => {
  for (const choice of [null, 'cap', 'x-3d-glasses']) {
    assert.equal(choiceFromValue(choiceValue(choice)), choice);
  }
  assert.equal(choiceValue(null), '');
});

test('layerBounds finds the drawn pixels and skips nearly see-through ones', () => {
  const raster = block(10, 8, { x: 2, y: 3, width: 4, height: 2 });
  raster.data.set([0, 0, 0, 15], (0 * 10 + 9) * 4); // under the alpha the render check counts as drawn
  assert.deepEqual(layerBounds(raster), { x: 2, y: 3, width: 4, height: 2 });
  assert.equal(layerBounds(createRaster(4, 4)), null, 'a blank layer has no bounds');
  assert.throws(() => layerBounds({ width: 2, height: 2, data: new Uint8Array(3) }), TypeError);
});

test('unionBounds covers each rectangle and skips nulls', () => {
  assert.deepEqual(
    unionBounds([{ x: 2, y: 5, width: 3, height: 3 }, null, { x: 6, y: 1, width: 2, height: 2 }]),
    { x: 2, y: 1, width: 6, height: 7 },
  );
  assert.equal(unionBounds([null, null]), null);
});

test('thumbnailSquare is centred on the layer, a bit bigger than it and inside the canvas', () => {
  const canvas = { width: 100, height: 100 };
  // A 20 x 10 rectangle: the square is 20 wide plus 2 px a side.
  assert.deepEqual(thumbnailSquare({ x: 40, y: 45, width: 20, height: 10 }, canvas), { x: 38, y: 38, side: 24 });
  // In the top left corner it stays inside the canvas.
  assert.deepEqual(thumbnailSquare({ x: 0, y: 0, width: 10, height: 10 }, canvas), { x: 0, y: 0, side: 12 });
  // Near the bottom right corner it moves in rather than leaving the canvas.
  assert.deepEqual(thumbnailSquare({ x: 85, y: 90, width: 14, height: 9 }, canvas), { x: 84, y: 84, side: 16 });
  // No drawn pixels: the middle square.
  assert.deepEqual(thumbnailSquare(null, { width: 100, height: 60 }), { x: 20, y: 0, side: 60 });
});

test('a layer bigger than MAX_SHARE of the canvas is zoomed in to that share, centred on it', () => {
  assert.equal(MAX_SHARE, 0.6);
  const canvas = { width: 1000, height: 1000 };
  // A wide hat, 700 x 300, away from the edges: 840 with room, cut to 600.
  assert.deepEqual(thumbnailSquare({ x: 150, y: 100, width: 700, height: 300 }, canvas), { x: 200, y: 0, side: 600 });
  // A tall party hat, 200 x 800: 960 with room, cut to 600 and centred on the hat.
  assert.deepEqual(thumbnailSquare({ x: 400, y: 100, width: 200, height: 800 }, canvas), { x: 200, y: 200, side: 600 });
});

test('the square is never smaller than the layer shorter side with room around it', () => {
  const canvas = { width: 1000, height: 1000 };
  // 900 x 700 away from the edges: 840 with room on the shorter side beats MAX_SHARE.
  assert.equal(thumbnailSquare({ x: 50, y: 150, width: 900, height: 700 }, canvas).side, 840);
  // A layer as big as the canvas gives the canvas, never more.
  assert.deepEqual(thumbnailSquare({ x: 0, y: 0, width: 1000, height: 1000 }, canvas), { x: 0, y: 0, side: 1000 });
  // Never more than the canvas shorter side.
  assert.equal(thumbnailSquare({ x: 0, y: 0, width: 120, height: 40 }, { width: 120, height: 40 }).side, 40);
});

test('a layer on an edge of the canvas, like a torso, gets a square EDGE_DEPTHS times as deep, on that edge', () => {
  assert.equal(EDGE_DEPTHS, 1.5);
  const canvas = { width: 1024, height: 1024 };
  // The alien's white tee: 606 x 265 at the bottom edge. 1.5 x 265 is 398, so the tile is the torso and the chin.
  const tee = { x: 165, y: 759, width: 606, height: 265 };
  assert.equal(edgeDepth(tee, canvas), 265);
  assert.deepEqual(thumbnailSquare(tee, canvas), { x: 269, y: 626, side: 398 });
  // The square sits on the bottom edge and keeps the torso inside it.
  const square = thumbnailSquare(tee, canvas);
  assert.equal(square.y + square.side, canvas.height);
  assert.ok(square.y <= tee.y);
  // A layer that touches no edge has no depth, and one on a side edge counts its width.
  assert.equal(edgeDepth({ x: 10, y: 10, width: 50, height: 50 }, canvas), Infinity);
  assert.equal(edgeDepth({ x: 0, y: 100, width: 80, height: 400 }, canvas), 80);
  assert.equal(edgeDepth({ x: 0, y: 0, width: 80, height: 40 }, canvas), 40);
});

test('the alien tiles zoom in on their layer: mouth, eyes, glasses and hats each fill most of the tile', () => {
  const canvas = { width: 1024, height: 1024 };
  // Bounds of the alien's layers, measured with layerBounds.
  const layers = {
    mouth: { x: 545, y: 617, width: 167, height: 97 },
    eyes: { x: 416, y: 427, width: 383, height: 119 },
    wayfarers: { x: 262, y: 384, width: 581, height: 206 },
    cap: { x: 204, y: 70, width: 676, height: 365 },
    crown: { x: 277, y: 105, width: 460, height: 226 },
  };
  for (const [name, bounds] of Object.entries(layers)) {
    const { side } = thumbnailSquare(bounds, canvas);
    assert.ok(side <= Math.round(1024 * MAX_SHARE), `${name} is zoomed in`);
    assert.ok(side >= bounds.height, `${name} keeps its height`);
  }
  // A pair of glasses keeps both lenses.
  assert.ok(thumbnailSquare(layers.wayfarers, canvas).side >= layers.wayfarers.width);
});

test('thumbnailPicture copies a small square and scales a big one down to the most a thumbnail holds', () => {
  const picture = block(300, 300, { x: 0, y: 0, width: 300, height: 300 });
  picture.data.set([1, 2, 3, 255], (5 * 300 + 7) * 4);
  const small = thumbnailPicture(picture, { x: 7, y: 5, side: 10 });
  assert.equal(small.width, 10);
  assert.deepEqual(Array.from(small.data.slice(0, 4)), [1, 2, 3, 255]);

  const big = thumbnailPicture(picture, { x: 0, y: 0, side: 300 });
  assert.equal(big.width, THUMBNAIL_MAX_SIDE);
  assert.deepEqual(big, scaleDown(picture, THUMBNAIL_MAX_SIDE, THUMBNAIL_MAX_SIDE, { x: 0, y: 0, width: 300, height: 300 }));
  assert.equal(THUMBNAIL_MAX_SIDE, THUMBNAIL_WIDTH * 2);
});

test('a thumbnail is the picture with that option, cut to a square around its layer', async () => {
  const { manifest, pixelsOf } = await loadShapes();
  const mouth = group(manifest, 'mouth');
  for (const option of mouth.options) {
    const thumbnail = drawThumbnail({ manifest, selection, group: mouth, choice: option.id, pixelsOf });
    const swapped = thumbnailSelection(selection, 'mouth', option.id);
    const picture = compositeLayers(
      64,
      64,
      resolveSelection(manifest, swapped).map((layer) => pixelsOf(layer.option.src)),
    );
    const square = thumbnailSquare(layerBounds(pixelsOf(option.src)), manifest.canvas);
    assert.deepEqual(thumbnail, cut(picture, square), option.id);
    // The square holds the whole mouth and stays smaller than the picture.
    const own = layerBounds(pixelsOf(option.src));
    assert.ok(square.x <= own.x && square.x + square.side >= own.x + own.width, option.id);
    assert.ok(square.y <= own.y && square.y + square.side >= own.y + own.height, option.id);
    assert.ok(square.side < 64, option.id);
  }
});

test('the two options of a group give two different thumbnails, drawn on the current picture', async () => {
  const { manifest, pixelsOf } = await loadShapes();
  const eyes = group(manifest, 'eyes');
  const draw = (choice, current = selection) => drawThumbnail({ manifest, selection: current, group: eyes, choice, pixelsOf });
  assert.notDeepEqual(draw('dots'), draw('bars'));
  // The other groups come from the current picture: another body shows under the same eyes.
  assert.notDeepEqual(draw('dots'), draw('dots', { ...selection, background: 'blue' }));
});

test('a background thumbnail is the flat colour of its layer', async () => {
  const { manifest, pixelsOf } = await loadShapes();
  const background = group(manifest, 'background');
  for (const option of background.options) {
    const layer = pixelsOf(option.src);
    assert.ok(coversCanvas(layerBounds(layer), manifest.canvas), `${option.id} covers the canvas`);
    const thumbnail = drawThumbnail({ manifest, selection, group: background, choice: option.id, pixelsOf });
    const colour = Array.from(layer.data.slice(0, 4));
    for (let i = 0; i < thumbnail.data.length; i += 4) {
      assert.deepEqual(Array.from(thumbnail.data.slice(i, i + 4)), colour, `${option.id} pixel ${i / 4}`);
    }
  }
});

test('the None tile shows the picture without the group, around where its options draw', async () => {
  const { manifest, pixelsOf } = await loadShapes();
  const headwear = group(manifest, 'headwear');
  const thumbnail = drawThumbnail({ manifest, selection, group: headwear, choice: null, pixelsOf });
  const picture = compositeLayers(
    64,
    64,
    resolveSelection(manifest, { ...selection, headwear: null }).map((layer) => pixelsOf(layer.option.src)),
  );
  const area = unionBounds(headwear.options.map((option) => layerBounds(pixelsOf(option.src))));
  assert.deepEqual(thumbnail, cut(picture, thumbnailSquare(area, manifest.canvas)));
  // It is not the cap's thumbnail.
  assert.notDeepEqual(thumbnail, drawThumbnail({ manifest, selection, group: headwear, choice: 'cap', pixelsOf }));
});

test('a thumbnail of a big canvas is scaled down to the most a thumbnail holds', () => {
  const manifest = {
    version: 1,
    style: 'big',
    name: 'Big',
    canvas: { width: 1024, height: 1024 },
    groups: [
      { id: 'background', label: 'Background', base: true, options: [{ id: 'red', label: 'Red', src: 'bg.png' }] },
      { id: 'hat', label: 'Hat', optional: true, options: [{ id: 'top', label: 'Top hat', src: 'hat.png' }] },
    ],
  };
  const layers = {
    'bg.png': block(1024, 1024, { x: 0, y: 0, width: 1024, height: 1024 }, [255, 0, 0, 255]),
    'hat.png': block(1024, 1024, { x: 312, y: 40, width: 400, height: 300 }, [0, 0, 255, 255]),
  };
  const pixelsOf = (src) => layers[src];
  const hat = drawThumbnail({ manifest, selection: { background: 'red', hat: null }, group: manifest.groups[1], choice: 'top', pixelsOf });
  assert.equal(hat.width, THUMBNAIL_MAX_SIDE);
  assert.equal(hat.height, THUMBNAIL_MAX_SIDE);
  // The middle of the thumbnail is the hat.
  const middle = ((THUMBNAIL_MAX_SIDE / 2) * THUMBNAIL_MAX_SIDE + THUMBNAIL_MAX_SIDE / 2) * 4;
  assert.deepEqual(Array.from(hat.data.slice(middle, middle + 4)), [0, 0, 255, 255]);
  const red = drawThumbnail({ manifest, selection: { background: 'red', hat: 'top' }, group: manifest.groups[0], choice: 'red', pixelsOf });
  assert.equal(red.width, THUMBNAIL_MAX_SIDE);
  assert.ok(Array.from({ length: red.data.length / 4 }, (_, i) => red.data[i * 4 + 2]).every((blue) => blue === 0), 'no hat on the background tile');
});

test('an option whose layer draws nothing shows the middle of the picture', async () => {
  const { manifest, pixelsOf } = await loadShapes();
  const blank = createRaster(64, 64);
  const withBlank = (src) => (src === 'layers/headwear/cap.png' ? blank : pixelsOf(src));
  const thumbnail = drawThumbnail({ manifest, selection, group: group(manifest, 'headwear'), choice: 'cap', pixelsOf: withBlank });
  assert.equal(thumbnail.width, 64);
});

test('an unknown option is refused', async () => {
  const { manifest, pixelsOf } = await loadShapes();
  assert.throws(() => drawThumbnail({ manifest, selection, group: group(manifest, 'eyes'), choice: 'nope', pixelsOf }), /no option "nope"/);
});

test('a group whose own pick changes keeps its thumbnails, and a change elsewhere redraws them', async () => {
  const { manifest } = await loadShapes();
  const key = (current, id) => thumbnailKey(manifest, current, id);
  assert.equal(key(selection, 'eyes'), key({ ...selection, eyes: 'bars' }, 'eyes'));
  assert.notEqual(key(selection, 'eyes'), key({ ...selection, mouth: 'open' }, 'eyes'));
  assert.notEqual(key(selection, 'eyes'), key({ ...selection, headwear: null }, 'eyes'));
});

test('a redraw that stops halfway is redrawn, also when the picks go back to the ones before', () => {
  const redraws = createRedrawTracker();
  assert.ok(redraws.needsRedraw('eyes', 'K0'), 'nothing is drawn at first');
  redraws.start('eyes');
  redraws.finish('eyes', 'K0');
  assert.equal(redraws.needsRedraw('eyes', 'K0'), false);
  // A redraw for K1 paints some tiles and stops before the last one.
  assert.ok(redraws.needsRedraw('eyes', 'K1'));
  redraws.start('eyes');
  // The user goes back to the picks of K0. Each tile is redrawn, not skipped.
  assert.ok(redraws.needsRedraw('eyes', 'K0'));
  assert.ok(redraws.needsRedraw('eyes', 'K1'));
  // A group's key leaves the other groups alone.
  redraws.finish('mouth', 'M0');
  assert.equal(redraws.needsRedraw('mouth', 'M0'), false);
});

test('thumbnailSources lists the other layers on screen and each option of the group', async () => {
  const { manifest } = await loadShapes();
  const sources = thumbnailSources(manifest, { ...selection, headwear: null }, group(manifest, 'eyes'));
  assert.deepEqual(sources.sort(), [
    'layers/background/grey.png',
    'layers/body/round.png',
    'layers/eyes/bars.png',
    'layers/eyes/dots.png',
    'layers/mouth/line.png',
  ]);
});

test('a tile leaves out the layers of each group whose over list names its group, with the tile option in place of the pick', async () => {
  const { withOver } = await loadShapesWithOver();
  const ids = (layers) => layers.map((layer) => `${layer.group.id}:${layer.option.id}`);
  assert.deepEqual(ids(thumbnailLayers(withOver, selection, 'eyes', 'bars')), [
    'background:grey',
    'body:round',
    'eyes:bars',
    'mouth:line',
  ]);
  // A group that no over list names keeps every picked layer, the hat included.
  assert.deepEqual(ids(thumbnailLayers(withOver, selection, 'mouth', 'open')), [
    'background:grey',
    'body:round',
    'eyes:dots',
    'mouth:open',
    'headwear:cap',
  ]);
  // The hat's own tiles still show the hat, and its None tile shows no hat.
  assert.ok(ids(thumbnailLayers(withOver, selection, 'headwear', 'tall')).includes('headwear:tall'));
  assert.ok(!ids(thumbnailLayers(withOver, selection, 'headwear', null)).some((id) => id.startsWith('headwear')));
});

test('an Eyes thumbnail under a hat with over: ["eyes"] shows the eyes and no hat', async () => {
  const { plain, withOver, pixelsOf } = await loadShapesWithOver();
  const draw = (manifest, current) =>
    drawThumbnail({ manifest, selection: current, group: group(manifest, 'eyes'), choice: 'bars', pixelsOf });
  const noHat = draw(plain, { ...selection, headwear: null });
  // Without over the low cap covers the eyes on the tile.
  assert.notDeepEqual(draw(plain, selection), noHat);
  // With over the tile is the picture with no hat, whichever hat is picked.
  assert.deepEqual(draw(withOver, selection), noHat);
  assert.deepEqual(draw(withOver, { ...selection, headwear: 'tall' }), noHat);
  // The Mouth tile still draws the hat, since no over list names Mouth.
  const mouth = (manifest) => drawThumbnail({ manifest, selection, group: group(manifest, 'mouth'), choice: 'line', pixelsOf });
  assert.deepEqual(mouth(withOver), mouth(plain));
});

test('the main preview and the download still draw every picked layer of a style with over', async () => {
  const { plain, withOver, pixelsOf } = await loadShapesWithOver();
  const layers = resolveSelection(withOver, selection);
  assert.deepEqual(
    layers.map((layer) => layer.group.id),
    ['background', 'body', 'eyes', 'mouth', 'headwear'],
  );
  const picture = (manifest) => compositeLayers(64, 64, resolveSelection(manifest, selection).map((layer) => pixelsOf(layer.option.src)));
  // The over entry changes nothing in the picture: the hat is still on top of the eyes.
  assert.deepEqual(picture(withOver), picture(plain));
  const eyes = layerBounds(pixelsOf('layers/eyes/dots.png'));
  const capPixel = (eyes.y * 64 + eyes.x) * 4;
  assert.deepEqual(Array.from(picture(withOver).data.slice(capPixel, capPixel + 4)), [10, 120, 10, 255]);
});

test('the alien Eyes tiles leave out Eyewear and Headwear, and its Eyewear tiles leave out Headwear', async () => {
  const manifest = await loadAlienManifest();
  const firsts = Object.fromEntries(manifest.groups.map((item) => [item.id, item.options[0].id]));
  const groupsOf = (groupId) =>
    thumbnailLayers(manifest, firsts, groupId, group(manifest, groupId).options[1].id).map((layer) => layer.group.id);
  assert.deepEqual(groupsOf('eyes'), ['background', 'character', 'clothes', 'mouth', 'eyes']);
  assert.deepEqual(groupsOf('eyewear'), ['background', 'character', 'clothes', 'mouth', 'eyes', 'eyewear']);
  assert.deepEqual(groupsOf('mouth'), manifest.groups.map((item) => item.id));
});

test('a change in a group drawn over another leaves that group thumbnails as they are', async () => {
  const { withOver } = await loadShapesWithOver();
  const key = (current, id) => thumbnailKey(withOver, current, id);
  assert.equal(key(selection, 'eyes'), key({ ...selection, headwear: 'tall' }, 'eyes'));
  assert.equal(key(selection, 'eyes'), key({ ...selection, headwear: null }, 'eyes'));
  assert.notEqual(key(selection, 'mouth'), key({ ...selection, headwear: 'tall' }, 'mouth'));
  const sources = thumbnailSources(withOver, selection, group(withOver, 'eyes'));
  assert.ok(!sources.includes('layers/headwear/cap.png'), 'the eyes tiles load no hat');
});

test('the thumbnail size in web/builder.css is THUMBNAIL_WIDTH', async () => {
  const css = await readFile(new URL('../web/builder.css', import.meta.url), 'utf8');
  assert.match(css, new RegExp(`--thumbnail:\\s*${THUMBNAIL_WIDTH}px;`));
});
