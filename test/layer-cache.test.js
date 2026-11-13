import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PAGE_LAYER_BYTES, THUMBNAIL_LAYER_BYTES, createLayerCache } from '../src/layer-cache.js';

/** A loader that makes a layer of `bytes` bytes and counts its loads. */
function counting(bytes = 10) {
  const loads = [];
  const load = (src) => {
    loads.push(src);
    return { width: 1, height: 1, data: new Uint8ClampedArray(bytes) };
  };
  return { load, loads };
}

test('a layer is loaded once and comes back from the cache after that', async () => {
  const { load, loads } = counting();
  const cache = createLayerCache(load, 100);
  const first = await cache.get('a.png');
  assert.equal(await cache.get('a.png'), first);
  assert.deepEqual(loads, ['a.png']);
  assert.equal(cache.bytes, 10);
});

test('the oldest layers are dropped when the cache goes over its limit', async () => {
  const { load, loads } = counting(10);
  const cache = createLayerCache(load, 25);
  for (const src of ['a', 'b', 'c', 'd']) await cache.get(src);
  assert.deepEqual(cache.sources, ['c', 'd']);
  assert.equal(cache.bytes, 20);
  await cache.get('a');
  assert.deepEqual(loads, ['a', 'b', 'c', 'd', 'a'], 'a dropped layer is loaded again');
});

test('a layer used again becomes the newest and stays', async () => {
  const { load } = counting(10);
  const cache = createLayerCache(load, 25);
  await cache.get('a');
  await cache.get('b');
  await cache.get('a');
  await cache.get('c');
  assert.deepEqual(cache.sources, ['a', 'c']);
});

test('a layer bigger than the limit is kept until the next one comes', async () => {
  const { load } = counting(50);
  const cache = createLayerCache(load, 25);
  await cache.get('big');
  assert.deepEqual(cache.sources, ['big']);
  await cache.get('next');
  assert.deepEqual(cache.sources, ['next']);
});

test('a layer that is still loading is never dropped', async () => {
  let release;
  const slow = new Promise((resolve) => {
    release = resolve;
  });
  const cache = createLayerCache((src) => (src === 'slow' ? slow : { data: new Uint8ClampedArray(30) }), 25);
  const pending = cache.get('slow');
  await cache.get('fast');
  assert.ok(cache.sources.includes('slow'));
  release({ data: new Uint8ClampedArray(30) });
  await pending;
  assert.deepEqual(cache.sources, ['slow'], 'the newest load stays, the older one goes');
});

test('a failed load is dropped, so the next get tries again', async () => {
  let fail = true;
  const cache = createLayerCache(() => {
    if (fail) throw new Error('HTTP 404');
    return { data: new Uint8ClampedArray(4) };
  }, 100);
  await assert.rejects(cache.get('a'), /HTTP 404/);
  assert.deepEqual(cache.sources, []);
  fail = false;
  assert.equal((await cache.get('a')).data.length, 4);
});

test('the limits fit the alien: the page holds its 7 layers and the worker one group with them', () => {
  const layer = 1024 * 1024 * 4;
  assert.ok(PAGE_LAYER_BYTES >= 7 * layer);
  // 7 layers on screen and the 10 options of the biggest group.
  assert.ok(THUMBNAIL_LAYER_BYTES >= 17 * layer);
  assert.throws(() => createLayerCache(() => null, -1), RangeError);
});
