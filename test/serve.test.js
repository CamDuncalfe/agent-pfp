import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  createHandler,
  openInside,
  readStyleFolders,
  resolveLocalStylePath,
  resolveRequestPath,
  resolveStylesDir,
} from '../bin/serve.js';

const run = promisify(execFile);

const root = `${sep}srv${sep}app`;

test('request paths map to files inside the root', () => {
  assert.equal(resolveRequestPath(root, '/web/index.html'), join(root, 'web', 'index.html'));
  assert.equal(resolveRequestPath(root, '/web/?manifest=x'), join(root, 'web'));
  assert.equal(resolveRequestPath(root, '/'), root);
});

test('paths that try to leave the root or reach hidden files are refused', () => {
  for (const url of ['/../etc/passwd', '/%2e%2e/%2e%2e/etc/passwd', '/web/..%2f..%2fetc', '/.git/config', '/node_modules/x/index.js', '/%00', '/%E0%A4%A']) {
    const target = resolveRequestPath(root, url);
    assert.ok(target === null || target === root || target.startsWith(root + sep), url);
    if (url.includes('.git') || url.includes('node_modules') || url.includes('%00') || url.includes('%E0')) {
      assert.equal(target, null, url);
    }
  }
});

// --- A styles folder kept outside the repository ---

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const serveCli = fileURLToPath(new URL('../bin/serve.js', import.meta.url));

/** A temp folder of styles made from the fixture shapes, plus the awkward cases. */
async function makeStylesFolder(t) {
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'agent-pfp-outside-')));
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'agent-pfp-local-')));
  t.after(() => Promise.all([outside, folder].map((path) => rm(path, { recursive: true, force: true }))));
  const shapes = join(repoRoot, 'fixtures', 'shapes');
  const manifest = JSON.parse(await readFile(join(shapes, 'manifest.json'), 'utf8'));

  // One good style.
  await cp(shapes, join(folder, 'tidy'), { recursive: true });
  await writeFile(join(folder, 'tidy', 'manifest.json'), JSON.stringify({ ...manifest, style: 'local-tidy', name: 'Tidy' }));
  // Files the server has no business sending.
  await writeFile(join(folder, 'tidy', 'notes.txt'), 'private notes');
  await writeFile(join(folder, 'tidy', '.secret.json'), '{}');
  // Folders the index leaves out.
  await mkdir(join(folder, 'not-json'));
  await writeFile(join(folder, 'not-json', 'manifest.json'), '{ nope');
  await mkdir(join(folder, 'not-valid'));
  await writeFile(join(folder, 'not-valid', 'manifest.json'), JSON.stringify({ ...manifest, version: 7 }));
  await cp(shapes, join(folder, 'same-id-as-repo'), { recursive: true });
  await mkdir(join(folder, 'no-manifest'));
  // A symlink that points out of the folder.
  await writeFile(join(outside, 'secret.json'), '{"secret":true}');
  await symlink(join(outside, 'secret.json'), join(folder, 'tidy', 'link.json'));
  await symlink(outside, join(folder, 'tidy', 'linked-folder'));
  // A style whose manifest is a symlink to a valid manifest outside the folder.
  await writeFile(join(outside, 'manifest.json'), JSON.stringify({ ...manifest, style: 'linked-out', name: 'Linked out' }));
  await mkdir(join(folder, 'manifest-elsewhere'));
  await symlink(join(outside, 'manifest.json'), join(folder, 'manifest-elsewhere', 'manifest.json'));
  // A style whose manifest is a symlink that stays inside the folder is fine.
  await mkdir(join(folder, 'manifest-nearby'));
  await writeFile(join(folder, 'nearby.json'), JSON.stringify({ ...manifest, style: 'linked-in', name: 'Linked in' }));
  await symlink(join(folder, 'nearby.json'), join(folder, 'manifest-nearby', 'manifest.json'));
  return { folder, outside };
}

async function startServer(t, options) {
  const warnings = [];
  const handle = createHandler({ root: repoRoot, warn: (line) => warnings.push(line), ...options });
  const server = createServer((request, response) => {
    handle(request, response).catch(() => response.destroy());
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((done) => server.close(done));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, warnings };
}

/** GET a path exactly as written. fetch would fold "..", "%2e%2e" and the like before sending. */
function rawGet(base, path) {
  const { hostname, port } = new URL(base);
  return new Promise((done, fail) => {
    const outgoing = httpRequest({ hostname, port, path, method: 'GET' }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => (body += chunk));
      response.on('end', () => done({ status: response.statusCode, body }));
    });
    outgoing.on('error', fail);
    outgoing.end();
  });
}

