#!/usr/bin/env node
/**
 * Stage a cut character's export under its public id and name, for the
 * character-go-live-check skill. It writes a style folder and a one-style index
 * in a folder outside the repository, which `node bin/check-styles.js` can read.
 *
 * Usage (from the repository root):
 *   node .claude/skills/character-go-live-check/stage.mjs <export folder> <id> <name> <out folder> [--see-through a,b]
 *
 * Writes <out>/styles/<id>/manifest.json, the layers that manifest names, and
 * <out>/styles/index.json. Prints one line per thing it did and ends with
 * "Staged <id>". The manifest's `style` becomes <id>, its `name` becomes <name>,
 * and each option id given to --see-through gets "seeThrough": true. Layer files
 * the manifest doesn't name are left out and listed.
 *
 * Exit code 0: staged. 2: it could not stage (bad input, unknown option, a
 * missing layer, an out folder that isn't empty or sits inside the repository).
 */
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isSafeRelativePath, validateManifest } from '../../../src/manifest.js';

const USAGE = 'Usage: node .claude/skills/character-go-live-check/stage.mjs <export folder> <id> <name> <out folder> [--see-through a,b]';
const ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function fail(message) {
  console.error(message);
  console.error(USAGE);
  process.exit(2);
}

async function listFiles(folder, base = folder) {
  const entries = await readdir(folder, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(path, base)));
    else files.push(relative(base, path).split(sep).join('/'));
  }
  return files;
}

const args = process.argv.slice(2);
let seeThrough = [];
const flagAt = args.indexOf('--see-through');
if (flagAt !== -1) {
  const value = args[flagAt + 1];
  if (!value || value.startsWith('-')) fail('--see-through needs a comma-separated list of option ids.');
  seeThrough = value.split(',').map((id) => id.trim()).filter(Boolean);
  args.splice(flagAt, 2);
}
if (args.length !== 4) fail('Give the export folder, the id, the name and the out folder.');
const [exportArg, id, name, outArg] = args;
if (!ID_PATTERN.test(id)) fail(`"${id}" is not a style id (lowercase letters, digits and hyphens, starting with a letter).`);
if (name.trim() === '') fail('The name is empty.');

const exportFolder = resolve(exportArg);
const out = resolve(outArg);
if (out === REPO || out.startsWith(REPO + sep)) fail(`${out} is inside the repository. Stage outside it.`);
try {
  if ((await readdir(out)).length > 0) fail(`${out} is not empty. Give a new folder.`);
} catch (error) {
  if (error.code !== 'ENOENT') fail(`Could not read ${out}: ${error.message}`);
}

let manifest;
try {
  manifest = JSON.parse(await readFile(join(exportFolder, 'manifest.json'), 'utf8'));
} catch (error) {
  fail(`Could not read ${join(exportFolder, 'manifest.json')}: ${error.message}`);
}
const before = validateManifest(manifest);
if (!before.ok) fail(`The export's manifest is not valid: ${before.errors.join('; ')}`);

console.log(`Working id "${manifest.style}", working name "${manifest.name}"`);
manifest.style = id;
manifest.name = name;
console.log(`Public id "${id}", public name "${name}"`);

const options = new Map();
for (const group of manifest.groups) {
  for (const option of group.options) options.set(option.id, { group, option });
}
for (const optionId of seeThrough) {
  const found = options.get(optionId);
  if (!found) fail(`No option "${optionId}" in the manifest.`);
  if (!Array.isArray(found.group.over) || found.group.over.length === 0) {
    fail(`"${optionId}" is in group "${found.group.id}", which lists no groups in "over", so nothing shows through it.`);
  }
  found.option.seeThrough = true;
  console.log(`Marked see-through: ${found.group.id}/${optionId}`);
}

const after = validateManifest(manifest);
if (!after.ok) fail(`The staged manifest is not valid: ${after.errors.join('; ')}`);

const styleFolder = join(out, 'styles', id);
const named = new Set();
for (const { option } of options.values()) {
  if (!isSafeRelativePath(option.src)) fail(`Layer path "${option.src}" is not inside the style folder.`);
  named.add(option.src);
}
for (const src of named) {
  const target = join(styleFolder, ...src.split('/'));
  await mkdir(dirname(target), { recursive: true });
  try {
    await copyFile(join(exportFolder, ...src.split('/')), target);
  } catch (error) {
    fail(`Could not copy layer ${src}: ${error.message}`);
  }
}
console.log(`Copied ${named.size} layers`);

const left = (await listFiles(exportFolder)).filter((file) => file !== 'manifest.json' && !named.has(file)).sort();
console.log(left.length === 0 ? 'Files the manifest does not name: none' : `Files the manifest does not name, left out: ${left.join(', ')}`);

await writeFile(join(styleFolder, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
const index = { version: 1, styles: [{ id, name, manifest: `styles/${id}/manifest.json` }] };
await writeFile(join(out, 'styles', 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
console.log(`Index: ${join(out, 'styles', 'index.json')}`);
console.log(`Staged ${id}`);
