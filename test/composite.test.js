import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createRaster, compositeLayers, isRaster } from '../src/composite.js';

function solid(width, height, colour) {
  const raster = createRaster(width, height);
  for (let i = 0; i < raster.data.length; i += 4) raster.data.set(colour, i);
  return raster;
}

function pixel(raster, x, y) {
  const i = (y * raster.width + x) * 4;
  return Array.from(raster.data.slice(i, i + 4));
}

test('createRaster makes a transparent raster and rejects bad sizes', () => {
  const raster = createRaster(3, 2);
  assert.equal(raster.data.length, 24);
  assert.ok(raster.data.every((value) => value === 0));
  assert.equal(isRaster(raster), true);
  for (const [width, height] of [[0, 1], [1, -1], [1.5, 1], ['2', 2]]) {
    assert.throws(() => createRaster(width, height), RangeError);
  }
});

test('isRaster rejects objects whose data does not match their size', () => {
  assert.equal(isRaster({ width: 2, height: 2, data: new Uint8ClampedArray(15) }), false);
  assert.equal(isRaster({ width: 2, height: 2, data: [0, 0, 0, 0] }), false);
  assert.equal(isRaster(null), false);
});

test('no layers gives a transparent canvas', () => {
  const out = compositeLayers(2, 2, []);
  assert.ok(out.data.every((value) => value === 0));
});

test('an opaque pixel replaces what is under it', () => {
  const out = compositeLayers(1, 1, [solid(1, 1, [10, 20, 30, 255]), solid(1, 1, [200, 100, 50, 255])]);
  assert.deepEqual(pixel(out, 0, 0), [200, 100, 50, 255]);
});

test('a transparent pixel leaves what is under it', () => {
  const out = compositeLayers(1, 1, [solid(1, 1, [10, 20, 30, 255]), solid(1, 1, [200, 100, 50, 0])]);
  assert.deepEqual(pixel(out, 0, 0), [10, 20, 30, 255]);
});

test('half-transparent white over opaque black gives mid grey', () => {
  const out = compositeLayers(1, 1, [solid(1, 1, [0, 0, 0, 255]), solid(1, 1, [255, 255, 255, 128])]);
  assert.deepEqual(pixel(out, 0, 0), [128, 128, 128, 255]);
});

test('two half-transparent layers build up alpha', () => {
  const out = compositeLayers(1, 1, [solid(1, 1, [255, 0, 0, 128]), solid(1, 1, [0, 0, 255, 128])]);
  // alpha: 128 + 128 * (127 / 255) = 191.7; blue weight 128 * 255, red weight 128 * 127
  assert.deepEqual(pixel(out, 0, 0), [85, 0, 170, 192]);
});

test('a half-transparent pixel over nothing keeps its own colour', () => {
  const out = compositeLayers(1, 1, [solid(1, 1, [40, 80, 120, 100])]);
  assert.deepEqual(pixel(out, 0, 0), [40, 80, 120, 100]);
});

test('layers are drawn in order, first at the bottom', () => {
  const bottom = solid(2, 1, [1, 1, 1, 255]);
  const top = createRaster(2, 1);
  top.data.set([9, 9, 9, 255], 4);
  const out = compositeLayers(2, 1, [bottom, top]);
  assert.deepEqual(pixel(out, 0, 0), [1, 1, 1, 255]);
  assert.deepEqual(pixel(out, 1, 0), [9, 9, 9, 255]);
});

test('the inputs are not changed', () => {
  const bottom = solid(1, 1, [1, 2, 3, 255]);
  const top = solid(1, 1, [4, 5, 6, 128]);
  compositeLayers(1, 1, [bottom, top]);
  assert.deepEqual(pixel(bottom, 0, 0), [1, 2, 3, 255]);
  assert.deepEqual(pixel(top, 0, 0), [4, 5, 6, 128]);
});

test('a layer of the wrong size is refused', () => {
  assert.throws(() => compositeLayers(2, 2, [createRaster(2, 2), createRaster(4, 4)]), /layer 1 is 4x4, expected 2x2/);
  assert.throws(() => compositeLayers(2, 2, [{ width: 2, height: 2, data: [] }]), TypeError);
});
