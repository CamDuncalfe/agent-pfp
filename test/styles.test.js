import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { validateManifest } from '../src/manifest.js';
import {
  chooseStyle,
  comingSoonEntries,
  comingSoonNotice,
  createStyleSwitcher,
  resolveManifestUrl,
  resolvePictureUrl,
  styleFromSearch,
  styleMismatch,
  styleRootUrl,
  unknownStyleNotice,
  validateStyleIndex,
} from '../src/styles.js';

const run = promisify(execFile);
const rootUrl = new URL('../', import.meta.url);
const cli = fileURLToPath(new URL('../bin/check-styles.js', import.meta.url));

async function loadIndex(path = 'styles/index.json') {
  return JSON.parse(await readFile(new URL(path, rootUrl), 'utf8'));
}

/** The fixture styles: two of them, so a test can switch between them. */
const loadFixtureIndex = () => loadIndex('fixtures/index.json');

async function runCli(args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [cli, ...args]);
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

test('styles/index.json lists the alien and no fixture style', async () => {
  const index = await loadIndex();
  assert.deepEqual(validateStyleIndex(index), { ok: true, errors: [] });
  assert.deepEqual(index.styles, [{ id: 'alien', name: 'Alien', manifest: 'styles/alien/manifest.json' }]);
  const fixtureIds = (await loadFixtureIndex()).styles.map((entry) => entry.id);
  for (const entry of index.styles) {
    assert.ok(!fixtureIds.includes(entry.id), entry.id);
    assert.ok(!entry.manifest.startsWith('fixtures/'), entry.manifest);
  }
});

test('the builder opens on the alien when the address has no style', async () => {
  const index = await loadIndex();
  for (const search of ['', '?', '?style=', '?other=1']) {
    assert.deepEqual(styleFromSearch(index, search), { entry: index.styles[0], notice: '' }, search);
    assert.equal(styleFromSearch(index, search).entry.id, 'alien', search);
  }
});

test('fixtures/index.json lists the two passing fixture styles with paths from the repository root', async () => {
  const index = await loadFixtureIndex();
  assert.deepEqual(validateStyleIndex(index), { ok: true, errors: [] });
  assert.deepEqual(index.styles, [
    { id: 'fixture-shapes', name: 'Fixture shapes (test data, not artwork)', manifest: 'fixtures/shapes/manifest.json' },
    { id: 'fixture-blocks', name: 'Fixture blocks (test data, not artwork)', manifest: 'fixtures/blocks/manifest.json' },
  ]);
  // The index sits in fixtures/, so its manifest paths resolve against the repository root.
  assert.equal(styleRootUrl(new URL('fixtures/index.json', rootUrl)).href, rootUrl.href);
});

test('npm run check runs the render check on both indexes', async () => {
  const pkg = JSON.parse(await readFile(new URL('package.json', rootUrl), 'utf8'));
  assert.equal(pkg.scripts.check, 'node bin/check-styles.js styles/index.json fixtures/index.json');
});

