#!/usr/bin/env node
/**
 * Break the clean fixture styles on purpose and show the render check catches
 * every broken copy.
 *
 * Usage: node bin/check-broken.js   (npm run check:broken)
 *
 * It reads the styles fixtures/index.json lists, makes the broken copies in
 * memory with fixtures/break-fixtures.js, runs the check on each copy and on
 * each clean style, and prints one line per way of breaking and a summary.
 *
 * Exit code 0: every copy was caught with the issue it was made to cause and
 * every clean style passed. 1: a copy was missed or a clean style failed.
 * 2: the command could not run.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkBrokenCopies, formatBrokenResult, loadStyle } from '../fixtures/break-fixtures.js';
import { validateStyleIndex } from '../src/styles.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

try {
  if (process.argv.length > 2) throw new Error('Usage: node bin/check-broken.js (it takes no arguments)');
  const indexPath = join(root, 'fixtures', 'index.json');
  const index = JSON.parse(await readFile(indexPath, 'utf8'));
  const valid = validateStyleIndex(index);
  if (!valid.ok) throw new Error(`${indexPath} is not a valid style index: ${valid.errors.join('; ')}`);
  const styles = [];
  for (const entry of index.styles) styles.push(await loadStyle(join(root, ...entry.manifest.split('/'))));
  const result = await checkBrokenCopies(styles);
  console.log(formatBrokenResult(result));
  process.exit(result.ok ? 0 : 1);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
