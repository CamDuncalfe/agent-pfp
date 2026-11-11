#!/usr/bin/env node
/**
 * Run the render check on each style a style index lists.
 *
 * Usage: node bin/check-styles.js [path/to/index.json]   (default styles/index.json)
 *
 * Exit code 0: each style passed. 1: a check found issues. 2: the check could not run.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { validateManifest } from '../src/manifest.js';
import { checkManifest, formatReport } from '../src/render-check.js';
import { readPng } from '../src/png.js';
import { styleMismatch, validateStyleIndex } from '../src/styles.js';

const USAGE = 'Usage: node bin/check-styles.js [path/to/index.json]';

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
if (args.length > 1 || args[0]?.startsWith('-')) fail('Give the path of one style index, or nothing.');

const indexPath = resolve(args[0] ?? 'styles/index.json');
const index = await readJson(indexPath);
const indexResult = validateStyleIndex(index);
if (!indexResult.ok) fail(`${indexPath} is not a valid style index: ${indexResult.errors.join('; ')}`);

// Manifest paths are relative to the folder that holds the index's folder.
const root = resolve(dirname(indexPath), '..');
let failed = 0;
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
  if (!report.ok) failed += 1;
}

if (failed > 0) {
  console.log(`Render check failed for ${failed} of ${index.styles.length} styles.`);
  process.exit(1);
}
console.log(`Styles checked: ${index.styles.length}`);
console.log('Render check passed.');
