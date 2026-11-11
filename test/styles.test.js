import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { validateManifest } from '../src/manifest.js';
import {
  chooseStyle,
  createStyleSwitcher,
  resolveManifestUrl,
  styleFromSearch,
  styleMismatch,
  styleRootUrl,
  unknownStyleNotice,
  validateStyleIndex,
} from '../src/styles.js';

const run = promisify(execFile);
const rootUrl = new URL('../', import.meta.url);
const cli = fileURLToPath(new URL('../bin/check-styles.js', import.meta.url));

async function loadIndex() {
  return JSON.parse(await readFile(new URL('styles/index.json', rootUrl), 'utf8'));
}

async function runCli(args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [cli, ...args]);
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

test('styles/index.json is valid and lists the two fixture styles', async () => {
  const index = await loadIndex();
  assert.deepEqual(validateStyleIndex(index), { ok: true, errors: [] });
  assert.deepEqual(index.styles.map((entry) => entry.id), ['fixture-shapes', 'fixture-blocks']);
});

test('each style in the index has a valid manifest with the same id and name', async () => {
  const index = await loadIndex();
  for (const entry of index.styles) {
    const manifest = JSON.parse(await readFile(new URL(entry.manifest, rootUrl), 'utf8'));
    assert.deepEqual(validateManifest(manifest).errors, [], entry.id);
    assert.equal(styleMismatch(entry, manifest), null, entry.id);
    assert.equal(manifest.name, entry.name, entry.id);
  }
});

test('an index that is not an object, or lists no styles, is rejected', () => {
  for (const value of [null, [], 'text', 3]) {
    assert.equal(validateStyleIndex(value).ok, false);
  }
  assert.deepEqual(validateStyleIndex({ version: 1, styles: [] }).errors, ['styles must list at least one style']);
  assert.equal(validateStyleIndex({ version: 1 }).ok, false);
  assert.deepEqual(validateStyleIndex({ version: 2, styles: [{ id: 'a', name: 'A', manifest: 'a/manifest.json' }] }).errors, [
    'version must be 1',
  ]);
});

test('each entry needs an id, a name and a safe manifest path', () => {
  const { errors } = validateStyleIndex({
    version: 1,
    styles: [
      { id: 'Not An Id', name: 'A', manifest: 'a/manifest.json' },
      { id: 'b', name: ' ', manifest: 'b/manifest.json' },
      { id: 'c', name: 'C', manifest: '../c/manifest.json' },
      { id: 'd', name: 'D', manifest: 'https://example.com/manifest.json' },
      { id: 'e', name: 'E', manifest: 'e/%2e%2e/manifest.json' },
      { id: 'f', name: 'F', manifest: 'f/manifest.png' },
      { id: 'g', name: 'G' },
      'h',
    ],
  });
  assert.equal(errors.length, 8);
  assert.match(errors[0], /styles\[0\]\.id/);
  assert.match(errors[1], /styles\[1\]\.name/);
  for (const position of [2, 3, 4, 5, 6]) assert.match(errors[position], new RegExp(`styles\\[${position}\\]\\.manifest`));
  assert.match(errors[7], /styles\[7\] must be an object/);
});

test('an id used twice is reported', () => {
  const entry = { id: 'a', name: 'A', manifest: 'a/manifest.json' };
  const { errors } = validateStyleIndex({ version: 1, styles: [entry, { ...entry }] });
  assert.deepEqual(errors, ['styles[1].id "a" is used twice']);
});

test('manifest paths resolve against the folder that holds the index folder', () => {
  const indexUrl = 'http://127.0.0.1:4173/styles/index.json';
  assert.equal(styleRootUrl(indexUrl).href, 'http://127.0.0.1:4173/');
  const entry = { id: 'a', name: 'A', manifest: 'fixtures/shapes/manifest.json' };
  assert.equal(resolveManifestUrl(entry, indexUrl).href, 'http://127.0.0.1:4173/fixtures/shapes/manifest.json');
  // A site served from a sub-folder keeps its styles inside that folder.
  assert.equal(
    resolveManifestUrl(entry, 'https://example.com/pfp/styles/index.json').href,
    'https://example.com/pfp/fixtures/shapes/manifest.json',
  );
});

