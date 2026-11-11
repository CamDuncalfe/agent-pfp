import { test } from 'node:test';
import assert from 'node:assert/strict';

import { countCombinations, walkCombinations, sampleCombinations, seededRandom } from '../src/combinations.js';
import { resolveSelection } from '../src/manifest.js';

function manifestWith(sizes, optionalIndexes = []) {
  return {
    version: 1,
    style: 'test',
    name: 'Test',
    canvas: { width: 4, height: 4 },
    groups: sizes.map((size, index) => ({
      id: `g${index}`,
      label: `Group ${index}`,
      optional: optionalIndexes.includes(index),
      options: Array.from({ length: size }, (_, n) => ({ id: `o${n}`, label: `Option ${n}`, src: `g${index}/o${n}.png` })),
    })),
  };
}

test('countCombinations multiplies the choices and counts the empty choice', () => {
  assert.equal(countCombinations(manifestWith([2, 3])), 6);
  assert.equal(countCombinations(manifestWith([2, 3], [1])), 8);
  assert.equal(countCombinations(manifestWith([1])), 1);
});

test('countCombinations returns Infinity when the count is too large for a number', () => {
  assert.equal(countCombinations(manifestWith(new Array(20).fill(10))), Infinity);
});

test('walkCombinations visits every selection once', () => {
  const manifest = manifestWith([2, 3, 2], [2]);
  const seen = new Set();
  for (const selection of walkCombinations(manifest)) {
    assert.doesNotThrow(() => resolveSelection(manifest, selection));
    seen.add(JSON.stringify(selection));
  }
  assert.equal(seen.size, 18);
  assert.equal(seen.size, countCombinations(manifest));
});

test('walkCombinations changes the last group fastest', () => {
  const first = [...walkCombinations(manifestWith([2, 2]))];
  assert.deepEqual(first, [
    { g0: 'o0', g1: 'o0' },
    { g0: 'o0', g1: 'o1' },
    { g0: 'o1', g1: 'o0' },
    { g0: 'o1', g1: 'o1' },
  ]);
});

test('seededRandom repeats for a seed and stays in [0, 1)', () => {
  const a = seededRandom(7);
  const b = seededRandom(7);
  const c = seededRandom(8);
  const fromA = Array.from({ length: 50 }, a);
  assert.deepEqual(fromA, Array.from({ length: 50 }, b));
  assert.notDeepEqual(fromA, Array.from({ length: 50 }, c));
  assert.ok(fromA.every((value) => value >= 0 && value < 1));
});

test('sampleCombinations gives the asked number of valid selections and repeats for a seed', () => {
  const manifest = manifestWith([4, 5, 6], [1]);
  const first = [...sampleCombinations(manifest, 25, 3)];
  assert.equal(first.length, 25);
  for (const selection of first) assert.doesNotThrow(() => resolveSelection(manifest, selection));
  assert.deepEqual(first, [...sampleCombinations(manifest, 25, 3)]);
  assert.notDeepEqual(first, [...sampleCombinations(manifest, 25, 4)]);
});

test('sampleCombinations never repeats a selection, even just under the total', () => {
  const manifest = manifestWith([3, 4, 5], [0]);
  const total = countCombinations(manifest);
  assert.equal(total, 80);
  for (const count of [1, 40, 79]) {
    for (const seed of [1, 2, 3]) {
      const keys = [...sampleCombinations(manifest, count, seed)].map((selection) => JSON.stringify(selection));
      assert.equal(keys.length, count);
      assert.equal(new Set(keys).size, count, `count ${count}, seed ${seed}`);
    }
  }
});

test('sampleCombinations yields every selection when asked for the total or more', () => {
  const manifest = manifestWith([2, 3]);
  const all = [...walkCombinations(manifest)];
  assert.deepEqual([...sampleCombinations(manifest, 6, 1)], all);
  assert.deepEqual([...sampleCombinations(manifest, 100, 1)], all);
});

test('sampleCombinations reaches every selection over many seeds', () => {
  const manifest = manifestWith([2, 3]);
  const seen = new Set();
  for (let seed = 0; seed < 200; seed += 1) {
    for (const selection of sampleCombinations(manifest, 2, seed)) seen.add(JSON.stringify(selection));
  }
  assert.equal(seen.size, 6);
});

test('sampleCombinations gives different valid selections when the total is too large to count', () => {
  const manifest = manifestWith(new Array(20).fill(10), [3]);
  assert.equal(countCombinations(manifest), Infinity);
  const sample = [...sampleCombinations(manifest, 50, 9)];
  assert.equal(new Set(sample.map((selection) => JSON.stringify(selection))).size, 50);
  for (const selection of sample) assert.doesNotThrow(() => resolveSelection(manifest, selection));
  assert.deepEqual(sample, [...sampleCombinations(manifest, 50, 9)]);
});

test('sampleCombinations stays in range for totals above 32 bits', () => {
  // 14 groups of 6 choices: 6^14 is about 7.8e10, countable but above 2^32.
  const manifest = manifestWith(new Array(14).fill(6));
  assert.ok(countCombinations(manifest) > 2 ** 32);
  const sample = [...sampleCombinations(manifest, 200, 11)];
  assert.equal(new Set(sample.map((selection) => JSON.stringify(selection))).size, 200);
  for (const selection of sample) assert.doesNotThrow(() => resolveSelection(manifest, selection));
  // With two draws per index the first group is not stuck on one option.
  assert.ok(new Set(sample.map((selection) => selection.g0)).size > 1);
});