test('each style in both indexes has a valid manifest with the same id and name', async () => {
  const styles = [...(await loadIndex()).styles, ...(await loadFixtureIndex()).styles];
  for (const entry of styles) {
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
  const index = await loadFixtureIndex();
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
  const index = await loadFixtureIndex();
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
    notice: 'This builder doesn\'t know a style called "nope". Showing Alien.',
  });
  // A fixture is not a style the builder offers.
  assert.deepEqual(styleFromSearch(index, '?style=fixture-shapes'), {
    entry: first,
    notice: 'This builder doesn\'t know a style called "fixture-shapes". Showing Alien.',
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

// The alien's check takes about half a minute, so these tests use the fixture
// index. `npm run check` runs the alien's.
test('check-styles passes on the styles in the fixture index', async () => {
  const result = await runCli([fileURLToPath(new URL('fixtures/index.json', rootUrl))]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Style: fixture-shapes/);
  assert.match(result.stdout, /Style: fixture-blocks/);
  assert.match(result.stdout, /Styles checked: 2\nRender check passed\.\n$/);
});

test('check-styles checks each index it is given and fails when either one fails', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'agent-pfp-styles-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  for (const name of ['good', 'bad', 'empty']) await mkdir(join(folder, name, 'styles'), { recursive: true });
  for (const name of ['shapes', 'blocks']) {
    await cp(fileURLToPath(new URL(`fixtures/${name}`, rootUrl)), join(folder, 'good', name), { recursive: true });
  }
  await cp(fileURLToPath(new URL('fixtures/broken', rootUrl)), join(folder, 'bad', 'broken'), { recursive: true });
  const good = join(folder, 'good', 'styles', 'index.json');
  const bad = join(folder, 'bad', 'styles', 'index.json');
  const empty = join(folder, 'empty', 'styles', 'index.json');
  await writeFile(
    good,
    JSON.stringify({
      version: 1,
      styles: [
        { id: 'fixture-shapes', name: 'Shapes', manifest: 'shapes/manifest.json' },
        { id: 'fixture-blocks', name: 'Blocks', manifest: 'blocks/manifest.json' },
      ],
    }),
  );
  await writeFile(bad, JSON.stringify({ version: 1, styles: [{ id: 'fixture-broken', name: 'Broken', manifest: 'broken/manifest.json' }] }));
  await writeFile(empty, JSON.stringify({ version: 1, styles: [] }));

  // Each index resolves its manifest paths against its own root.
  const both = await runCli([good, bad]);
  assert.equal(both.code, 1);
  assert.match(both.stdout, /Style: fixture-shapes/);
  assert.match(both.stdout, /Style: fixture-broken/);
  assert.match(both.stdout, /Render check failed for 1 of 3 styles\./);

  // The order does not matter: a failure in the first index still checks the second.
  const reversed = await runCli([bad, good]);
  assert.equal(reversed.code, 1);
  assert.match(reversed.stdout, /Style: fixture-blocks/);
  assert.match(reversed.stdout, /Render check failed for 1 of 3 styles\./);

  // An index that can't be read stops the run before any style is checked.
  const broken = await runCli([good, empty]);
  assert.equal(broken.code, 2);
  assert.equal(broken.stdout, '');
  assert.match(broken.stderr, /empty.styles.index\.json is not a valid style index/);
  assert.equal((await runCli([good, join(folder, 'missing.json')])).code, 2);

  // The same index twice is checked once.
  const twice = await runCli([good, good]);
  assert.equal(twice.code, 0);
  assert.match(twice.stdout, /Styles checked: 2\nRender check passed\.\n$/);
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
  assert.equal((await runCli([indexPath, '--nope'])).code, 2);
});

/** The characters styles/index.json names as coming soon, in the order of the Character tab. */
const COMING_SOON = ['Bear', 'Fox', 'Cat', 'Duck', 'Penguin', 'Raccoon', 'Owl', 'Rabbit', 'Frog', 'Skeleton', 'Cyclops'];

test('styles/index.json names eleven coming-soon characters after the alien, each with a picture and no manifest', async () => {
  const index = await loadIndex();
  const coming = comingSoonEntries(index);
  assert.deepEqual(
    coming,
    COMING_SOON.map((name) => ({ id: name.toLowerCase(), name, picture: `styles/coming-soon/${name.toLowerCase()}.png` })),
  );
  // The alien is still the one style, so the check, the site build and the page open nothing else.
  assert.deepEqual(index.styles.map((entry) => entry.id), ['alien']);
  for (const entry of coming) assert.equal('manifest' in entry, false, entry.id);
  // The folder holds those eleven pictures and its notice, and no style: no manifest and no layers.
  const folder = await readdir(new URL('styles/coming-soon/', rootUrl));
  assert.deepEqual(folder.sort(), ['NOTICE.md', ...coming.map((entry) => `${entry.id}.png`)].sort());
});

test('each coming-soon picture is a square PNG twice the widest picture a character tile shows', async () => {
  const css = await readFile(new URL('web/builder.css', rootUrl), 'utf8');
  // A tile is --character-tile wide at most, with a 2 px border on each side.
  const tile = Number(/--character-tile: (\d+)px;/.exec(css)[1]);
  const side = (tile - 4) * 2;
  for (const entry of comingSoonEntries(await loadIndex())) {
    const file = await readFile(new URL(entry.picture, rootUrl));
    assert.equal(file.subarray(1, 4).toString('latin1'), 'PNG', entry.id);
    // The size is in the PNG's first chunk. The test reads no pixel of the art.
    assert.deepEqual([file.readUInt32BE(16), file.readUInt32BE(20)], [side, side], entry.id);
    // Colour type 6 is RGB with alpha: the character is cut out, and the tile's ground shows around it.
    assert.equal(file[25], 6, entry.id);
  }
});

test('an index without comingSoon has no coming-soon characters', async () => {
  assert.deepEqual(comingSoonEntries(await loadFixtureIndex()), []);
  assert.deepEqual(comingSoonEntries({ version: 1, styles: [] }), []);
});

test('each coming-soon entry needs an id, a name and a safe picture path, and no manifest', () => {
  const styles = [{ id: 'a', name: 'A', manifest: 'a/manifest.json' }];
  const ok = { version: 1, styles, comingSoon: [{ id: 'b', name: 'B', picture: 'styles/coming-soon/b.png' }] };
  assert.deepEqual(validateStyleIndex(ok), { ok: true, errors: [] });
  assert.deepEqual(validateStyleIndex({ version: 1, styles, comingSoon: [] }), { ok: true, errors: [] });
  assert.deepEqual(validateStyleIndex({ version: 1, styles, comingSoon: {} }).errors, ['comingSoon must be a list when it is there']);
  const { errors } = validateStyleIndex({
    version: 1,
    styles,
    comingSoon: [
      { id: 'Not An Id', name: 'B', picture: 'b.png' },
      { id: 'c', name: ' ', picture: 'c.png' },
      { id: 'd', name: 'D', picture: '../d.png' },
      { id: 'e', name: 'E', picture: 'https://example.com/e.png' },
      { id: 'f', name: 'F', picture: 'f.json' },
      { id: 'g', name: 'G' },
      'h',
      // A style's id can't be a coming-soon character's too.
      { id: 'a', name: 'A again', picture: 'a.png' },
      // An entry with a manifest is a style, and belongs in styles.
      { id: 'i', name: 'I', picture: 'i.png', manifest: 'i/manifest.json' },
    ],
  });
  assert.equal(errors.length, 9);
  assert.match(errors[0], /comingSoon\[0\]\.id/);
  assert.match(errors[1], /comingSoon\[1\]\.name/);
  for (const position of [2, 3, 4, 5]) assert.match(errors[position], new RegExp(`comingSoon\\[${position}\\]\\.picture`));
  assert.match(errors[6], /comingSoon\[6\] must be an object/);
  assert.equal(errors[7], 'comingSoon[7].id "a" is used twice');
  assert.equal(errors[8], 'comingSoon[8] has a manifest, so it belongs in styles');
});

test('a coming-soon picture resolves against the folder that holds the index folder and cannot leave the site', () => {
  const indexUrl = 'https://example.com/agent-pfp/styles/index.json';
  assert.equal(
    resolvePictureUrl({ id: 'bear', name: 'Bear', picture: 'styles/coming-soon/bear.png' }, indexUrl).href,
    'https://example.com/agent-pfp/styles/coming-soon/bear.png',
  );
  for (const picture of ['../bear.png', '/bear.png', 'https://example.org/bear.png', 'styles/%2e%2e/%2e%2e/bear.png', '']) {
    assert.throws(() => resolvePictureUrl({ id: 'bear', name: 'Bear', picture }, indexUrl), /picture path/, picture);
  }
});

test('a coming-soon character in the address opens the first style and the notice says it is coming soon', async () => {
  const index = await loadIndex();
  const first = index.styles[0];
  assert.deepEqual(styleFromSearch(index, '?style=bear'), { entry: first, notice: 'Bear is coming soon. Showing Alien.' });
  assert.deepEqual(styleFromSearch(index, '?style=cyclops'), { entry: first, notice: 'Cyclops is coming soon. Showing Alien.' });
  assert.equal(comingSoonNotice({ id: 'b', name: 'B', picture: 'b.png' }, first), 'B is coming soon. Showing Alien.');
  // chooseStyle never gives a coming-soon character back as the style to open.
  for (const entry of comingSoonEntries(index)) {
    assert.deepEqual(chooseStyle(index, entry.id), { entry: first, unknown: entry.id });
  }
});

test('the render check and the site build read a coming-soon entry as a picture, never as a style', async () => {
  // check-styles walks index.styles only, so it loads no manifest for a coming-soon character.
  const check = await readFile(new URL('bin/check-styles.js', rootUrl), 'utf8');
  assert.doesNotMatch(check, /comingSoon/);
  const { stdout } = await run(process.execPath, [cli, 'styles/index.json'], { cwd: fileURLToPath(rootUrl) });
  assert.match(stdout, /Styles checked: 1\n/);
  // The site build copies the picture and reads nothing else of the entry.
  const build = await readFile(new URL('bin/build-site.js', rootUrl), 'utf8');
  assert.match(build, /for \(const entry of comingSoonEntries\(index\)\) \{\n\s*let pictureUrl;\n\s*try \{\n\s*pictureUrl = resolvePictureUrl\(entry, indexUrl\);/);
});
