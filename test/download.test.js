import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { compositeLayers, createRaster } from '../src/composite.js';
import {
  DOWNLOAD_SIZES,
  FULL_SIZE,
  GITHUB_SIZE,
  chooseSize,
  downloadFileName,
  pictureToSave,
  planDownload,
  sizePicker,
  sizePickerShown,
  sizesFor,
} from '../src/download.js';
import { readPng, writePng } from '../src/png.js';

const fixture = async (name) =>
  JSON.parse(await readFile(new URL(`../fixtures/${name}/manifest.json`, import.meta.url), 'utf8'));

const ids = (sizes) => sizes.map((size) => size.id);

function solid(width, height, colour) {
  const raster = createRaster(width, height);
  for (let i = 0; i < raster.data.length; i += 4) raster.data.set(colour, i);
  return raster;
}

/** A style like the real ones: a square 1024 px canvas. */
const big = { style: 'big-style', canvas: { width: 1024, height: 1024 } };

test('Full size is the first size and GitHub is 500 px', () => {
  assert.equal(DOWNLOAD_SIZES[0], FULL_SIZE);
  assert.deepEqual(ids(DOWNLOAD_SIZES), ['full', 'github']);
  assert.equal(FULL_SIZE.label, 'Full size');
  assert.equal(GITHUB_SIZE.label, 'GitHub (500 x 500)');
  assert.equal(GITHUB_SIZE.side, 500);
});

test('a square canvas of 500 px or more offers Full size and GitHub', () => {
  for (const side of [500, 501, 1024, 4096]) {
    assert.deepEqual(ids(sizesFor({ width: side, height: side })), ['full', 'github'], `${side} px`);
  }
});

test('a canvas that is not square or is under 500 px offers Full size only', () => {
  for (const [width, height] of [[499, 499], [64, 64], [96, 64], [1024, 500], [500, 1024], [1024, 1023]]) {
    assert.deepEqual(ids(sizesFor({ width, height })), ['full'], `${width}x${height}`);
  }
});

test('both fixture styles offer Full size only', async () => {
  for (const name of ['shapes', 'blocks']) {
    const manifest = await fixture(name);
    assert.deepEqual(ids(sizesFor(manifest.canvas)), ['full'], name);
    assert.deepEqual(sizePicker(manifest.canvas, 'github'), {
      options: [{ id: 'full', label: 'Full size' }],
      value: 'full',
      shown: false,
    });
  }
});

test('the picker lists Full size first and starts on it', () => {
  // Before the first style opens no size is picked.
  for (const before of ['full', '', undefined, null]) {
    assert.deepEqual(sizePicker(big.canvas, before), {
      options: [
        { id: 'full', label: 'Full size' },
        { id: 'github', label: 'GitHub (500 x 500)' },
      ],
      value: 'full',
      shown: true,
    });
  }
});

test('the picker is on screen only for a style on screen that offers more than one size', () => {
  // No style on screen: one is loading, or one failed to load.
  assert.equal(sizePickerShown(null), false);
  assert.equal(sizePickerShown(big.canvas), true);
  for (const [width, height] of [[499, 499], [64, 64], [96, 64], [1024, 500]]) {
    assert.equal(sizePickerShown({ width, height }), false, `${width}x${height}`);
  }
  // sizePicker reports the same answer for the style it lists.
  for (const canvas of [big.canvas, { width: 64, height: 64 }, { width: 96, height: 64 }]) {
    assert.equal(sizePicker(canvas, 'github').shown, sizePickerShown(canvas));
  }
});

test('switching style keeps a pick the new style offers and goes back to Full size otherwise', () => {
  assert.equal(sizePicker({ width: 2048, height: 2048 }, 'github').value, 'github');
  assert.equal(sizePicker({ width: 64, height: 64 }, 'github').value, 'full');
  assert.equal(sizePicker({ width: 96, height: 64 }, 'github').value, 'full');
  assert.equal(sizePicker({ width: 1024, height: 1024 }, 'full').value, 'full');
});

