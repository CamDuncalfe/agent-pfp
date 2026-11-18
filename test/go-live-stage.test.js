import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const repo = fileURLToPath(new URL('..', import.meta.url));
const script = join(repo, '.claude/skills/character-go-live-check/stage.mjs');
const checkStyles = join(repo, 'bin/check-styles.js');
const shapes = join(repo, 'fixtures/shapes');

async function stage(args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [script, ...args], { cwd: repo });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

async function emptyFolder() {
  return mkdtemp(join(tmpdir(), 'go-live-stage-'));
}

test('stages an export under the public id and name, and the render check reads it', async () => {
  const out = await emptyFolder();
  const result = await stage([shapes, 'shapes-public', 'Shapes', out]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Working id "fixture-shapes"/);
  assert.match(result.stdout, /Copied 10 layers/);
  assert.match(result.stdout, /Staged shapes-public\n$/);

  const manifest = JSON.parse(await readFile(join(out, 'styles/shapes-public/manifest.json'), 'utf8'));
  assert.equal(manifest.style, 'shapes-public');
  assert.equal(manifest.name, 'Shapes');
  const index = JSON.parse(await readFile(join(out, 'styles/index.json'), 'utf8'));
  assert.deepEqual(index, { version: 1, styles: [{ id: 'shapes-public', name: 'Shapes', manifest: 'styles/shapes-public/manifest.json' }] });

  const { stdout } = await run(process.execPath, [checkStyles, join(out, 'styles/index.json')], { cwd: repo });
  assert.match(stdout, /Styles checked: 1/);
});

test('copies only the layers the manifest names and lists the rest', async () => {
  const exportFolder = await emptyFolder();
  await cp(shapes, exportFolder, { recursive: true });
  await writeFile(join(exportFolder, 'layers-unused.png'), 'not a layer');
  const out = await emptyFolder();
  const result = await stage([exportFolder, 'shapes', 'Shapes', out]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /left out: .*layers-unused\.png/);
  assert.ok(!(await readdir(join(out, 'styles/shapes'))).includes('layers-unused.png'));
});

test('marks see-through options only in a group that lists groups in over', async () => {
  const exportFolder = await emptyFolder();
  await cp(shapes, exportFolder, { recursive: true });
  const manifestPath = join(exportFolder, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.groups.find((group) => group.id === 'headwear').over = ['eyes'];
  await writeFile(manifestPath, JSON.stringify(manifest));

  const out = await emptyFolder();
  const marked = await stage([exportFolder, 'shapes', 'Shapes', out, '--see-through', 'cap']);
  assert.equal(marked.code, 0, marked.stderr);
  assert.match(marked.stdout, /Marked see-through: headwear\/cap/);
  const staged = JSON.parse(await readFile(join(out, 'styles/shapes/manifest.json'), 'utf8'));
  const cap = staged.groups.find((group) => group.id === 'headwear').options.find((option) => option.id === 'cap');
  assert.equal(cap.seeThrough, true);

  const noOver = await stage([exportFolder, 'shapes', 'Shapes', await emptyFolder(), '--see-through', 'dots']);
  assert.equal(noOver.code, 2);
  assert.match(noOver.stderr, /lists no groups in "over"/);

  const unknown = await stage([exportFolder, 'shapes', 'Shapes', await emptyFolder(), '--see-through', 'nope']);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /No option "nope"/);
});

test('refuses an out folder inside the repository or one that is not empty', async () => {
  const inside = await stage([shapes, 'shapes', 'Shapes', join(repo, 'staged-here')]);
  assert.equal(inside.code, 2);
  assert.match(inside.stderr, /inside the repository/);

  const out = await emptyFolder();
  await writeFile(join(out, 'already.txt'), 'x');
  const full = await stage([shapes, 'shapes', 'Shapes', out]);
  assert.equal(full.code, 2);
  assert.match(full.stderr, /is not empty/);
});

test('refuses a bad id and a missing argument', async () => {
  const badId = await stage([shapes, 'Shapes', 'Shapes', await emptyFolder()]);
  assert.equal(badId.code, 2);
  assert.match(badId.stderr, /is not a style id/);

  const missing = await stage([shapes, 'shapes', 'Shapes']);
  assert.equal(missing.code, 2);
});
