#!/usr/bin/env node
/**
 * Run the render check on each style that one or more style indexes list.
 *
 * Usage: node bin/check-styles.js [path/to/index.json ...]   (default styles/index.json)
 *
 * `npm run check` passes styles/index.json, the styles the builder offers, and
 * fixtures/index.json, the fixture styles the tests use.
 *
 * Exit code 0: each style passed. 1: a check found issues. 2: the check could not run.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { validateManifest } from '../src/manifest.js';
import { checkManifest, formatReport } from '../src/render-check.js';
import { readPng } from '../src/png.js';
import { styleMismatch, validateStyleIndex } from '../src/styles.js';

const USAGE = 'Usage: node bin/check-styles.js [path/to/index.json ...]';

function fail(message) {
  console.error(message);
  console.error(USAGE);
  process.exit(2);
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    return fail(`Could not read ${path}: ${error.message}`);
  }
}

const args = process.argv.slice(2);
if (args.some((arg) => arg.startsWith('-'))) fail('Give the paths of style indexes, or nothing.');
const indexPaths = [...new Set((args.length > 0 ? args : ['styles/index.json']).map((arg) => resolve(arg)))];

// Read and validate each index before any style is checked, so a bad index
// stops the run before it spends time on the others.
const indexes = [];
for (const indexPath of indexPaths) {
  const index = await readJson(indexPath);
  const indexResult = validateStyleIndex(index);
  if (!indexResult.ok) fail(`${indexPath} is not a valid style index: ${indexResult.errors.join('; ')}`);
  indexes.push({ indexPath, index });
}

let checked = 0;
let failed = 0;
for (const { indexPath, index } of indexes) {
  // Manifest paths are relative to the folder that holds the index's folder.
  const root = resolve(dirname(indexPath), '..');
  for (const entry of index.styles) {
    const manifestPath = join(root, ...entry.manifest.split('/'));
    const manifest = await readJson(manifestPath);
    const manifestResult = validateManifest(manifest);
    if (!manifestResult.ok) fail(`${manifestPath} is not a valid manifest: ${manifestResult.errors.join('; ')}`);
    const mismatch = styleMismatch(entry, manifest);
    if (mismatch) fail(`${manifestPath}: ${mismatch}`);
    const styleFolder = dirname(manifestPath);
    let report;
    try {
      report = await checkManifest(manifest, (src) => readPng(join(styleFolder, src)));
    } catch (error) {
      fail(error.message);
    }
    console.log(formatReport(report));
    console.log('');
    checked += 1;
    if (!report.ok) failed += 1;
  }
}

if (failed > 0) {
  console.log(`Render check failed for ${failed} of ${checked} styles.`);
  process.exit(1);
}
console.log(`Styles checked: ${checked}`);
console.log('Render check passed.');
