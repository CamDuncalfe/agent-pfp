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
  CHARACTER_TAB,
  COMING_SOON_TAG,
  characterKeyMove,
  characterPick,
  characterTabOpens,
  characterTiles,
  BASE_POLL_MS,
  BASE_WAIT_LIMIT_MS,
  mayDrawBase,
  reusesThumbnailLayers,
  canReset,
  choiceLabel,
  defaultSelection,
  focusAfterReset,
  resetState,
  swatchGroup,
  tabAfterFailedStyle,
  tabAfterKey,
  tabGroups,
  tabToOpen,
} from '../src/builder-layout.js';
import { canRandomize, randomizeUnlocked, startingLocks } from '../src/locks.js';
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
  // Alt, Control or Meta with a key is a browser shortcut: Alt and Left goes back a page.
  for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) assert.equal(tabAfterKey(2, key, 5, true), null, key);
  assert.equal(tabAfterKey(2, 'ArrowLeft', 5, false), 1);
  // Focus outside the tabs (-1) goes to the first one on ArrowRight.
  assert.equal(tabAfterKey(-1, 'ArrowRight', 5), 0);
});

test('a style tile in the Character tab shows the picture the style opens with', async () => {
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

test('a character picture composites only while no trait thumbnail request is running or waiting', () => {
  assert.equal(mayDrawBase({ running: false, waiting: 0 }), true);
  assert.equal(mayDrawBase({ running: true, waiting: 0 }), false, 'a trait group is being drawn');
  assert.equal(mayDrawBase({ running: false, waiting: 1 }), false, 'a trait request is queued');
  assert.equal(mayDrawBase({ running: true, waiting: 3 }), false);
});

test('a character picture that has waited the limit draws anyway, so its tile never stays blank', () => {
  // Well past the two seconds or so the alien's first trait thumbnails take, so those still come first when a style opens.
  assert.equal(BASE_WAIT_LIMIT_MS, 8000);
  // Under the limit it still waits for the trait thumbnails.
  assert.equal(mayDrawBase({ running: true, waiting: 2, waitedMs: 0 }), false);
  assert.equal(mayDrawBase({ running: true, waiting: 0, waitedMs: BASE_WAIT_LIMIT_MS - 1 }), false);
  // At the limit it draws, whatever the trait loop is doing.
  assert.equal(mayDrawBase({ running: true, waiting: 0, waitedMs: BASE_WAIT_LIMIT_MS }), true);
  assert.equal(mayDrawBase({ running: false, waiting: 5, waitedMs: BASE_WAIT_LIMIT_MS + 300 }), true);
  // With nothing to wait for, how long it waited makes no difference.
  assert.equal(mayDrawBase({ running: false, waiting: 0, waitedMs: 0 }), true);
  // The worker sleeps between two looks, and gets many looks in before the limit.
  assert.ok(BASE_POLL_MS >= 16, 'no tight loop');
  assert.ok(BASE_WAIT_LIMIT_MS / BASE_POLL_MS >= 10);
});

test('a character picture reuses the thumbnails layers only for the style the thumbnails show', () => {
  const alien = 'https://example.test/styles/alien/manifest.json';
  const shapes = 'https://example.test/fixtures/shapes/manifest.json';
  assert.equal(reusesThumbnailLayers(alien, alien), true);
  assert.equal(reusesThumbnailLayers(alien, shapes), false, 'another style loads its own layers');
  assert.equal(reusesThumbnailLayers(null, alien), false, 'no thumbnails drawn yet');
});

test('the Character tab opens first only when there is a choice, and stays open after a switch', () => {
  // The page opens on the first trait tab when there is one character, and on the Character tab when there are more.
  assert.equal(characterTabOpens({ styleCount: 1, firstStyle: true }), false);
  assert.equal(characterTabOpens({ styleCount: 2, firstStyle: true }), true);
  assert.equal(characterTabOpens({ styleCount: 12, firstStyle: true }), true);
  // A switch comes from the Character tab, so the tab stays open for the next pick.
  assert.equal(characterTabOpens({ styleCount: 1, firstStyle: false }), true);
  assert.equal(characterTabOpens({ styleCount: 12, firstStyle: false }), true);
});

test('with the alien and eleven coming-soon characters the page still opens on the first trait tab', async () => {
  const index = await readJson('styles/index.json');
  const tiles = characterTiles(index.styles, index.comingSoon);
  assert.equal(tiles.length, 12);
  // Only a style counts as a character to pick from.
  const styleCount = tiles.filter((tile) => !tile.comingSoon).length;
  assert.equal(styleCount, 1);
  assert.equal(characterTabOpens({ styleCount, firstStyle: true }), false);
});

test('the Character tab shows each style, then each coming-soon character, in index order', async () => {
  const index = await readJson('styles/index.json');
  const tiles = characterTiles(index.styles, index.comingSoon);
  assert.deepEqual(
    tiles.map((tile) => tile.name),
    ['Alien', 'Bear', 'Fox', 'Cat', 'Duck', 'Penguin', 'Raccoon', 'Owl', 'Rabbit', 'Frog', 'Skeleton', 'Cyclops'],
  );
  assert.deepEqual(tiles[0], { id: 'alien', name: 'Alien', comingSoon: false, style: index.styles[0] });
  assert.deepEqual(tiles[1], { id: 'bear', name: 'Bear', comingSoon: true, picture: 'styles/coming-soon/bear.png' });
  // A coming-soon tile carries a picture and no style: nothing on it names a manifest.
  for (const tile of tiles.slice(1)) {
    assert.equal(tile.comingSoon, true, tile.id);
    assert.deepEqual(Object.keys(tile).sort(), ['comingSoon', 'id', 'name', 'picture'], tile.id);
  }
  assert.deepEqual(characterTiles(index.styles, []), [tiles[0]]);
});

test('a style takes the place of the coming-soon tile with its id', () => {
  const alien = { id: 'alien', name: 'Alien', manifest: 'styles/alien/manifest.json' };
  const bear = { id: 'bear', name: 'Bear (local)', manifest: 'local-styles/bear/manifest.json', local: true };
  const coming = [
    { id: 'bear', name: 'Bear', picture: 'styles/coming-soon/bear.png' },
    { id: 'fox', name: 'Fox', picture: 'styles/coming-soon/fox.png' },
  ];
  assert.deepEqual(characterTiles([alien, bear], coming), [
    { id: 'alien', name: 'Alien', comingSoon: false, style: alien },
    { id: 'bear', name: 'Bear (local)', comingSoon: false, style: bear },
    { id: 'fox', name: 'Fox', comingSoon: true, picture: 'styles/coming-soon/fox.png' },
  ]);
});

test('the tag on a coming-soon tile is sentence case', () => {
  assert.equal(COMING_SOON_TAG, 'Coming soon');
});

test('the arrow keys walk each character tile and never pick a coming-soon one', () => {
  const tiles = [{ comingSoon: false }, { comingSoon: true }, { comingSoon: true }, { comingSoon: false }];
  // Right and Down go on, Left and Up go back, and both wrap.
  assert.deepEqual(characterKeyMove(tiles, 0, 'ArrowRight'), { index: 1, pick: false });
  assert.deepEqual(characterKeyMove(tiles, 1, 'ArrowDown'), { index: 2, pick: false });
  assert.deepEqual(characterKeyMove(tiles, 2, 'ArrowRight'), { index: 3, pick: true });
  assert.deepEqual(characterKeyMove(tiles, 3, 'ArrowRight'), { index: 0, pick: true });
  assert.deepEqual(characterKeyMove(tiles, 0, 'ArrowLeft'), { index: 3, pick: true });
  assert.deepEqual(characterKeyMove(tiles, 3, 'ArrowUp'), { index: 2, pick: false });
  // Any other key is the browser's, and so is a key pressed with no tile in focus.
  for (const key of [' ', 'Enter', 'Tab', 'Home', 'End', 'a']) assert.equal(characterKeyMove(tiles, 0, key), null, key);
  // Alt, Control or Meta with an arrow is a browser shortcut, like going back a page.
  assert.equal(characterKeyMove(tiles, 0, 'ArrowLeft', true), null);
  assert.deepEqual(characterKeyMove(tiles, 0, 'ArrowLeft', false), { index: 3, pick: true });
  assert.equal(characterKeyMove(tiles, -1, 'ArrowRight'), null);
  assert.equal(characterKeyMove(tiles, 4, 'ArrowRight'), null);
  assert.equal(characterKeyMove([], 0, 'ArrowRight'), null);
  // With one style, the pick never leaves it: every other tile it reaches is coming soon.
  const live = [{ comingSoon: false }, ...Array.from({ length: 11 }, () => ({ comingSoon: true }))];
  let at = 0;
  for (let step = 0; step < 11; step += 1) {
    const move = characterKeyMove(live, at, 'ArrowRight');
    assert.equal(move.pick, false, `step ${step}`);
    at = move.index;
  }
  assert.deepEqual(characterKeyMove(live, at, 'ArrowRight'), { index: 0, pick: true });
});

test('Randomize and Reset work from the manifest of the style on screen, which names no coming-soon character', async () => {
  const index = await readJson('styles/index.json');
  const manifest = await alien();
  const comingIds = index.comingSoon.map((entry) => entry.id);
  const optionIds = manifest.groups.flatMap((group) => [group.id, ...group.options.map((option) => option.id)]);
  for (const id of comingIds) assert.ok(!optionIds.includes(id), id);
  // Neither Reset nor Randomize gives back a group or a choice that is a coming-soon character.
  const reset = resetState(manifest);
  const random = randomizeUnlocked(manifest, reset.selection, reset.locks, () => 0.99);
  for (const selection of [reset.selection, random]) {
    for (const [groupId, choice] of Object.entries(selection)) {
      assert.ok(!comingIds.includes(groupId), groupId);
      assert.ok(!comingIds.includes(choice), String(choice));
    }
  }
});

test('the tab that opens with a style is Character or the first trait tab, and Character when it is the only tab', () => {
  assert.equal(CHARACTER_TAB, 0);
  // The alien alone, with its five trait tabs: the first trait tab, the one after Character.
  assert.equal(tabToOpen({ styleCount: 1, firstStyle: true, tabCount: 6 }), 1);
  // More than one style to pick, or a switch from the Character tab: Character.
  assert.equal(tabToOpen({ styleCount: 2, firstStyle: true, tabCount: 6 }), 0);
  assert.equal(tabToOpen({ styleCount: 1, firstStyle: false, tabCount: 6 }), 0);
  // A style with no trait tab has the Character tab alone, so it opens whatever characterTabOpens says.
  assert.equal(tabToOpen({ styleCount: 1, firstStyle: true, tabCount: 1 }), 0);
  assert.equal(tabToOpen({ styleCount: 4, firstStyle: false, tabCount: 1 }), 0);
  // It agrees with characterTabOpens for each state with a trait tab.
  for (const styleCount of [1, 2, 12]) {
    for (const firstStyle of [true, false]) {
      assert.equal(tabToOpen({ styleCount, firstStyle, tabCount: 2 }), characterTabOpens({ styleCount, firstStyle }) ? 0 : 1);
    }
  }
});

test('after a style that failed to load the Character tab opens, so another style can be picked', () => {
  assert.equal(tabAfterFailedStyle(), CHARACTER_TAB);
});

test('the Character tab checks the tile of the style asked for, and no tile after it failed to load', () => {
  const entry = { id: 'alien', name: 'Alien', manifest: 'styles/alien/manifest.json' };
  // While it loads and while it is on screen: its tile, and its name beside the heading.
  assert.deepEqual(characterPick(entry, false), { id: 'alien', name: 'Alien' });
  // After a failed load nothing is the pick, so the failed tile can be picked again.
  assert.deepEqual(characterPick(entry, true), { id: null, name: '' });
  // A local style keeps the name its tile shows.
  assert.deepEqual(characterPick({ id: 'bear', name: 'Bear (local)' }, false), { id: 'bear', name: 'Bear (local)' });
});

test('the focus goes from Reset to Randomize when Reset turns itself off under it', () => {
  // Reset had the focus and the reset turned it off: Randomize takes the focus.
  assert.equal(focusAfterReset({ resetHadFocus: true, resetDisabled: true, randomizeDisabled: false }), 'randomize');
  // The focus was somewhere else, so it stays there.
  assert.equal(focusAfterReset({ resetHadFocus: false, resetDisabled: true, randomizeDisabled: false }), null);
  // Reset is still on, so it keeps the focus.
  assert.equal(focusAfterReset({ resetHadFocus: true, resetDisabled: false, randomizeDisabled: false }), null);
  // A button that is off can't take the focus.
  assert.equal(focusAfterReset({ resetHadFocus: true, resetDisabled: true, randomizeDisabled: true }), null);
});

test('after Reset on the alien, Reset is off and Randomize is on, so the focus has somewhere to go', async () => {
  const manifest = await alien();
  const { selection, locks } = resetState(manifest);
  assert.equal(canReset(manifest, selection, locks), false);
  assert.equal(canRandomize(manifest, locks), true);
});
