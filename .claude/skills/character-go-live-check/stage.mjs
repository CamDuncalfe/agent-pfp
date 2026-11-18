#!/usr/bin/env node
/**
 * Stage a cut character's export under its public id and name, for the
 * character-go-live-check skill. It writes a style folder and a one-style index
 * in a folder outside the repository, which `node bin/check-styles.js` can read.
 *
 * Usage (from the repository root):
 *   node .claude/skills/character-go-live-check/stage.mjs <export folder> <id> <name> <out folder> [--see-through group/option,...]
 *
 * Writes <out>/styles/<id>/manifest.json, the layers that manifest names, and
 * <out>/styles/index.json. Prints one line per thing it did and ends with
 * "Staged <id>". The manifest's `style` becomes <id>, its `name` becomes <name>,
 * and each option given to --see-through (<group>/<option>, or the option id
 * alone when only one group has it) gets "seeThrough": true. Layer files
 * the manifest doesn't name are left out and listed.
 *
 * It then searches the staged manifest, index and paths for the words of the working id
 * and name that the public ones don't have, and prints the number of
 * combinations, for `bin/render-check.js --max-combinations`.
 *
 * Exit code 0: staged, no working word left. 1: staged, but a working word is
 * left in a file or path. 2: it could not stage (bad input, unknown option, a
 * missing or linked layer, a layer with text chunks, a name outside plain ASCII
 * or a working word under three letters, an out folder that doesn't exist,
 * isn't empty or is inside the repository).
 */