test('a manifest path cannot leave the site', () => {
  const indexUrl = 'http://127.0.0.1:4173/styles/index.json';
  for (const manifest of ['../secret.json', '/etc/passwd', '//example.com/manifest.json', 'https://example.com/m.json', 'a/%2e%2e/%2e%2e/m.json', 'a\\b.json', '']) {
    assert.throws(() => resolveManifestUrl({ id: 'a', name: 'A', manifest }, indexUrl), /manifest path/, manifest);
  }
});

test('the first style opens by default and an unknown id falls back to it', async () => {
  const index = await loadIndex();
  const [first, second] = index.styles;
  assert.deepEqual(chooseStyle(index, null), { entry: first, unknown: null });
  assert.deepEqual(chooseStyle(index, undefined), { entry: first, unknown: null });
  assert.deepEqual(chooseStyle(index, ''), { entry: first, unknown: null });
  assert.deepEqual(chooseStyle(index, 'fixture-blocks'), { entry: second, unknown: null });
  assert.deepEqual(chooseStyle(index, 'nope'), { entry: first, unknown: 'nope' });
  // Ids are exact: no trimming and no case folding.
  assert.deepEqual(chooseStyle(index, 'Fixture-Blocks'), { entry: first, unknown: 'Fixture-Blocks' });
});

test('a manifest for another style is a mismatch', () => {
  const entry = { id: 'a', name: 'A', manifest: 'a/manifest.json' };
  assert.equal(styleMismatch(entry, { style: 'a' }), null);
  assert.match(styleMismatch(entry, { style: 'b' }), /"a".*"b"/);
});

test('the address picks the style through the style parameter only', async () => {
  const index = await loadIndex();
  const [first, second] = index.styles;
  assert.deepEqual(styleFromSearch(index, ''), { entry: first, notice: '' });
  assert.deepEqual(styleFromSearch(index, '?style=fixture-blocks'), { entry: second, notice: '' });
  assert.deepEqual(styleFromSearch(index, 'other=1&style=fixture-blocks'), { entry: second, notice: '' });
  // The page used to read ?manifest=. It has no say now.
  assert.deepEqual(styleFromSearch(index, '?manifest=../fixtures/blocks/manifest.json'), { entry: first, notice: '' });
  assert.deepEqual(styleFromSearch(index, '?manifest=https://example.com/m.json&style=fixture-blocks'), {
    entry: second,
    notice: '',
  });
});

test('an unknown style in the address opens the first style with a notice', async () => {
  const index = await loadIndex();
  const first = index.styles[0];
  assert.deepEqual(styleFromSearch(index, '?style=nope'), {
    entry: first,
    notice: 'This builder doesn\'t know a style called "nope". Showing Fixture shapes (test data, not artwork).',
  });
  // The id is quoted as it came. The page puts the notice in as text.
  assert.equal(
    unknownStyleNotice('<b>x</b>', { id: 'a', name: 'A', manifest: 'a/manifest.json' }),
    'This builder doesn\'t know a style called "<b>x</b>". Showing A.',
  );
});

/** A switcher whose loads finish when the test says so. */
function switcherWithManualLoads() {
  const events = [];
  const pending = new Map();
  const switcher = createStyleSwitcher({
    clear: (entry) => events.push(`clear ${entry.id}`),
    load: (entry) => new Promise((resolve, reject) => pending.set(entry.id, { resolve, reject })),
    show: (entry, loaded, isOnScreen) => {
      events.push(`show ${entry.id} ${loaded} ${isOnScreen()}`);
    },
    fail: (entry, error) => events.push(`fail ${entry.id} ${error.message}`),
  });
  return { events, pending, switcher };
}

const styleA = { id: 'a', name: 'A', manifest: 'a/manifest.json' };
const styleB = { id: 'b', name: 'B', manifest: 'b/manifest.json' };

test('a style that loads is cleared for, then shown', async () => {
  const { events, pending, switcher } = switcherWithManualLoads();
  const opened = switcher.open(styleA);
  pending.get('a').resolve('manifest-a');
  assert.equal(await opened, true);
  assert.deepEqual(events, ['clear a', 'show a manifest-a true']);
});

