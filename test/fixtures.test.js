import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { buildFixtures } from '../fixtures/make-fixtures.js';
import { readPng } from '../src/png.js';
import { checkManifest } from '../src/render-check.js';

const run = promisify(execFile);
const fixturesUrl = new URL('../fixtures/', import.meta.url);
const cli = fileURLToPath(new URL('../bin/render-check.js', import.meta.url));

async function checkStyle(name) {
  const manifest = JSON.parse(await readFile(new URL(`${name}/manifest.json`, fixturesUrl), 'utf8'));
  return checkManifest(manifest, (src) => readPng(new URL(`${name}/${src}`, fixturesUrl)));
}

async function runCli(args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [cli, ...args]);
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

test('the PNG files on disk match make-fixtures.js', async () => {
  for (const [path, expected] of Object.entries(buildFixtures())) {
    const actual = await readPng(new URL(path, fixturesUrl));
    assert.equal(actual.width, expected.width, path);
    assert.equal(actual.height, expected.height, path);
    assert.deepEqual(Buffer.from(actual.data), Buffer.from(expected.data), path);
  }
});

test('fixtures/shapes passes the render check', async () => {
  const report = await checkStyle('shapes');
  assert.deepEqual(report.issues, []);
  assert.deepEqual(report.combinations, { total: 48, checked: 48, failed: 0, exhaustive: true });
});

test('fixtures/broken fails once for each bad layer', async () => {
  const report = await checkStyle('broken');
  assert.equal(report.ok, false);
  const count = (kind) => report.issues.filter((issue) => issue.kind === kind).length;
  assert.equal(count('size'), 1);
  assert.equal(count('empty'), 1);
  assert.equal(count('clip'), 1);
  assert.equal(count('zone'), 1);
  assert.equal(count('overlap'), 2);
  assert.equal(count('hole'), 8);
  assert.equal(report.issues.length, 14);
  // Only grey + round + dots + line + no hat is clean.
  assert.deepEqual(report.combinations, { total: 32, checked: 32, failed: 31, exhaustive: true });
});

test('the command line tool exits 0 for a passing style', async () => {
  const result = await runCli([fileURLToPath(new URL('shapes/manifest.json', fixturesUrl))]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Combinations checked: all 48, 0 failed/);
});

test('the command line tool exits 1 for a failing style and can print JSON', async () => {
  const manifest = fileURLToPath(new URL('broken/manifest.json', fixturesUrl));
  const text = await runCli([manifest]);
  assert.equal(text.code, 1);
  assert.match(text.stdout, /headwear\/clipped is cut off by the top edge/);
  const json = await runCli([manifest, '--json']);
  assert.equal(json.code, 1);
  assert.equal(JSON.parse(json.stdout).issues.length, 14);
});

test('the command line tool exits 2 when it cannot run', async () => {
  assert.equal((await runCli([])).code, 2);
  assert.equal((await runCli(['does-not-exist.json'])).code, 2);
  const manifest = fileURLToPath(new URL('shapes/manifest.json', fixturesUrl));
  assert.equal((await runCli([manifest, '--seed', 'abc'])).code, 2);
  assert.equal((await runCli([manifest, '--max-combinations', '0'])).code, 2);
  assert.equal((await runCli([manifest, '--nope'])).code, 2);
});