test('local style paths stay inside the styles folder and are .json or .png', () => {
  const dir = `${sep}srv${sep}styles`;
  assert.equal(resolveLocalStylePath(dir, '/web/index.html'), undefined);
  assert.equal(resolveLocalStylePath(dir, '/local-stylesx/a.json'), undefined);
  assert.equal(resolveLocalStylePath(dir, '/local-styles/a/manifest.json'), join(dir, 'a', 'manifest.json'));
  assert.equal(resolveLocalStylePath(dir, '/local-styles/a/layers/eyes/dots.PNG'), join(dir, 'a', 'layers', 'eyes', 'dots.PNG'));
  for (const url of [
    '/local-styles',
    '/local-styles/',
    '/local-styles/a/notes.txt',
    '/local-styles/a/page.html',
    '/local-styles/a/manifest',
    '/local-styles/a/.secret.json',
    '/local-styles/.hidden/manifest.json',
    '/local-styles/../package.json',
    '/local-styles/%2e%2e/package.json',
    '/local-styles/a/%2e%2e/%2e%2e/package.json',
    '/local-styles/a/..%2f..%2fpackage.json',
    '/local-styles/a%5c..%5c..%5cpackage.json',
    '/local-styles/%00.json',
  ]) {
    const target = resolveLocalStylePath(dir, url);
    // WHATWG URL parsing folds "/local-styles/../x" to "/x", which is then not a local style request.
    assert.ok(target === null || target === undefined, `${url} -> ${target}`);
  }
});

test('with a styles folder the server lists its styles and serves their files', async (t) => {
  const { folder } = await makeStylesFolder(t);
  const { base, warnings } = await startServer(t, { stylesDir: folder });

  const response = await fetch(`${base}/local-styles/index.json`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^application\/json/);
  assert.deepEqual(await response.json(), {
    version: 1,
    styles: [
      { id: 'linked-in', name: 'Linked in', manifest: 'local-styles/manifest-nearby/manifest.json' },
      { id: 'local-tidy', name: 'Tidy', manifest: 'local-styles/tidy/manifest.json' },
    ],
  });
  // A style in the list can be loaded: its manifest is served.
  assert.equal((await fetch(`${base}/local-styles/manifest-nearby/manifest.json`)).status, 200);
  assert.equal((await fetch(`${base}/local-styles/manifest-elsewhere/manifest.json`)).status, 404);
  assert.deepEqual(warnings, [
    'Left out local style folder "manifest-elsewhere": manifest.json points outside the styles folder',
    'Left out local style folder "not-json": manifest.json is not valid JSON',
    'Left out local style folder "not-valid": manifest.json is not valid (version must be 1)',
    'Left out local style folder "same-id-as-repo": the style id "fixture-shapes" is already used by another style',
  ]);

  // The same warnings are not printed again on the next request.
  await (await fetch(`${base}/local-styles/index.json`)).arrayBuffer();
  assert.equal(warnings.length, 4);

  const manifest = await fetch(`${base}/local-styles/tidy/manifest.json`);
  assert.equal(manifest.status, 200);
  assert.equal((await manifest.json()).style, 'local-tidy');

  const layer = await fetch(`${base}/local-styles/tidy/layers/eyes/dots.png`);
  assert.equal(layer.status, 200);
  assert.equal(layer.headers.get('content-type'), 'image/png');
  const expected = await readFile(join(folder, 'tidy', 'layers', 'eyes', 'dots.png'));
  assert.deepEqual(Buffer.from(await layer.arrayBuffer()), expected);

  const head = await fetch(`${base}/local-styles/tidy/layers/eyes/dots.png`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(expected.length));
  assert.equal((await head.arrayBuffer()).byteLength, 0);

  // A style added while the server runs shows up on the next request.
  await cp(join(folder, 'tidy'), join(folder, 'later'), { recursive: true });
  const laterManifest = JSON.parse(await readFile(join(folder, 'later', 'manifest.json'), 'utf8'));
  await writeFile(join(folder, 'later', 'manifest.json'), JSON.stringify({ ...laterManifest, style: 'a-later', name: 'Later' }));
  const again = await (await fetch(`${base}/local-styles/index.json`)).json();
  assert.deepEqual(again.styles.map((entry) => entry.id), ['a-later', 'linked-in', 'local-tidy']);
});

