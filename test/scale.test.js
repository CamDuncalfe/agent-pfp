import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createRaster } from '../src/composite.js';
import { scaleDown } from '../src/scale.js';

function solid(width, height, colour) {
  const raster = createRaster(width, height);
  for (let i = 0; i < raster.data.length; i += 4) raster.data.set(colour, i);
  return raster;
}

function pixel(raster, x, y) {
  const i = (y * raster.width + x) * 4;
  return Array.from(raster.data.slice(i, i + 4));
}

function setPixel(raster, x, y, colour) {
  raster.data.set(colour, (y * raster.width + x) * 4);
}

/** Opaque pixels with a different colour in each, so averaging has something to do. */
function noisy(width, height) {
  const raster = createRaster(width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      setPixel(raster, x, y, [(x * 37 + y * 11) % 256, (x * 5 + y * 91) % 256, (x * y) % 256, 255]);
    }
  }
  return raster;
}

test('the result has the size asked for', () => {
  for (const [from, to] of [[[1024, 1024], [500, 500]], [[640, 640], [500, 500]], [[10, 6], [3, 5]], [[7, 7], [1, 1]]]) {
    const out = scaleDown(solid(from[0], from[1], [1, 2, 3, 255]), to[0], to[1]);
    assert.equal(out.width, to[0]);
    assert.equal(out.height, to[1]);
    assert.equal(out.data.length, to[0] * to[1] * 4);
  }
});

test('a one-colour picture comes out the same colour', () => {
  for (const colour of [[200, 30, 97, 255], [0, 0, 0, 255], [255, 255, 255, 255], [13, 250, 1, 128], [77, 77, 77, 1]]) {
    // 1024 to 500 and 7 to 3 are not whole-number ratios.
    for (const [from, to] of [[1024, 500], [7, 3], [501, 500]]) {
      const out = scaleDown(solid(from, from, colour), to, to);
      for (let i = 0; i < out.data.length; i += 4) {
        assert.deepEqual(Array.from(out.data.slice(i, i + 4)), colour, `${from} to ${to}, pixel ${i / 4}`);
      }
    }
  }
});

test('an opaque picture comes out opaque', () => {
  for (const [from, to] of [[1024, 500], [97, 31], [501, 500]]) {
    const out = scaleDown(noisy(from, from), to, to);
    for (let i = 3; i < out.data.length; i += 4) {
      assert.equal(out.data[i], 255, `${from} to ${to}, pixel ${(i - 3) / 4}`);
    }
  }
});

test('each pixel is the average of the pixels it covers', () => {
  const picture = createRaster(4, 2);
  // The left 2x2 block is half black and half white, the right one is all red.
  setPixel(picture, 0, 0, [0, 0, 0, 255]);
  setPixel(picture, 1, 0, [255, 255, 255, 255]);
  setPixel(picture, 0, 1, [255, 255, 255, 255]);
  setPixel(picture, 1, 1, [0, 0, 0, 255]);
  for (const [x, y] of [[2, 0], [3, 0], [2, 1], [3, 1]]) setPixel(picture, x, y, [255, 0, 0, 255]);
  const out = scaleDown(picture, 2, 1);
  assert.deepEqual(pixel(out, 0, 0), [128, 128, 128, 255]);
  assert.deepEqual(pixel(out, 1, 0), [255, 0, 0, 255]);
});

test('a pixel that is partly covered counts for the part that is covered', () => {
  // 3 pixels to 2: each target pixel covers one whole pixel and half of the middle one.
  const picture = createRaster(3, 1);
  setPixel(picture, 0, 0, [0, 0, 0, 255]);
  setPixel(picture, 1, 0, [90, 90, 90, 255]);
  setPixel(picture, 2, 0, [255, 255, 255, 255]);
  const out = scaleDown(picture, 2, 1);
  assert.deepEqual(pixel(out, 0, 0), [30, 30, 30, 255]);
  assert.deepEqual(pixel(out, 1, 0), [200, 200, 200, 255]);
});

test('a see-through pixel adds no colour to the pixels next to it', () => {
  // Fully see-through green next to opaque red. Green must not leak in.
  const picture = createRaster(2, 2);
  setPixel(picture, 0, 0, [255, 0, 0, 255]);
  setPixel(picture, 1, 0, [0, 255, 0, 0]);
  setPixel(picture, 0, 1, [255, 0, 0, 255]);
  setPixel(picture, 1, 1, [0, 255, 0, 0]);
  assert.deepEqual(pixel(scaleDown(picture, 1, 1), 0, 0), [255, 0, 0, 128]);

  // A partly see-through pixel counts in proportion to its alpha.
  const mixed = createRaster(2, 1);
  setPixel(mixed, 0, 0, [255, 0, 0, 255]);
  setPixel(mixed, 1, 0, [0, 0, 255, 85]);
  assert.deepEqual(pixel(scaleDown(mixed, 1, 1), 0, 0), [191, 0, 64, 170]);
});

test('a fully see-through area comes out see-through with no colour', () => {
  const out = scaleDown(solid(8, 8, [9, 9, 9, 0]), 3, 3);
  assert.ok(out.data.every((value) => value === 0));
});

test('the picture passed in is left as it is, and the same size gives a copy', () => {
  const picture = noisy(6, 6);
  const before = Array.from(picture.data);
  const smaller = scaleDown(picture, 4, 4);
  assert.deepEqual(Array.from(picture.data), before);
  assert.notEqual(smaller.data, picture.data);

  const copy = scaleDown(picture, 6, 6);
  assert.notEqual(copy, picture);
  assert.deepEqual(Array.from(copy.data), before);
});

test('scaleDown refuses a bigger size, a bad size and something that is not a raster', () => {
  const picture = solid(4, 4, [1, 2, 3, 255]);
  assert.throws(() => scaleDown(picture, 5, 4), RangeError);
  assert.throws(() => scaleDown(picture, 4, 5), RangeError);
  assert.throws(() => scaleDown(picture, 0, 2), RangeError);
  assert.throws(() => scaleDown(picture, 2.5, 2), RangeError);
  assert.throws(() => scaleDown({ width: 2, height: 2, data: [] }, 1, 1), TypeError);
  assert.throws(() => scaleDown(null, 1, 1), TypeError);
});
