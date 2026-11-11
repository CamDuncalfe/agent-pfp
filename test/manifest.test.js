import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  validateManifest,
  groupChoices,
  resolveSelection,
  randomSelection,
  isSafeRelativePath,
} from '../src/manifest.js';

async function loadShapes() {
  const url = new URL('../fixtures/shapes/manifest.json', import.meta.url);
  return JSON.parse(await readFile(url, 'utf8'));
}

test('the fixture manifest is valid', async () => {
  const result = validateManifest(await loadShapes());
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test('a manifest that is not an object is rejected', () => {
  for (const value of [null, [], 'text', 3]) {
    assert.equal(validateManifest(value).ok, false);
  }
});

test('version, style, name and canvas are checked', async () => {
  const manifest = await loadShapes();
  manifest.version = 2;
  manifest.style = 'Not An Id';
  manifest.name = ' ';
  manifest.canvas = { width: 0, height: 64 };
  const { errors } = validateManifest(manifest);
  assert.equal(errors.length, 4);
});

test('duplicate group and option ids are reported', async () => {
  const manifest = await loadShapes();
  manifest.groups[1].id = 'background';
  manifest.groups[2].options[1].id = 'dots';
  const { errors } = validateManifest(manifest);
  assert.ok(errors.some((error) => error.includes('"background" is used twice')));
  assert.ok(errors.some((error) => error.includes('"dots" is used twice')));
});

test('a zone has to fit inside the canvas', async () => {
  const manifest = await loadShapes();
  manifest.groups[2].zone = { x: 40, y: 24, width: 28, height: 8 };
  const { errors } = validateManifest(manifest);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /outside the 64x64 canvas/);
});

test('"over" can only name a group drawn earlier', async () => {
  const manifest = await loadShapes();
  manifest.groups[2].over = ['headwear'];
  assert.equal(validateManifest(manifest).ok, false);
  manifest.groups[2].over = [];
  manifest.groups[4].over = ['eyes'];
  assert.equal(validateManifest(manifest).ok, true);
});

test('bleed only accepts the four edges', async () => {
  const manifest = await loadShapes();
  manifest.groups[1].bleed = ['bottom', 'sideways'];
  assert.equal(validateManifest(manifest).ok, false);
});

test('layer paths cannot leave the style folder', () => {
  assert.equal(isSafeRelativePath('layers/eyes/dots.png'), true);
  for (const src of ['../secret.png', '/etc/passwd', 'a//b.png', './a.png', 'https://x.test/a.png', 'a\\b.png', 'a.png?x=1', '', 5]) {
    assert.equal(isSafeRelativePath(src), false, String(src));
  }
});

test('an optional group offers an empty choice first', async () => {
  const manifest = await loadShapes();
  assert.deepEqual(groupChoices(manifest.groups[4]), [null, 'cap', 'tall']);
  assert.deepEqual(groupChoices(manifest.groups[0]), ['grey', 'blue']);
});

test('resolveSelection returns layers in draw order', async () => {
  const manifest = await loadShapes();
  const layers = resolveSelection(manifest, {
    headwear: 'cap',
    mouth: 'line',
    eyes: 'dots',
    body: 'round',
    background: 'blue',
  });
  assert.deepEqual(
    layers.map((layer) => layer.option.src),
    [
      'layers/background/blue.png',
      'layers/body/round.png',
      'layers/eyes/dots.png',
      'layers/mouth/line.png',
      'layers/headwear/cap.png',
    ],
  );
});

test('resolveSelection skips an empty optional group and rejects bad picks', async () => {
  const manifest = await loadShapes();
  const base = { background: 'grey', body: 'round', eyes: 'dots', mouth: 'line' };
  assert.equal(resolveSelection(manifest, base).length, 4);
  assert.equal(resolveSelection(manifest, { ...base, headwear: null }).length, 4);
  assert.throws(() => resolveSelection(manifest, { ...base, eyes: null }), /needs an option/);
  assert.throws(() => resolveSelection(manifest, { ...base, eyes: 'lasers' }), /no option "lasers"/);
  assert.throws(() => resolveSelection(manifest, { ...base, tail: 'long' }), /unknown group "tail"/);
});

test('randomSelection always resolves, including at the ends of the range', async () => {
  const manifest = await loadShapes();
  for (const value of [0, 0.5, 0.999999, 1]) {
    const selection = randomSelection(manifest, () => value);
    assert.doesNotThrow(() => resolveSelection(manifest, selection));
  }
  assert.equal(randomSelection(manifest, () => 0).headwear, null);
  assert.equal(randomSelection(manifest, () => 0.999).headwear, 'tall');
});