import { copyFile, lstat, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { countCombinations } from '../../../src/combinations.js';
import { isSafeRelativePath, validateManifest } from '../../../src/manifest.js';
import { styleMismatch, validateStyleIndex } from '../../../src/styles.js';

const USAGE = 'Usage: node .claude/skills/character-go-live-check/stage.mjs <export folder> <id> <name> <out folder> [--see-through group/option,...]';
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

// A layer is a PNG that holds image chunks only. Text and metadata chunks
// (tEXt, zTXt, iTXt, eXIf and the rest) are where a working name could hide
// and the render check can't see it, so a layer with one is refused.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IMAGE_CHUNKS = new Set(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND']);

function otherChunks(bytes) {
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  const found = new Set();
  let at = 8;
  while (at + 8 <= bytes.length) {
    const type = bytes.toString('latin1', at + 4, at + 8);
    if (!IMAGE_CHUNKS.has(type)) found.add(type);
    at += 12 + bytes.readUInt32BE(at);
  }
  return [...found];
}

const args = process.argv.slice(2);
let seeThrough = [];
const flagAt = args.indexOf('--see-through');
if (flagAt !== -1) {
  const value = args[flagAt + 1];
  if (!value || value.startsWith('-')) fail('--see-through needs a comma-separated list of options (<group>/<option>).');
  seeThrough = value.split(',').map((id) => id.trim()).filter(Boolean);
  args.splice(flagAt, 2);
}
if (args.length !== 4) fail('Give the export folder, the id, the name and the out folder.');
const [exportArg, id, name, outArg] = args;
if (!ID_PATTERN.test(id)) fail(`"${id}" is not a style id (lowercase letters, digits and hyphens, starting with a letter).`);
if (name.trim() === '') fail('The name is empty.');

function isInside(path, folder) {
  return path === folder || path.startsWith(folder + sep);
}

// The out folder has to exist (mktemp -d makes it), so its real path can be
// checked: a symlink to a folder in the repository counts as in the repository.
const repo = await realpath(REPO);
let out;
try {
  out = await realpath(resolve(outArg));
} catch (error) {
  fail(`Could not open the out folder ${resolve(outArg)}: ${error.message}. Make it with mktemp -d first.`);
}
if (isInside(out, repo)) fail(`${out} is inside the repository. Stage outside it.`);
if ((await readdir(out)).length > 0) fail(`${out} is not empty. Give a new folder.`);

let exportFolder;
try {
  exportFolder = await realpath(resolve(exportArg));
} catch (error) {
  fail(`Could not open the export folder ${resolve(exportArg)}: ${error.message}`);
}

let manifest;
try {
  manifest = JSON.parse(await readFile(join(exportFolder, 'manifest.json'), 'utf8'));
} catch (error) {
  fail(`Could not read ${join(exportFolder, 'manifest.json')}: ${error.message}`);
}
const before = validateManifest(manifest);
if (!before.ok) fail(`The export's manifest is not valid: ${before.errors.join('; ')}`);

const workingId = manifest.style;
const workingName = manifest.name;
// The scan below matches plain ASCII words. A name with other letters, an
// accent included, is a stop: ask how it should be checked.
for (const [what, value] of [['working name', workingName], ['public name', name]]) {
  if (!/^[\x20-\x7e]*$/.test(value)) fail(`The ${what} "${value}" has letters outside plain ASCII. Ask how to check it.`);
}
console.log(`Working id "${workingId}", working name "${workingName}"`);
manifest.style = id;
manifest.name = name;
console.log(`Public id "${id}", public name "${name}"`);

// Option ids repeat across groups (clothes and eyes can each have a "default"),
// so an option is known by its group and its id together.
const options = manifest.groups.flatMap((group) => group.options.map((option) => ({ group, option })));
for (const wanted of seeThrough) {
  const [groupId, optionId] = wanted.includes('/') ? wanted.split('/', 2) : [null, wanted];
  const found = options.filter(({ group, option }) => option.id === optionId && (groupId === null || group.id === groupId));
  if (found.length === 0) fail(`No option "${wanted}" in the manifest.`);
  if (found.length > 1) {
    fail(`"${wanted}" is an option in ${found.map(({ group }) => group.id).join(' and ')}. Give it as <group>/<option>.`);
  }
  const [{ group, option }] = found;
  if (!Array.isArray(group.over) || group.over.length === 0) {
    fail(`"${wanted}" is in group "${group.id}", which lists no groups in "over", so nothing shows through it.`);
  }
  option.seeThrough = true;
  console.log(`Marked see-through: ${group.id}/${option.id}`);
}
// Only the options given to --see-through stay marked: a mark the export
// already had on another option (sunglasses, say) is taken off.
for (const { group, option } of options) {
  if (option.seeThrough !== true) continue;
  const marked = seeThrough.some((wanted) => wanted === `${group.id}/${option.id}` || wanted === option.id);
  if (!marked) {
    delete option.seeThrough;
    console.log(`Took off a see-through mark the export had: ${group.id}/${option.id}`);
  }
}

const after = validateManifest(manifest);
if (!after.ok) fail(`The staged manifest is not valid: ${after.errors.join('; ')}`);

const styleFolder = join(out, 'styles', id);
const named = new Set();
for (const { option } of options) {
  if (!isSafeRelativePath(option.src)) fail(`Layer path "${option.src}" is not inside the style folder.`);
  named.add(option.src);
}
// A layer has to be a plain file inside the export folder. A symlink, or a
// path through a linked folder, could pull in any file on this machine.
for (const src of named) {
  const source = join(exportFolder, ...src.split('/'));
  try {
    const info = await lstat(source);
    if (!info.isFile()) fail(`Layer ${src} is not a plain file (a symlink or a folder).`);
    if (!isInside(await realpath(source), exportFolder)) fail(`Layer ${src} is outside the export folder.`);
  } catch (error) {
    fail(`Could not read layer ${src}: ${error.message}`);
  }
  const chunks = otherChunks(await readFile(source));
  if (chunks === null) fail(`Layer ${src} is not a PNG.`);
  if (chunks.length > 0) fail(`Layer ${src} carries ${chunks.join(', ')}. A layer holds image chunks only: export it again without metadata.`);
  const target = join(styleFolder, ...src.split('/'));
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
}
console.log(`Copied ${named.size} layers`);

const left = (await listFiles(exportFolder)).filter((file) => file !== 'manifest.json' && !named.has(file)).sort();
console.log(left.length === 0 ? 'Files the manifest does not name: none' : `Files the manifest does not name, left out: ${left.join(', ')}`);

await writeFile(join(styleFolder, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
const index = { version: 1, styles: [{ id, name, manifest: `styles/${id}/manifest.json` }] };
const indexResult = validateStyleIndex(index);
if (!indexResult.ok) fail(`The staged index is not valid: ${indexResult.errors.join('; ')}`);
const mismatch = styleMismatch(index.styles[0], manifest);
if (mismatch) fail(`The staged index and manifest disagree: ${mismatch}`);
await writeFile(join(out, 'styles', 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
console.log(`Index: ${join(out, 'styles', 'index.json')}`);

// Words of the working id and name that the public ones don't have. The
// staged manifest, the index and every staged path are searched for each as a
// whole word, ignoring case ("cat" is not found in "catfish"). Layers hold no
// text (see otherChunks). A working word under three letters is a stop: too
// short to search for safely.
const words = (text) => text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const publicWords = new Set(words(`${id} ${name}`));
const workingWords = [...new Set(words(`${workingId} ${workingName}`))].filter((word) => !publicWords.has(word));
const short = workingWords.filter((word) => word.length < 3);
if (short.length > 0) fail(`The working name has words under three letters (${short.join(', ')}). Ask how to check it.`);
console.log(`Working words to find: ${workingWords.length === 0 ? 'none' : workingWords.join(', ')}`);
const hits = [];
for (const file of await listFiles(out)) {
  const text = file.endsWith('.json') ? `${file}\n${await readFile(join(out, ...file.split('/')), 'utf8')}` : file;
  const found = new Set(words(text));
  for (const word of workingWords) if (found.has(word)) hits.push(`${file} (${word})`);
}
console.log(`Working words left in the stage: ${hits.length === 0 ? 'none' : hits.join(', ')}`);

const total = countCombinations(manifest);
console.log(`Combinations: ${total}`);
console.log(`Staged ${id}`);
if (hits.length > 0) process.exit(1);
