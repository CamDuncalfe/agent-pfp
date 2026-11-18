import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { crc32, deflateSync } from 'node:zlib';

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
  assert.match(result.stdout, /Working words left in the stage: none/);
  assert.match(result.stdout, /Combinations: 48/);
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
  const marked = await stage([exportFolder, 'shapes', 'Shapes', out, '--see-through', 'headwear/cap']);
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

test('refuses an out folder that is missing, not empty or inside the repository through a link', async () => {
  const missing = await stage([shapes, 'shapes', 'Shapes', join(tmpdir(), 'go-live-stage-not-made-yet')]);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /Make it with mktemp -d first/);

  const out = await emptyFolder();
  await writeFile(join(out, 'already.txt'), 'x');
  const full = await stage([shapes, 'shapes', 'Shapes', out]);
  assert.equal(full.code, 2);
  assert.match(full.stderr, /is not empty/);

  const linkFolder = await emptyFolder();
  const link = join(linkFolder, 'into-repo');
  await symlink(join(repo, 'docs'), link);
  const linked = await stage([shapes, 'shapes', 'Shapes', link]);
  assert.equal(linked.code, 2);
  assert.match(linked.stderr, /is inside the repository/);
});

test('refuses a layer that is a symlink', async () => {
  const exportFolder = await emptyFolder();
  await cp(shapes, exportFolder, { recursive: true });
  const manifest = JSON.parse(await readFile(join(exportFolder, 'manifest.json'), 'utf8'));
  const layer = join(exportFolder, ...manifest.groups[0].options[0].src.split('/'));
  await rm(layer);
  await symlink(join(repo, 'package.json'), layer);
  const result = await stage([exportFolder, 'shapes', 'Shapes', await emptyFolder()]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /is not a plain file/);
});

test('fails when a word of the working name is left in a staged path', async () => {
  const exportFolder = await emptyFolder();
  await cp(shapes, exportFolder, { recursive: true });
  const manifestPath = join(exportFolder, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const option = manifest.groups[0].options[0];
  await rename(join(exportFolder, ...option.src.split('/')), join(exportFolder, 'layers', 'fixture-grey.png'));
  option.src = 'layers/fixture-grey.png';
  await writeFile(manifestPath, JSON.stringify(manifest));

  const result = await stage([exportFolder, 'shapes', 'Shapes', await emptyFolder()]);
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stdout, /Working words to find: fixture, test, data, not, artwork/);
  assert.match(result.stdout, /Working words left in the stage: styles\/shapes\/layers\/fixture-grey\.png \(fixture\)/);
});

test('refuses a bad id and a missing argument', async () => {
  const badId = await stage([shapes, 'Shapes', 'Shapes', await emptyFolder()]);
  assert.equal(badId.code, 2);
  assert.match(badId.stderr, /is not a style id/);

  const missing = await stage([shapes, 'shapes', 'Shapes']);
  assert.equal(missing.code, 2);
});

