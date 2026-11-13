import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { compositeLayers } from '../src/composite.js';
import { readPng } from '../src/png.js';
import { middleSquare } from '../src/round-preview.js';
import {
  SWATCH_GROUP_ID,
  baseLayers,
  basePicture,
  canReset,
  choiceLabel,
  defaultSelection,
  resetState,
  swatchGroup,
  tabAfterKey,
  tabGroups,
} from '../src/builder-layout.js';
import { randomizeUnlocked, startingLocks } from '../src/locks.js';
import { resolveSelection } from '../src/manifest.js';
import { NONE_LABEL, THUMBNAIL_MAX_SIDE, thumbnailPicture, traitTiles } from '../src/thumbnails.js';

const readJson = async (path) => JSON.parse(await readFile(new URL(`../${path}`, import.meta.url), 'utf8'));

/** The alien's manifest. The tests read the JSON only, never its art. */
const alien = () => readJson('styles/alien/manifest.json');
const shapes = () => readJson('fixtures/shapes/manifest.json');

const ids = (groups) => groups.map((group) => group.id);

test('the background group goes in the swatch column and every other group with tiles is a tab', async () => {
  const manifest = await alien();
  assert.equal(SWATCH_GROUP_ID, 'background');
  assert.equal(swatchGroup(manifest).id, 'background');
  // Character has one option and no tiles, so it gets no tab.
  assert.deepEqual(ids(tabGroups(manifest)), ['clothes', 'mouth', 'eyes', 'eyewear', 'headwear']);
});

test('each group with tiles is in the column or in a tab, once, and no group without tiles is', async () => {
  for (const manifest of [await alien(), await shapes(), await readJson('fixtures/blocks/manifest.json')]) {
    const placed = [swatchGroup(manifest), ...tabGroups(manifest)].filter(Boolean).map((group) => group.id);
    const withTiles = manifest.groups.filter((group) => traitTiles(group).length > 0).map((group) => group.id);
    assert.deepEqual([...placed].sort(), [...withTiles].sort(), manifest.style);
    assert.equal(new Set(placed).size, placed.length, `${manifest.style}: no group twice`);
  }
});

test('a style without a background group, or with a background of one choice, has no swatch column', async () => {
  const manifest = await shapes();
  const renamed = structuredClone(manifest);
  renamed.groups[0].id = 'backdrop';
  assert.equal(swatchGroup(renamed), null);
  assert.ok(tabGroups(renamed).some((group) => group.id === 'backdrop'), 'the group is a tab instead');

  const single = structuredClone(manifest);
  single.groups[0].options = single.groups[0].options.slice(0, 1);
  assert.equal(swatchGroup(single), null);
  assert.ok(!tabGroups(single).some((group) => group.id === 'background'), 'nothing to pick, so no tab either');
});

test('the default selection is each group first tile: None for an optional group, the first option otherwise', async () => {
  const manifest = await alien();
  const selection = defaultSelection(manifest);
  assert.deepEqual(selection, {
    background: 'yellow',
    character: 'alien',
    clothes: 'default',
    mouth: 'default',
    eyes: 'default',
    eyewear: null,
    headwear: null,
  });
  for (const group of manifest.groups) {
    const tiles = traitTiles(group);
    if (tiles.length > 0) assert.equal(selection[group.id], tiles[0].choice, group.id);
  }
  // It is a selection the compositor takes.
  assert.ok(resolveSelection(manifest, selection).length > 0);
});

test('Reset gives each group its first tile and turns each Lock off', async () => {
  const manifest = await alien();
  assert.deepEqual(resetState(manifest), { selection: defaultSelection(manifest), locks: startingLocks(manifest) });
  assert.ok(Object.values(resetState(manifest).locks).every((locked) => locked === false));
});