test('a size the page does not know is treated as Full size', () => {
  for (const picked of ['slack', '500', 'GITHUB', '', null, undefined, 500, {}]) {
    assert.equal(chooseSize(big.canvas, picked), FULL_SIZE);
    const plan = planDownload(big, picked);
    assert.equal(plan.fileName, 'agent-pfp-big-style.png');
    assert.equal(plan.scaled, false);
  }
});

test('a known size the canvas does not offer is treated as Full size', async () => {
  const manifest = await fixture('blocks');
  assert.deepEqual(planDownload(manifest, 'github'), {
    size: FULL_SIZE,
    width: 96,
    height: 64,
    fileName: 'agent-pfp-fixture-blocks.png',
    scaled: false,
  });
});

test('Full size keeps the canvas size and the file name without a size', async () => {
  assert.deepEqual(planDownload(big, 'full'), {
    size: FULL_SIZE,
    width: 1024,
    height: 1024,
    fileName: 'agent-pfp-big-style.png',
    scaled: false,
  });
  const shapes = await fixture('shapes');
  const plan = planDownload(shapes, 'full');
  assert.equal(plan.fileName, 'agent-pfp-fixture-shapes.png');
  assert.deepEqual([plan.width, plan.height, plan.scaled], [64, 64, false]);
  assert.equal(downloadFileName('my-style', FULL_SIZE), 'agent-pfp-my-style.png');
});

test('Full size saves the finished picture itself, with no pixel changed', () => {
  const picture = compositeLayers(96, 64, [solid(96, 64, [10, 20, 30, 255])]);
  const plan = planDownload({ style: 'fixture-blocks', canvas: { width: 96, height: 64 } }, 'full');
  assert.equal(pictureToSave(picture, plan), picture);
});

test('GitHub is 500 x 500 and its file name ends with the style id and 500', () => {
  assert.deepEqual(planDownload(big, 'github'), {
    size: GITHUB_SIZE,
    width: 500,
    height: 500,
    fileName: 'agent-pfp-big-style-500.png',
    scaled: true,
  });
  assert.equal(downloadFileName('my-style', GITHUB_SIZE), 'agent-pfp-my-style-500.png');
});

test('a 500 px canvas saves GitHub under the GitHub name without scaling', () => {
  const plan = planDownload({ style: 'half', canvas: { width: 500, height: 500 } }, 'github');
  assert.deepEqual([plan.width, plan.height, plan.scaled, plan.fileName], [500, 500, false, 'agent-pfp-half-500.png']);
});

test('the GitHub picture is the composited picture scaled down, and it saves as a 500 x 500 PNG', async () => {
  // Two full-canvas layers: an opaque background and a see-through one on top.
  const picture = compositeLayers(1024, 1024, [
    solid(1024, 1024, [40, 80, 120, 255]),
    solid(1024, 1024, [200, 0, 0, 128]),
  ]);
  const before = Array.from(picture.data.slice(0, 8));
  const plan = planDownload(big, 'github');
  const saved = pictureToSave(picture, plan);

  assert.equal(saved.width, 500);
  assert.equal(saved.height, 500);
  assert.notEqual(saved, picture);
  assert.deepEqual(Array.from(picture.data.slice(0, 8)), before, 'the full-size picture is left as it is');
  // One colour in, the same colour out, and it stays opaque.
  for (let i = 0; i < saved.data.length; i += 4) {
    assert.deepEqual(Array.from(saved.data.slice(i, i + 4)), before.slice(0, 4));
  }

  const folder = await mkdtemp(join(tmpdir(), 'agent-pfp-download-'));
  try {
    const path = join(folder, plan.fileName);
    await writePng(path, saved);
    const png = await readPng(path);
    assert.equal(png.width, 500);
    assert.equal(png.height, 500);
    assert.deepEqual(Array.from(png.data), Array.from(saved.data));
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