test('the server refuses everything else under /local-styles/', async (t) => {
  const { folder, outside } = await makeStylesFolder(t);
  const { base } = await startServer(t, { stylesDir: folder });
  for (const path of [
    '/local-styles/',
    '/local-styles/tidy/',
    '/local-styles/tidy/notes.txt',
    '/local-styles/tidy/.secret.json',
    '/local-styles/tidy/link.json',
    '/local-styles/tidy/linked-folder/secret.json',
    '/local-styles/tidy/missing.png',
    '/local-styles/tidy/layers',
  ]) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 404, path);
    assert.doesNotMatch(await response.text(), /secret|private/, path);
  }
  // The secret file sits in a folder next to the styles folder. Ask for it
  // with each spelling of "..", sent as written.
  const sibling = basename(outside);
  for (const path of [
    `/local-styles/../${sibling}/secret.json`,
    `/local-styles/tidy/../../${sibling}/secret.json`,
    `/local-styles/%2e%2e/${sibling}/secret.json`,
    `/local-styles/tidy/%2e%2e/%2e%2e/${sibling}/secret.json`,
    `/local-styles/..%2f${sibling}%2fsecret.json`,
    `/local-styles/tidy/..%2f..%2f${sibling}/secret.json`,
    `/local-styles/tidy/%2e%2e%2f%2e%2e%2f${sibling}%2fsecret.json`,
    `/local-styles/tidy/..%5c..%5c${sibling}%5csecret.json`,
    `/local-styles//${sibling}/secret.json`,
  ]) {
    const response = await rawGet(base, path);
    assert.equal(response.status, 404, path);
    assert.doesNotMatch(response.body, /secret/, path);
  }
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const response = await fetch(`${base}/local-styles/tidy/manifest.json`, { method });
    assert.equal(response.status, 405, method);
  }
  // Nothing was written into the styles folder or the repository's index.
  assert.deepEqual((await readdir(join(folder, 'tidy'))).sort(), ['.secret.json', 'layers', 'link.json', 'linked-folder', 'manifest.json', 'notes.txt']);
});

test('without a styles folder the server has no local styles and still serves the page', async (t) => {
  const { base, warnings } = await startServer(t, {});
  assert.equal((await fetch(`${base}/local-styles/index.json`)).status, 404);
  assert.equal((await fetch(`${base}/local-styles/tidy/manifest.json`)).status, 404);
  assert.equal((await fetch(`${base}/web/`)).status, 200);
  assert.equal((await fetch(`${base}/styles/index.json`)).status, 200);
  assert.deepEqual(warnings, []);
});

test('the styles folder has to exist and be a folder', async (t) => {
  const { folder } = await makeStylesFolder(t);
  assert.equal(await resolveStylesDir(undefined), null);
  assert.equal(await resolveStylesDir(''), null);
  assert.equal(await resolveStylesDir(folder), folder);
  await assert.rejects(resolveStylesDir(join(folder, 'missing')), /does not exist/);
  await assert.rejects(resolveStylesDir(join(folder, 'tidy', 'manifest.json')), /is not a folder/);
});

test('the command exits with 2 when the styles folder is missing', async (t) => {
  const { folder } = await makeStylesFolder(t);
  const runServe = async (args, env = {}) => {
    try {
      await run(process.execPath, [serveCli, ...args], { env: { ...process.env, STYLES_DIR: '', ...env }, timeout: 5000 });
      return { code: 0, stderr: '' };
    } catch (error) {
      return { code: error.code, stderr: error.stderr };
    }
  };
  const missing = await runServe(['--styles', join(folder, 'missing')]);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /does not exist/);
  const notFolder = await runServe([], { STYLES_DIR: join(folder, 'tidy', 'manifest.json') });
  assert.equal(notFolder.code, 2);
  assert.match(notFolder.stderr, /is not a folder/);
  assert.equal((await runServe(['--nope'])).code, 2);
  assert.equal((await runServe([], { PORT: 'abc' })).code, 2);
});

test('a manifest that is a symlink out of the styles folder is reported, not read', async (t) => {
  const { folder } = await makeStylesFolder(t);
  const folders = await readStyleFolders(folder);
  const byName = Object.fromEntries(folders.map((entry) => [entry.folder, entry]));
  assert.deepEqual(byName['manifest-elsewhere'], {
    folder: 'manifest-elsewhere',
    error: 'manifest.json points outside the styles folder',
  });
  assert.equal(byName['manifest-nearby'].manifest.style, 'linked-in');
  assert.equal(byName['no-manifest'], undefined);
});

test('a file is read from the handle that was checked', async (t) => {
  const { folder, outside } = await makeStylesFolder(t);
  const target = join(folder, 'tidy', 'manifest.json');

  const file = await openInside(folder, target);
  t.after(() => file.handle.close().catch(() => {}));
  assert.equal(file.path, target);
  // Swap the path for a symlink to the secret after the check. The open
  // handle still reads the file that was checked.
  await rm(target);
  await symlink(join(outside, 'secret.json'), target);
  const text = await file.handle.readFile('utf8');
  assert.equal(JSON.parse(text).style, 'local-tidy');
  assert.doesNotMatch(text, /secret/);

  // The path is a symlink out of the folder now, so it is refused.
  await assert.rejects(openInside(folder, target), /outside the folder/);
  await assert.rejects(openInside(folder, join(folder, 'tidy', 'link.json')), /outside the folder/);
  await assert.rejects(openInside(folder, join(folder, 'tidy', 'layers')), /not a file/);
  await assert.rejects(openInside(folder, join(folder, 'tidy', 'missing.png')));
});