test('options with the same id in two groups each keep their layer', async () => {
  const exportFolder = await emptyFolder();
  await cp(shapes, exportFolder, { recursive: true });
  const manifestPath = join(exportFolder, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  for (const groupId of ['eyes', 'mouth']) manifest.groups.find((group) => group.id === groupId).options[0].id = 'default';
  manifest.groups.find((group) => group.id === 'headwear').over = ['eyes'];
  manifest.groups.find((group) => group.id === 'mouth').over = ['body'];
  await writeFile(manifestPath, JSON.stringify(manifest));

  const out = await emptyFolder();
  const result = await stage([exportFolder, 'shapes', 'Shapes', out, '--see-through', 'headwear/cap']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Copied 10 layers/);
  assert.match(result.stdout, /Files the manifest does not name: none/);
  const { stdout } = await run(process.execPath, [checkStyles, join(out, 'styles/index.json')], { cwd: repo });
  assert.match(stdout, /Styles checked: 1/);

  const ambiguous = await stage([exportFolder, 'shapes', 'Shapes', await emptyFolder(), '--see-through', 'default']);
  assert.equal(ambiguous.code, 2);
  assert.match(ambiguous.stderr, /is an option in eyes and mouth\. Give it as <group>\/<option>/);

  const byGroup = await stage([exportFolder, 'shapes', 'Shapes', await emptyFolder(), '--see-through', 'mouth/default']);
  assert.equal(byGroup.code, 0, byGroup.stderr);
  assert.match(byGroup.stdout, /Marked see-through: mouth\/default/);
});

async function shapesExport(edit) {
  const exportFolder = await emptyFolder();
  await cp(shapes, exportFolder, { recursive: true });
  const manifestPath = join(exportFolder, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  await edit(manifest, exportFolder);
  await writeFile(manifestPath, JSON.stringify(manifest));
  return exportFolder;
}

function pngChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

test('takes off a see-through mark the export had on an option that was not given', async () => {
  const exportFolder = await shapesExport((manifest) => {
    const headwear = manifest.groups.find((group) => group.id === 'headwear');
    headwear.over = ['eyes'];
    headwear.options.find((option) => option.id === 'tall').seeThrough = true;
  });
  const out = await emptyFolder();
  const result = await stage([exportFolder, 'shapes', 'Shapes', out, '--see-through', 'headwear/cap']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Took off a see-through mark the export had: headwear\/tall/);
  const staged = JSON.parse(await readFile(join(out, 'styles/shapes/manifest.json'), 'utf8'));
  const headwear = staged.groups.find((group) => group.id === 'headwear').options;
  assert.equal(headwear.find((option) => option.id === 'cap').seeThrough, true);
  assert.equal(headwear.find((option) => option.id === 'tall').seeThrough, undefined);
});

test('a working word inside a longer public word is not a hit', async () => {
  const exportFolder = await shapesExport((manifest) => {
    manifest.style = 'draft-cat';
    manifest.name = 'Cat';
  });
  const result = await stage([exportFolder, 'catfish', 'Catfish', await emptyFolder()]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Working words to find: draft, cat/);
  assert.match(result.stdout, /Working words left in the stage: none/);
});

test('stops on a name outside plain ASCII and on a working word under three letters', async () => {
  const chinese = await shapesExport((manifest) => {
    manifest.name = '草稿鸭';
  });
  const refused = await stage([chinese, 'shapes', 'Shapes', await emptyFolder()]);
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /The working name "草稿鸭" has letters outside plain ASCII/);

  const accented = await stage([shapes, 'shapes', 'Café', await emptyFolder()]);
  assert.equal(accented.code, 2);
  assert.match(accented.stderr, /The public name "Café" has letters outside plain ASCII/);

  const shortWord = await shapesExport((manifest) => {
    manifest.style = 'shapes';
    manifest.name = 'Jo Shapes';
  });
  const tooShort = await stage([shortWord, 'shapes', 'Shapes', await emptyFolder()]);
  assert.equal(tooShort.code, 2);
  assert.match(tooShort.stderr, /words under three letters \(jo\)/);
});

test('refuses a layer that carries a text chunk, and a layer that is not a PNG', async () => {
  const withText = await shapesExport(async (manifest, folder) => {
    const layer = join(folder, ...manifest.groups[0].options[0].src.split('/'));
    const png = await readFile(layer);
    const iend = png.length - 12;
    const ztxt = pngChunk('zTXt', Buffer.concat([Buffer.from('Comment\0\0', 'latin1'), deflateSync('cut from the fixture sheet')]));
    await writeFile(layer, Buffer.concat([png.subarray(0, iend), ztxt, png.subarray(iend)]));
  });
  const text = await stage([withText, 'shapes', 'Shapes', await emptyFolder()]);
  assert.equal(text.code, 2);
  assert.match(text.stderr, /Layer layers\/background\/grey\.png carries zTXt/);

  const notPng = await shapesExport(async (manifest, folder) => {
    await writeFile(join(folder, ...manifest.groups[0].options[0].src.split('/')), 'not a picture');
  });
  const refused = await stage([notPng, 'shapes', 'Shapes', await emptyFolder()]);
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /Layer layers\/background\/grey\.png is not one whole PNG/);

  const tail = await shapesExport(async (manifest, folder) => {
    const layer = join(folder, ...manifest.groups[0].options[0].src.split('/'));
    await writeFile(layer, Buffer.concat([await readFile(layer), Buffer.from('draft fixture', 'latin1')]));
  });
  const afterEnd = await stage([tail, 'shapes', 'Shapes', await emptyFolder()]);
  assert.equal(afterEnd.code, 2);
  assert.match(afterEnd.stderr, /is not one whole PNG/);

  // A PNG cut short inside a chunk, one with no IEND, and one whose IEND carries data.
  const broken = {
    'cut short': (png) => png.subarray(0, png.length - 20),
    'no IEND': (png) => png.subarray(0, png.length - 12),
    'IEND with data': (png) => Buffer.concat([png.subarray(0, png.length - 12), pngChunk('IEND', Buffer.from('draft', 'latin1'))]),
  };
  for (const [what, cut] of Object.entries(broken)) {
    const folder = await shapesExport(async (manifest, exportFolder) => {
      const layer = join(exportFolder, ...manifest.groups[0].options[0].src.split('/'));
      await writeFile(layer, cut(await readFile(layer)));
    });
    const result = await stage([folder, 'shapes', 'Shapes', await emptyFolder()]);
    assert.equal(result.code, 2, what);
    assert.match(result.stderr, /is not one whole PNG/, what);
  }
});

test('a working word next to accented letters in a label is not a hit', async () => {
  const exportFolder = await shapesExport((manifest) => {
    manifest.style = 'shapes';
    manifest.name = 'Art Shapes';
    manifest.groups[0].options[0].label = 'Artéfact';
  });
  const result = await stage([exportFolder, 'shapes', 'Shapes', await emptyFolder()]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Working words to find: art\n/);
  assert.match(result.stdout, /Working words left in the stage: none/);
});
