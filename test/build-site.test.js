import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { REDIRECT_PAGE, buildSite } from '../bin/build-site.js';
import { resolveLayerUrl } from '../src/manifest.js';
import { resolveManifestUrl } from '../src/styles.js';

const run = promisify(execFile);
const repo = fileURLToPath(new URL('..', import.meta.url));
const script = join(repo, 'bin', 'build-site.js');

/** Each file under a folder, relative to it, with forward slashes. */
async function listFiles(dir) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .sort();
}

/**
 * A copy of the repository's site sources, with extra files the site must
 * leave out. Its styles/index.json lists the two fixture styles, the way
 * fixtures/index.json does, so the tests can change small styles.
 */
async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), 'agent-pfp-site-'));
  for (const dir of ['web', 'src', 'styles', 'fixtures']) {
    await cp(join(repo, dir), join(root, dir), { recursive: true });
  }
  await cp(join(repo, 'fixtures', 'index.json'), join(root, 'styles', 'index.json'));
  for (const dir of ['node_modules/pngjs', 'test', 'factory', 'bin', 'docs', '.git']) {
    await mkdir(join(root, dir), { recursive: true });
    await writeFile(join(root, dir, 'file.txt'), 'x');
  }
  await writeFile(join(root, '.env'), 'x');
  await writeFile(join(root, 'README.md'), 'x');
  await writeFile(join(root, 'web', '.DS_Store'), 'x');
  await writeFile(join(root, 'styles', 'notes.txt'), 'x');
  await writeFile(join(root, 'fixtures', 'shapes', 'layers', 'unused.png'), 'x');
  return root;
}

const outsideDirs = [];
test.after(() => Promise.all(outsideDirs.map((dir) => rm(dir, { recursive: true, force: true }))));

