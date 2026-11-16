import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { createRaster } from '../src/composite.js';
import { writePng } from '../src/png.js';

import {
  WAYS,
  applyBreak,
  checkBrokenCopies,
  cutHole,
  formatBrokenResult,
  isCaught,
  loadStyle,
  planBreaks,
} from '../fixtures/break-fixtures.js';
import { checkManifest } from '../src/render-check.js';

const run = promisify(execFile);
const root = new URL('../', import.meta.url);
const cli = fileURLToPath(new URL('bin/check-broken.js', root));

const shapes = await loadStyle(fileURLToPath(new URL('fixtures/shapes/manifest.json', root)));
const blocks = await loadStyle(fileURLToPath(new URL('fixtures/blocks/manifest.json', root)));
const styles = [shapes, blocks];

function check(style, layers) {
  return checkManifest(style.manifest, (src) => layers.get(src));
}

function plansFor(style, group, option) {
  return planBreaks(style).filter((plan) => plan.group === group && plan.option === option);
}

async function runCli(args = []) {
  try {
    const { stdout } = await run(process.execPath, [cli, ...args]);
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

test('every option layer gets every way that applies to its group', () => {
  const ways = (style, group, option) => plansFor(style, group, option).map((plan) => `${plan.way}:${plan.direction}`).sort();
  // Background: bleeds on all four edges, no zone, base, bottom of an opaque canvas.
  assert.deepEqual(ways(shapes, 'background', 'grey'), ['hole:', 'size:bigger', 'size:smaller']);
  // Body: bleeds at the bottom only, no zone, base group.
  assert.deepEqual(ways(shapes, 'body', 'round'), ['clip:left', 'clip:right', 'clip:top', 'size:bigger', 'size:smaller']);
  // Eyes: a zone, no bleed, and mouth and headwear may not cover it.
  assert.deepEqual(ways(shapes, 'eyes', 'dots'), [
    'clip:bottom', 'clip:left', 'clip:right', 'clip:top',
    'overlap:',
    'size:bigger', 'size:smaller',
    'zone:bottom', 'zone:left', 'zone:right', 'zone:top',
  ]);
  for (const style of styles) {
    for (const group of style.manifest.groups) {
      for (const option of group.options) {
        const plans = plansFor(style, group.id, option.id);
        const expectClip = 4 - (group.bleed ?? []).length;
        assert.equal(plans.filter((plan) => plan.way === 'clip').length, expectClip, `${group.id}/${option.id} clip`);
        assert.equal(plans.filter((plan) => plan.way === 'zone').length, group.zone ? 4 : 0, `${group.id}/${option.id} zone`);
        assert.equal(plans.filter((plan) => plan.way === 'overlap').length, group.base ? 0 : 1, `${group.id}/${option.id} overlap`);
        const bottom = style.manifest.groups[0] === group;
        assert.equal(plans.filter((plan) => plan.way === 'hole').length, bottom ? 1 : 0, `${group.id}/${option.id} hole`);
        assert.equal(plans.filter((plan) => plan.way === 'size').length, 2, `${group.id}/${option.id} size`);
      }
    }
  }
});

test('a style with a see-through canvas gets no hole copies', () => {
  const manifest = { ...shapes.manifest, canvas: { ...shapes.manifest.canvas, opaque: false } };
  assert.equal(planBreaks({ manifest, layers: shapes.layers }).filter((plan) => plan.way === 'hole').length, 0);
});

test('a copy changes one layer in memory and leaves the clean style as it was', () => {
  const before = new Map([...shapes.layers].map(([src, raster]) => [src, Buffer.from(raster.data)]));
  for (const plan of planBreaks(shapes)) {
    const layers = applyBreak(shapes, plan);
    const changed = [...layers].filter(([src, raster]) => raster !== shapes.layers.get(src)).map(([src]) => src);
    const group = shapes.manifest.groups.find((entry) => entry.id === plan.group);
    assert.deepEqual(changed, [group.options.find((entry) => entry.id === plan.option).src]);
  }
  for (const [src, raster] of shapes.layers) assert.deepEqual(Buffer.from(raster.data), before.get(src), src);
});

test('the check fails every broken copy and reports the issue it was made to cause', async () => {
  for (const style of styles) {
    for (const plan of planBreaks(style)) {
      assert.ok(plan.pixels > 0, `${plan.style} ${plan.group}/${plan.option} ${plan.way} ${plan.detail} changes pixels`);
      const report = await check(style, applyBreak(style, plan));
      const where = `${plan.style} ${plan.group}/${plan.option} ${plan.way} (${plan.detail})`;
      assert.equal(report.ok, false, where);
      assert.ok(report.issues.some((issue) => issue.kind === plan.kind), `${where} reports ${plan.kind}`);
    }
  }
});

test('the same breaks with a zero-pixel change give copies that pass', async () => {
  for (const style of styles) {
    for (const plan of planBreaks(style)) {
      const report = await check(style, applyBreak(style, plan, 0));
      assert.deepEqual(report.issues, [], `${plan.style} ${plan.group}/${plan.option} ${plan.way} (${plan.detail}) at 0 px`);
    }
  }
});

test('a copy counts as caught only when the check reports its own kind', async () => {
  const result = await checkBrokenCopies(styles);
  assert.equal(result.ok, true);
  assert.deepEqual(result.clean, [
    { style: 'fixture-shapes', ok: true },
    { style: 'fixture-blocks', ok: true },
  ]);
  for (const way of WAYS) assert.ok(result.copies.some((copy) => copy.way === way.id), `${way.id} has copies`);

  // A copy whose break is undone still counts as made, and is not caught.
  const missed = {
    ...result,
    copies: result.copies.map((copy, index) => (index === 0 ? { ...copy, caught: false, kinds: [] } : copy)),
    ok: false,
  };
  const text = formatBrokenResult(missed);
  assert.match(text, /missed: fixture-shapes .* the check reported no issues/);
  assert.match(text, new RegExp(`Broken styles caught: ${result.copies.length - 1} of ${result.copies.length}\\.`));
});

test('a copy the check fails with only other issues is not caught', async () => {
  // Moving the eyes up past the top edge causes clip and zone.
  const plan = planBreaks(shapes).find((entry) => entry.way === 'clip' && entry.group === 'eyes' && entry.direction === 'top');
  const report = await check(shapes, applyBreak(shapes, plan));
  const kinds = new Set(report.issues.map((issue) => issue.kind));
  assert.ok(kinds.has('clip') && kinds.has('zone'));
  assert.equal(isCaught(plan, report), true);
  assert.equal(isCaught({ ...plan, kind: 'zone' }, report), true, 'other issues on the copy are fine');
  assert.equal(isCaught({ ...plan, kind: 'hole' }, report), false, 'a failure without the expected kind is a miss');
  assert.equal(isCaught(plan, { ...report, ok: true, issues: [] }), false, 'a pass is a miss');
});

test('a failing clean style fails the run', async () => {
  const { manifest, layers } = shapes;
  const broken = new Map(layers);
  // Make the "clean" style fail: one see-through pixel in the top right corner of the grey background.
  const grey = 'layers/background/grey.png';
  broken.set(grey, cutHole(layers.get(grey), 63, 0, 1));
  const result = await checkBrokenCopies([{ manifest, layers: broken }]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.clean.map(({ style, ok }) => ({ style, ok })), [{ style: 'fixture-shapes', ok: false }]);
  assert.match(result.clean[0].reason, /1 see-through px/);
  assert.match(formatBrokenResult(result), /clean style failed: fixture-shapes/);
  assert.match(formatBrokenResult(result), /Clean styles passed: 0 of 1\.$/);
});

test('a blank layer in a clean style fails the run with a summary instead of stopping it', async () => {
  const layers = new Map(shapes.layers);
  layers.set('layers/eyes/dots.png', createRaster(64, 64));
  const result = await checkBrokenCopies([{ manifest: shapes.manifest, layers }, blocks]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.clean.map(({ style, ok }) => ({ style, ok })), [
    { style: 'fixture-shapes', ok: false },
    { style: 'fixture-blocks', ok: true },
  ]);
  assert.match(result.clean[0].reason, /eyes\/dots has no drawn pixels/);
  // The failed style gets no copies, and the other style is still broken and checked.
  assert.ok(result.copies.length > 0);
  assert.ok(result.copies.every((copy) => copy.style === 'fixture-blocks' && copy.caught));
  assert.match(formatBrokenResult(result), /Clean styles passed: 1 of 2\.$/);
});

test('a missing or corrupt layer and an unreadable manifest fail their clean style', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'check-broken-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const copyStyle = async (name) => {
    await mkdir(join(folder, name), { recursive: true });
    await writeFile(join(folder, name, 'manifest.json'), JSON.stringify(shapes.manifest));
    for (const [src, raster] of shapes.layers) {
      await mkdir(dirname(join(folder, name, src)), { recursive: true });
      await writePng(join(folder, name, src), raster);
    }
    return join(folder, name, 'manifest.json');
  };
  const missingPath = await copyStyle('missing');
  await rm(join(folder, 'missing', 'layers/mouth/line.png'));
  const corruptPath = await copyStyle('corrupt');
  await writeFile(join(folder, 'corrupt', 'layers/headwear/cap.png'), 'not a png');

  const missing = await loadStyle(missingPath, 'missing-style');
  const corrupt = await loadStyle(corruptPath, 'corrupt-style');
  const unreadable = await loadStyle(join(folder, 'nowhere', 'manifest.json'), 'unreadable-style');
  const result = await checkBrokenCopies([missing, corrupt, unreadable, blocks]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.clean.map(({ style, ok }) => ({ style, ok })), [
    { style: 'fixture-shapes', ok: false },
    { style: 'fixture-shapes', ok: false },
    { style: 'unreadable-style', ok: false },
    { style: 'fixture-blocks', ok: true },
  ]);
  assert.match(result.clean[0].reason, /mouth\/line could not be loaded/);
  assert.match(result.clean[1].reason, /headwear\/cap could not be loaded/);
  assert.equal(result.copies.filter((copy) => copy.style === 'fixture-shapes').length, 0);
  const text = formatBrokenResult(result);
  assert.match(text, /clean style failed: unreadable-style/);
  assert.match(text, /Clean styles passed: 1 of 4\.$/);
});

test('npm run check:broken exits 0 and prints what docs/render-check.md shows', async () => {
  const result = await runCli();
  assert.equal(result.code, 0, result.stdout);
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines.length, WAYS.length + 1);
  for (const [index, way] of WAYS.entries()) {
    assert.match(lines[index], new RegExp(`^${way.label} \\(${way.kind}\\): (\\d+) copies made, \\1 caught$`));
  }
  assert.match(lines.at(-1), /^Broken styles caught: (\d+) of \1\. Clean styles passed: 2 of 2\.$/);
  const docs = await readFile(new URL('docs/render-check.md', root), 'utf8');
  assert.ok(docs.includes(`\`\`\`\n${result.stdout.trim()}\n\`\`\``), 'docs/render-check.md has the output as it is');
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  assert.equal(pkg.scripts['check:broken'], 'node bin/check-broken.js');
});

test('check-broken exits 1 and says it could not run when it gets an argument', async () => {
  const result = await runCli(['--nope']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /it takes no arguments/);
  assert.match(result.stderr, /Broken styles check could not run\./);
});
