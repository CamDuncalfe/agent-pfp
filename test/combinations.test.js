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