test('a style that fails to load is reported and another one can be opened', async () => {
  const { events, pending, switcher } = switcherWithManualLoads();
  const failed = switcher.open(styleA);
  pending.get('a').reject(new Error('HTTP 404'));
  assert.equal(await failed, false);
  const opened = switcher.open(styleB);
  pending.get('b').resolve('manifest-b');
  assert.equal(await opened, true);
  assert.deepEqual(events, ['clear a', 'fail a HTTP 404', 'clear b', 'show b manifest-b true']);
});

test('the style picked last stays on screen when an earlier one finishes loading later', async () => {
  const { events, pending, switcher } = switcherWithManualLoads();
  const first = switcher.open(styleA);
  const second = switcher.open(styleB);
  pending.get('b').resolve('manifest-b');
  assert.equal(await second, true);
  pending.get('a').resolve('manifest-a');
  assert.equal(await first, false);
  assert.deepEqual(events, ['clear a', 'clear b', 'show b manifest-b true']);
});

test('an earlier style that fails late is not reported over the newer one', async () => {
  const { events, pending, switcher } = switcherWithManualLoads();
  const first = switcher.open(styleA);
  const second = switcher.open(styleB);
  pending.get('a').reject(new Error('HTTP 500'));
  assert.equal(await first, false);
  pending.get('b').resolve('manifest-b');
  assert.equal(await second, true);
  assert.deepEqual(events, ['clear a', 'clear b', 'show b manifest-b true']);
});

test('a style that is replaced while it is being shown reports that it is off screen', async () => {
  const events = [];
  let release;
  const switcher = createStyleSwitcher({
    clear: () => {},
    load: async (entry) => entry.id,
    show: async (entry, loaded, isOnScreen) => {
      if (entry.id === 'a') await new Promise((resolve) => { release = resolve; });
      events.push(`${entry.id} on screen: ${isOnScreen()}`);
    },
    fail: () => events.push('fail'),
  });
  const first = switcher.open(styleA);
  await new Promise((resolve) => setImmediate(resolve));
  const second = switcher.open(styleB);
  assert.equal(await second, true);
  release();
  assert.equal(await first, false);
  assert.deepEqual(events, ['b on screen: true', 'a on screen: false']);
});

test('check-styles passes on the styles in the index', async () => {
  const result = await runCli([fileURLToPath(new URL('styles/index.json', rootUrl))]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Style: fixture-shapes/);
  assert.match(result.stdout, /Style: fixture-blocks/);
  assert.match(result.stdout, /Styles checked: 2\nRender check passed\.\n$/);
});

test('check-styles exits 1 when a listed style fails and 2 when it cannot run', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'agent-pfp-styles-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  await mkdir(join(folder, 'styles'));
  const write = (value) => writeFile(join(folder, 'styles', 'index.json'), typeof value === 'string' ? value : JSON.stringify(value));
  const indexPath = join(folder, 'styles', 'index.json');

  // The broken fixture style, reached through an index next to a copy of its folder.
  await cp(fileURLToPath(new URL('fixtures/broken', rootUrl)), join(folder, 'broken'), { recursive: true });
  await write({ version: 1, styles: [{ id: 'fixture-broken', name: 'Broken', manifest: 'broken/manifest.json' }] });
  const failing = await runCli([indexPath]);
  assert.equal(failing.code, 1);
  assert.match(failing.stdout, /Render check failed for 1 of 1 styles\./);

  await write({ version: 1, styles: [{ id: 'other-id', name: 'Broken', manifest: 'broken/manifest.json' }] });
  const mismatch = await runCli([indexPath]);
  assert.equal(mismatch.code, 2);
  assert.match(mismatch.stderr, /"other-id"/);

  await write({ version: 1, styles: [{ id: 'gone', name: 'Gone', manifest: 'gone/manifest.json' }] });
  assert.equal((await runCli([indexPath])).code, 2);

  await write('{ not json');
  assert.equal((await runCli([indexPath])).code, 2);

  await write({ version: 1, styles: [] });
  assert.equal((await runCli([indexPath])).code, 2);

  assert.equal((await runCli([join(folder, 'missing.json')])).code, 2);
  assert.equal((await runCli(['--nope'])).code, 2);
  assert.equal((await runCli([indexPath, indexPath])).code, 2);
});