/** A file outside the given root, which a site must never hold. */
async function outsideFile() {
  const dir = await mkdtemp(join(tmpdir(), 'agent-pfp-outside-'));
  outsideDirs.push(dir);
  const path = join(dir, 'secret.txt');
  await writeFile(path, 'not for the site');
  return path;
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Run the command in a folder; resolves to { code, stdout, stderr }. */
async function runBuild(cwd) {
  try {
    const { stdout, stderr } = await run(process.execPath, [script], { cwd });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

/** The style files the index lists, found the way the builder page finds them. */
async function expectedStyleFiles(root) {
  const indexUrl = new URL('styles/index.json', `file://${root.split(sep).join('/')}/`);
  const index = JSON.parse(await readFile(fileURLToPath(indexUrl), 'utf8'));
  const files = new Set(['styles/index.json']);
  for (const entry of index.styles) {
    const manifestUrl = resolveManifestUrl(entry, indexUrl);
    files.add(entry.manifest);
    const manifest = JSON.parse(await readFile(fileURLToPath(manifestUrl), 'utf8'));
    for (const group of manifest.groups) {
      for (const option of group.options) {
        files.add(relative(root, fileURLToPath(resolveLayerUrl(option.src, manifestUrl))).split(sep).join('/'));
      }
    }
  }
  return files;
}

test('package.json runs bin/build-site.js and git ignores _site/', async () => {
  const pkg = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['build:site'], 'node bin/build-site.js');
  const ignore = (await readFile(join(repo, '.gitignore'), 'utf8')).split('\n');
  assert.ok(ignore.includes('/_site/'), '.gitignore lists /_site/');
});

test('the site holds web/, src/, the index, its manifests and their layers, and nothing else', async () => {
  const root = await makeRoot();
  try {
    const { code, stderr } = await runBuild(root);
    assert.equal(code, 0, stderr);
    const site = join(root, '_site');
    const files = await listFiles(site);

    const codeFiles = [];
    for (const dir of ['web', 'src']) {
      for (const file of await listFiles(join(repo, dir))) codeFiles.push(`${dir}/${file}`);
    }
    const styleFiles = await expectedStyleFiles(root);
    const expected = new Set([...codeFiles, ...styleFiles, 'index.html']);
    assert.deepEqual(files, [...expected].sort());
    for (const file of [...codeFiles, ...styleFiles]) {
      assert.deepEqual(await readFile(join(site, file)), await readFile(join(root, file)), file);
    }

    for (const file of files) {
      const top = file.split('/')[0];
      assert.ok(!['node_modules', 'test', 'factory', 'bin', 'docs'].includes(top), file);
      assert.ok(!file.split('/').some((part) => part.startsWith('.')), file);
    }
    assert.ok(!files.includes('fixtures/shapes/layers/unused.png'), 'a layer no manifest names stays out');
    assert.ok(!files.includes('fixtures/broken/manifest.json'), 'a style the index does not list stays out');
    assert.ok(!files.includes('styles/alien/manifest.json'), 'a style the index does not list stays out');
    assert.ok(!files.includes('fixtures/index.json'));
    assert.ok(!files.includes('fixtures/make-fixtures.js'));
    assert.ok(!files.includes('styles/notes.txt'));
    assert.ok(!files.includes('README.md'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the build of this repository holds each file the builder asks for', async () => {
  const out = await mkdtemp(join(tmpdir(), 'agent-pfp-site-out-'));
  try {
    await buildSite({ root: repo, out });
    const files = new Set(await listFiles(out));
    for (const file of await expectedStyleFiles(repo)) assert.ok(files.has(file), file);
    assert.ok(files.has('styles/alien/manifest.json'));
    // The fixtures are test data and stay off the public site.
    assert.ok(![...files].some((file) => file.startsWith('fixtures/')), 'no fixture file in the site');
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test('a layer that is a symlink to another file in the repository is copied as that file', async () => {
  const root = await makeRoot();
  try {
    const manifest = JSON.parse(await readFile(join(root, 'fixtures', 'blocks', 'manifest.json'), 'utf8'));
    const [first, second] = manifest.groups[0].options.map((option) => option.src);
    const layer = join(root, 'fixtures', 'blocks', ...first.split('/'));
    await rm(layer);
    await symlink(join(root, 'fixtures', 'blocks', ...second.split('/')), layer);
    const { code, stderr } = await runBuild(root);
    assert.equal(code, 0, stderr);
    const copied = await lstat(join(root, '_site', 'fixtures', 'blocks', ...first.split('/')));
    assert.ok(copied.isFile(), 'the site holds a file, not a symlink');
    assert.deepEqual(
      await readFile(join(root, '_site', 'fixtures', 'blocks', ...first.split('/'))),
      await readFile(join(root, 'fixtures', 'blocks', ...second.split('/'))),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the build empties _site/ first', async () => {
  const root = await makeRoot();
  try {
    await mkdir(join(root, '_site', 'old'), { recursive: true });
    await writeFile(join(root, '_site', 'old', 'stale.txt'), 'x');
    await writeFile(join(root, '_site', '.stale'), 'x');
    const { code, stderr } = await runBuild(root);
    assert.equal(code, 0, stderr);
    assert.equal(await exists(join(root, '_site', 'old')), false);
    assert.equal(await exists(join(root, '_site', '.stale')), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('index.html sends the visitor to web/ with a relative link and shows a plain link', async () => {
  const out = await mkdtemp(join(tmpdir(), 'agent-pfp-site-out-'));
  try {
    await buildSite({ root: repo, out });
    const page = await readFile(join(out, 'index.html'), 'utf8');
    assert.equal(page, REDIRECT_PAGE);
    assert.match(page, /<meta http-equiv="refresh" content="0; url=web\/" \/>/);
    assert.match(page, /<a href="web\/">[^<]+<\/a>/);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

/**
 * The one absolute link in the site: the Adobe Fonts kit the builder page
 * loads its typeface from (web/index.html). Any other absolute link, a
 * second kit included, fails the test below.
 */
const ADOBE_FONTS_KIT = 'https://use.typekit.net/dll3tpt.css';

test('each path in the site is relative, so it works from a sub-path', async () => {
  const out = await mkdtemp(join(tmpdir(), 'agent-pfp-site-out-'));
  try {
    await buildSite({ root: repo, out });
    const files = new Set(await listFiles(out));

    // Links in the pages.
    for (const page of ['index.html', 'web/index.html']) {
      const html = await readFile(join(out, page), 'utf8');
      const links = [...html.matchAll(/(?:href|src)="([^"]*)"|url=([^"\s;]+)/g)].map((match) => match[1] ?? match[2]);
      assert.ok(links.length > 0, `${page} has links`);
      const absolute = links.filter((value) => value.startsWith('/') || /^[a-z]+:/i.test(value));
      // The builder page has the kit, once, and nothing else absolute. The redirect page has nothing absolute.
      assert.deepEqual(absolute, page === 'web/index.html' ? [ADOBE_FONTS_KIT] : [], page);
    }

    // Each module the page loads is a relative import of a file in the site.
    const seen = new Set();
    // The page starts the thumbnail worker from its own file, so the worker is a module of its own.
    const queue = ['web/builder.js', 'web/thumbnail-worker.js'];
    while (queue.length > 0) {
      const file = queue.pop();
      if (seen.has(file)) continue;
      seen.add(file);
      assert.ok(files.has(file), `the site holds ${file}`);
      const source = await readFile(join(out, file), 'utf8');
      for (const [, spec] of source.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+'([^']+)'/gm)) {
        assert.ok(spec.startsWith('./') || spec.startsWith('../'), `${file} imports ${spec}`);
        queue.push(new URL(spec, `https://x/${file}`).pathname.slice(1));
      }
    }

    // The page served from a sub-path finds the index, the manifests and the layers in the site.
    const base = 'https://camduncalfe.github.io/agent-pfp/';
    const builder = await readFile(join(out, 'web', 'builder.js'), 'utf8');
    const indexPath = /const STYLE_INDEX = '([^']+)'/.exec(builder)[1];
    assert.ok(indexPath.startsWith('../'));
    const indexUrl = new URL(indexPath, `${base}web/`);
    assert.equal(indexUrl.href, `${base}styles/index.json`);
    const inSite = (url) => {
      assert.ok(url.href.startsWith(base), url.href);
      return url.href.slice(base.length);
    };
    const index = JSON.parse(await readFile(join(out, inSite(indexUrl)), 'utf8'));
    for (const entry of index.styles) {
      const manifestUrl = resolveManifestUrl(entry, indexUrl);
      assert.ok(files.has(inSite(manifestUrl)), manifestUrl.href);
      const manifest = JSON.parse(await readFile(join(out, inSite(manifestUrl)), 'utf8'));
      for (const group of manifest.groups) {
        for (const option of group.options) {
          const layerUrl = resolveLayerUrl(option.src, manifestUrl);
          assert.ok(files.has(inSite(layerUrl)), layerUrl.href);
        }
      }
    }
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test('the build says what is wrong and exits 1 when the index, a manifest or a file is wrong', async (t) => {
  const cases = [
    {
      name: 'an index that is not JSON',
      change: (root) => writeFile(join(root, 'styles', 'index.json'), '{ nope'),
      says: /index\.json is not valid JSON/,
    },
    {
      name: 'an index that is not valid',
      change: (root) => writeJson(join(root, 'styles', 'index.json'), { version: 1, styles: [] }),
      says: /not a valid style index: styles must list at least one style/,
    },
    {
      name: 'an index that is missing',
      change: (root) => rm(join(root, 'styles', 'index.json')),
      says: /the style index .*index\.json is missing/,
    },
    {
      name: 'a manifest path that leaves the site',
      change: (root) =>
        writeJson(join(root, 'styles', 'index.json'), {
          version: 1,
          styles: [{ id: 'fixture-shapes', name: 'Shapes', manifest: '../shapes/manifest.json' }],
        }),
      says: /not a valid style index: styles\[0\]\.manifest/,
    },
    {
      name: 'a manifest that is missing',
      change: (root) => rm(join(root, 'fixtures', 'blocks', 'manifest.json')),
      says: /the manifest .*blocks.manifest\.json is missing/,
    },
    {
      name: 'a manifest that is not valid',
      change: async (root) => {
        const path = join(root, 'fixtures', 'shapes', 'manifest.json');
        const manifest = JSON.parse(await readFile(path, 'utf8'));
        manifest.groups[0].options[0].src = '../escape.png';
        await writeJson(path, manifest);
      },
      says: /shapes.manifest\.json is not a valid manifest: groups\[0\]\.options\[0\]\.src/,
    },
    {
      name: 'a manifest for another style',
      change: async (root) => {
        const path = join(root, 'fixtures', 'shapes', 'manifest.json');
        const manifest = JSON.parse(await readFile(path, 'utf8'));
        manifest.style = 'someone-else';
        await writeJson(path, manifest);
      },
      says: /the index lists this style as "fixture-shapes" and its manifest says "someone-else"/,
    },
    {
      name: 'a layer that is missing',
      change: async (root) => {
        const manifest = JSON.parse(await readFile(join(root, 'fixtures', 'blocks', 'manifest.json'), 'utf8'));
        const option = manifest.groups[0].options[0];
        await rm(join(root, 'fixtures', 'blocks', ...option.src.split('/')));
        return `layer "${manifest.groups[0].id}/${option.id}"`;
      },
      says: /is missing/,
    },
    {
      name: 'a layer path that is a folder',
      change: async (root) => {
        const path = join(root, 'fixtures', 'blocks', 'manifest.json');
        const manifest = JSON.parse(await readFile(path, 'utf8'));
        manifest.groups[0].options[0].src = 'layers';
        await writeJson(path, manifest);
      },
      says: /is not a file/,
    },
    {
      name: 'a layer that is a symlink to a file outside the repository',
      change: async (root) => {
        const manifest = JSON.parse(await readFile(join(root, 'fixtures', 'blocks', 'manifest.json'), 'utf8'));
        const layer = join(root, 'fixtures', 'blocks', ...manifest.groups[0].options[0].src.split('/'));
        await rm(layer);
        await symlink(await outsideFile(root), layer);
      },
      says: /layer ".*" .* leads to .*secret\.txt, which is outside/,
    },
    {
      name: 'a manifest in a folder that is a symlink out of the repository',
      change: async (root) => {
        const outside = await mkdtemp(join(tmpdir(), 'agent-pfp-outside-'));
        outsideDirs.push(outside);
        await cp(join(root, 'fixtures', 'blocks'), outside, { recursive: true });
        await rm(join(root, 'fixtures', 'blocks'), { recursive: true });
        await symlink(outside, join(root, 'fixtures', 'blocks'));
      },
      says: /the manifest .*blocks.manifest\.json leads to .*, which is outside/,
    },
    {
      name: 'an index that is a symlink to a file outside the repository',
      change: async (root) => {
        const outside = await outsideFile(root);
        await writeFile(outside, await readFile(join(root, 'styles', 'index.json')));
        await rm(join(root, 'styles', 'index.json'));
        await symlink(outside, join(root, 'styles', 'index.json'));
      },
      says: /the style index .* leads to .*secret\.txt, which is outside/,
    },
    {
      name: 'a symlink inside web/',
      change: async (root) => symlink(await outsideFile(root), join(root, 'web', 'secret.txt')),
      says: /web.secret\.txt is a symlink/,
    },
    {
      name: 'a missing src/ folder, after web/ would have been copied',
      change: (root) => rm(join(root, 'src'), { recursive: true }),
      says: /src is missing/,
    },
    {
      name: 'a layer at index.html, where the build writes its own page',
      change: async (root) => {
        const manifest = JSON.parse(await readFile(join(root, 'fixtures', 'shapes', 'manifest.json'), 'utf8'));
        for (const group of manifest.groups) {
          for (const option of group.options) option.src = `fixtures/shapes/${option.src}`;
        }
        manifest.groups[0].options[0].src = 'index.html';
        await writeJson(join(root, 'manifest.json'), manifest);
        await writeFile(join(root, 'index.html'), 'a layer');
        const index = JSON.parse(await readFile(join(root, 'styles', 'index.json'), 'utf8'));
        index.styles[0].manifest = 'manifest.json';
        await writeJson(join(root, 'styles', 'index.json'), index);
      },
      says: /manifest\.json: layer ".*" is index\.html, which the build writes itself/,
    },
  ];
  for (const { name, change, says } of cases) {
    await t.test(name, async () => {
      const root = await makeRoot();
      try {
        const extra = await change(root);
        const { code, stdout, stderr } = await runBuild(root);
        assert.equal(code, 1, stdout);
        assert.match(stderr, /^Site not built: /);
        assert.match(stderr, says);
        if (extra) assert.ok(stderr.includes(extra), stderr);
        assert.deepEqual(await listFiles(join(root, '_site')), [], 'nothing is left in _site/');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});
