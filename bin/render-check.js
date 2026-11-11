#!/usr/bin/env node
/**
 * Run the render check on one style from the command line.
 *
 * Usage: node bin/render-check.js <path/to/manifest.json> [options]
 *
 *   --max-combinations <n>  visit every combination up to this many, sample above it (default 2000)
 *   --seed <n>              seed for the sample (default 1)
 *   --json                  print the full report as JSON
 *
 * Exit code 0: the style passed. 1: the check found issues. 2: the check could not run.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { checkManifest, formatReport, DEFAULT_OPTIONS } from '../src/render-check.js';
import { readPng } from '../src/png.js';

const USAGE = 'Usage: node bin/render-check.js <path/to/manifest.json> [--max-combinations <n>] [--seed <n>] [--json]';

function fail(message) {
  console.error(message);
  console.error(USAGE);
  process.exit(2);
}

function readInteger(value, name, fallback) {
  if (value === undefined) return fallback;
  if (!/^-?\d+$/.test(value)) fail(`${name} must be a whole number`);
  return Number.parseInt(value, 10);
}

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      'max-combinations': { type: 'string' },
      seed: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
  });
} catch (error) {
  fail(error.message);
}

if (parsed.positionals.length !== 1) fail('Give the path of one manifest.json.');

const manifestPath = resolve(parsed.positionals[0]);
let manifest;
try {
  manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
} catch (error) {
  fail(`Could not read ${manifestPath}: ${error.message}`);
}

const styleFolder = dirname(manifestPath);
let report;
try {
  report = await checkManifest(manifest, (src) => readPng(join(styleFolder, src)), {
    maxCombinations: readInteger(parsed.values['max-combinations'], '--max-combinations', DEFAULT_OPTIONS.maxCombinations),
    seed: readInteger(parsed.values.seed, '--seed', DEFAULT_OPTIONS.seed),
  });
} catch (error) {
  fail(error.message);
}

console.log(parsed.values.json ? JSON.stringify(report, null, 2) : formatReport(report));
process.exit(report.ok ? 0 : 1);