test('Reset is off at the defaults and on after a pick or a Lock', async () => {
  const manifest = await alien();
  const { selection, locks } = resetState(manifest);
  assert.equal(canReset(manifest, selection, locks), false);
  assert.equal(canReset(manifest, { ...selection, mouth: 'grin' }, locks), true);
  assert.equal(canReset(manifest, { ...selection, headwear: 'cap' }, locks), true);
  assert.equal(canReset(manifest, selection, { ...locks, eyes: true }), true);
  // A selection read from the page leaves out nothing, and a missing optional group counts as None.
  const { eyewear, ...withoutEyewear } = selection;
  assert.equal(eyewear, null);
  assert.equal(canReset(manifest, withoutEyewear, locks), false);
});

test('Randomize keeps each locked group, and Reset afterwards puts everything back', async () => {
  const manifest = await alien();
  const start = resetState(manifest);
  const locks = { ...start.locks, mouth: true, background: true };
  const picked = { ...start.selection, mouth: 'grin', background: 'mint' };
  let draws = 0;
  const random = () => ((draws += 1) * 0.37) % 1;
  const next = randomizeUnlocked(manifest, picked, locks, random);
  assert.equal(next.mouth, 'grin');
  assert.equal(next.background, 'mint');
  assert.equal(next.character, 'alien');
  assert.equal(canReset(manifest, next, locks), true);
  assert.deepEqual(resetState(manifest).selection, start.selection);
});

test('the panel names each pick by its option label, and None for an empty optional group', async () => {
  const manifest = await alien();
  const clothes = manifest.groups.find((group) => group.id === 'clothes');
  const headwear = manifest.groups.find((group) => group.id === 'headwear');
  assert.equal(choiceLabel(clothes, 'hoodie'), clothes.options.find((option) => option.id === 'hoodie').label);
  assert.equal(choiceLabel(headwear, null), NONE_LABEL);
  assert.throws(() => choiceLabel(headwear, 'top-hat'), /no option "top-hat"/);
});

test('the arrow keys move along the tabs and wrap at the ends, and Home and End go to the ends', () => {
  assert.equal(tabAfterKey(0, 'ArrowRight', 5), 1);
  assert.equal(tabAfterKey(4, 'ArrowRight', 5), 0);
  assert.equal(tabAfterKey(0, 'ArrowLeft', 5), 4);
  assert.equal(tabAfterKey(3, 'ArrowLeft', 5), 2);
  assert.equal(tabAfterKey(2, 'Home', 5), 0);
  assert.equal(tabAfterKey(2, 'End', 5), 4);
  assert.equal(tabAfterKey(2, 'Enter', 5), null, 'a key the tablist does not use');
  assert.equal(tabAfterKey(0, 'ArrowRight', 0), null, 'no tabs');
  // Focus outside the tabs (-1) goes to the first one on ArrowRight.
  assert.equal(tabAfterKey(-1, 'ArrowRight', 5), 0);
});

test('a style tile in the character row shows the picture the style opens with', async () => {
  for (const name of ['shapes', 'blocks']) {
    const url = new URL(`../fixtures/${name}/manifest.json`, import.meta.url);
    const manifest = JSON.parse(await readFile(url, 'utf8'));
    const pixels = new Map();
    for (const group of manifest.groups) {
      for (const option of group.options) pixels.set(option.src, await readPng(new URL(option.src, url)));
    }
    const pixelsOf = (src) => pixels.get(src);
    // The layers of the default selection, bottom first.
    assert.deepEqual(baseLayers(manifest), resolveSelection(manifest, defaultSelection(manifest)));
    // The picture is compositeLayers over those layers, cut to its middle square.
    const { width, height } = manifest.canvas;
    const whole = compositeLayers(width, height, baseLayers(manifest).map(({ option }) => pixelsOf(option.src)));
    const picture = basePicture(manifest, pixelsOf);
    assert.deepEqual(picture, thumbnailPicture(whole, middleSquare(manifest.canvas)), name);
    assert.equal(picture.width, Math.min(width, height, THUMBNAIL_MAX_SIDE), name);
  }
});
