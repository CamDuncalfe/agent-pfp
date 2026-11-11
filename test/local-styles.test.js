import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { buildLocalIndex, isPixelArt, mayLoadLocalStyles, mergeStyleLists, PIXEL_ART_BELOW } from '../src/local-styles.js';
import { resolveManifestUrl, validateStyleIndex } from '../src/styles.js';

async function shapes(overrides = {}) {
  const url = new URL('../fixtures/shapes/manifest.json', import.meta.url);
  return { ...JSON.parse(await readFile(url, 'utf8')), ...overrides };
}

test('each valid folder becomes one entry, sorted by id', async () => {
  const { index, warnings } = buildLocalIndex([
    { folder: 'zebra', manifest: await shapes({ style: 'b-style', name: 'B' }) },
    { folder: 'apple', manifest: await shapes({ style: 'c-style', name: 'C' }) },
    { folder: 'mango', manifest: await shapes({ style: 'a-style', name: 'A' }) },
  ]);
  assert.deepEqual(warnings, []);
  assert.deepEqual(index, {
    version: 1,
    styles: [
      { id: 'a-style', name: 'A', manifest: 'local-styles/mango/manifest.json' },
      { id: 'b-style', name: 'B', manifest: 'local-styles/zebra/manifest.json' },
      { id: 'c-style', name: 'C', manifest: 'local-styles/apple/manifest.json' },
    ],
  });
  assert.equal(validateStyleIndex(index).ok, true);
});

test('no folders gives an empty list and no warnings', () => {
  assert.deepEqual(buildLocalIndex([]), { index: { version: 1, styles: [] }, warnings: [] });
});

test('a folder with a bad manifest is left out with one warning that names it', async () => {
  const { index, warnings } = buildLocalIndex([
    { folder: 'good', manifest: await shapes({ style: 'good-style' }) },
    { folder: 'not-json', error: 'manifest.json is not valid JSON' },
    { folder: 'not-valid', manifest: await shapes({ version: 7 }) },
    { folder: 'not-object', manifest: [] },
  ]);
  assert.deepEqual(index.styles.map((entry) => entry.id), ['good-style']);
  assert.deepEqual(warnings, [
    'Left out local style folder "not-json": manifest.json is not valid JSON',
    'Left out local style folder "not-object": manifest.json is not valid (manifest must be a JSON object)',
    'Left out local style folder "not-valid": manifest.json is not valid (version must be 1)',
  ]);
});

test('a style id that is already used is left out', async () => {
  const { index, warnings } = buildLocalIndex(
    [
      { folder: 'copy-of-repo-style', manifest: await shapes() },
      { folder: 'first', manifest: await shapes({ style: 'twin' }) },
      { folder: 'second', manifest: await shapes({ style: 'twin' }) },
    ],
    ['fixture-shapes', 'fixture-blocks'],
  );
  assert.deepEqual(index.styles, [{ id: 'twin', name: 'Fixture shapes (test data, not artwork)', manifest: 'local-styles/first/manifest.json' }]);
  assert.deepEqual(warnings, [
    'Left out local style folder "copy-of-repo-style": the style id "fixture-shapes" is already used by another style',
    'Left out local style folder "second": the style id "twin" is already used by another style',
  ]);
});

test('a folder name that cannot be a safe URL path part is left out', async () => {
  const manifest = await shapes({ style: 'spaced' });
  for (const folder of ['my style', '..', 'a%2fb', 'a/b', 'né']) {
    const { index, warnings } = buildLocalIndex([{ folder, manifest }]);
    assert.deepEqual(index.styles, [], folder);
    assert.equal(warnings.length, 1, folder);
    assert.match(warnings[0], /the folder name may only use/);
  }
});

const repoIndex = {
  version: 1,
  styles: [
    { id: 'fixture-shapes', name: 'Shapes', manifest: 'fixtures/shapes/manifest.json' },
    { id: 'fixture-blocks', name: 'Blocks', manifest: 'fixtures/blocks/manifest.json' },
  ],
};
const repoUrl = 'http://127.0.0.1:4173/styles/index.json';
const localUrl = 'http://127.0.0.1:4173/local-styles/index.json';

test('local styles come after the repo styles and say (local)', () => {
  const localIndex = { version: 1, styles: [{ id: 'marker', name: 'Marker', manifest: 'local-styles/marker/manifest.json' }] };
  const merged = mergeStyleLists(repoIndex, repoUrl, localIndex, localUrl);
  assert.deepEqual(merged.map((entry) => [entry.id, entry.name, entry.local]), [
    ['fixture-shapes', 'Shapes', false],
    ['fixture-blocks', 'Blocks', false],
    ['marker', 'Marker (local)', true],
  ]);
  // Each entry resolves against the index it came from.
  assert.equal(resolveManifestUrl(merged[0], merged[0].indexUrl).href, 'http://127.0.0.1:4173/fixtures/shapes/manifest.json');
  assert.equal(resolveManifestUrl(merged[2], merged[2].indexUrl).href, 'http://127.0.0.1:4173/local-styles/marker/manifest.json');
});

test('without local styles the picker lists the repo styles only', () => {
  const repoOnly = repoIndex.styles.map((entry) => ({ ...entry, indexUrl: repoUrl, local: false }));
  assert.deepEqual(mergeStyleLists(repoIndex, repoUrl, null, localUrl), repoOnly);
  assert.deepEqual(mergeStyleLists(repoIndex, repoUrl, { version: 1, styles: [] }, localUrl), repoOnly);
  assert.deepEqual(mergeStyleLists(repoIndex, repoUrl, { nonsense: true }, localUrl), repoOnly);
  assert.deepEqual(mergeStyleLists(repoIndex, repoUrl, 'text', localUrl), repoOnly);
});

test('a local style cannot take the place of a repo style', () => {
  const localIndex = {
    version: 1,
    styles: [
      { id: 'fixture-shapes', name: 'Impostor', manifest: 'local-styles/x/manifest.json' },
      { id: 'marker', name: 'Marker', manifest: 'local-styles/marker/manifest.json' },
    ],
  };
  const merged = mergeStyleLists(repoIndex, repoUrl, localIndex, localUrl);
  assert.deepEqual(merged.map((entry) => entry.name), ['Shapes', 'Blocks', 'Marker (local)']);
});

test('the preview keeps sharp pixels for a canvas narrower than 256px', () => {
  assert.equal(PIXEL_ART_BELOW, 256);
  assert.equal(isPixelArt(64), true);
  assert.equal(isPixelArt(96), true);
  assert.equal(isPixelArt(255), true);
  assert.equal(isPixelArt(256), false);
  assert.equal(isPixelArt(1024), false);
});

test('the page asks for local styles on a loopback host name only', () => {
  assert.equal(mayLoadLocalStyles('127.0.0.1'), true);
  assert.equal(mayLoadLocalStyles('localhost'), true);
  for (const hostname of ['example.com', 'localhost.example.com', '127.0.0.1.example.com', '127.0.0.2', '192.168.1.20', '[::1]', 'LOCALHOST', '']) {
    assert.equal(mayLoadLocalStyles(hostname), false, hostname);
  }
});
