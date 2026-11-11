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
  resolveManifestUrl,
  styleMismatch,
  styleRootUrl,
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
