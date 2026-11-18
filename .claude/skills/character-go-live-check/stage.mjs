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
 * It then searches every staged file and path for the words of the working id
 * and name that the public ones don't have, and prints the number of
 * combinations, for `bin/render-check.js --max-combinations`.
 *
 * Exit code 0: staged, no working word left. 1: staged, but a working word is
 * left in a file or path. 2: it could not stage (bad input, unknown option, a
 * missing or linked layer, an out folder that doesn't exist, isn't empty or is
 * inside the repository).
 */
import { copyFile, lstat, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

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

// The text of a PNG outside its image data: chunk names, the bytes of each
// chunk that isn't IDAT, and the text of tEXt, zTXt and iTXt chunks, inflated
// when compressed. The compressed pixels in IDAT are left out, since any short
// word turns up in them by chance.
function inflateText(data) {
  try {
    return inflateSync(data).toString('utf8');
  } catch {
    return '';
  }
}

function pngText(bytes) {
  const parts = [];
  let at = 8;
  while (at + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.toString('latin1', at + 4, at + 8);
    const data = bytes.subarray(at + 8, Math.min(at + 8 + length, bytes.length));
    if (type !== 'IDAT') {
      parts.push(type, data.toString('latin1'));
      const keywordEnd = data.indexOf(0);
      if (type === 'zTXt' && keywordEnd !== -1) parts.push(inflateText(data.subarray(keywordEnd + 2)));
      if (type === 'iTXt' && keywordEnd !== -1) {
        // keyword \0 compression flag, method, language \0 translated keyword \0 text
        const compressed = data[keywordEnd + 1] === 1;
        const languageEnd = data.indexOf(0, keywordEnd + 3);
        const translatedEnd = languageEnd === -1 ? -1 : data.indexOf(0, languageEnd + 1);
        if (translatedEnd !== -1) {
          const text = data.subarray(translatedEnd + 1);
          parts.push(data.subarray(0, translatedEnd).toString('utf8'), compressed ? inflateText(text) : text.toString('utf8'));
        }
      }
    }
    at += 12 + length;
  }
  return parts.join('\n');
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

// Words of the working id and name that the public ones don't have, in any
// script. Every staged file's path and text are searched for each, ignoring
// case. A Latin word matches as a whole word ("cat" is not found in "catfish")
// and needs three letters or more. A word with other letters (Chinese has no
// spaces between words) is found anywhere in the text.
const WORD_SPLIT = /[^\p{L}\p{N}]+/u;
const isLatin = (word) => /^[a-z0-9]+$/.test(word);
const words = (text) => text.toLowerCase().split(WORD_SPLIT).filter(Boolean);
const publicWords = new Set(words(`${id} ${name}`));
const workingWords = [...new Set(words(`${workingId} ${workingName}`))]
  .filter((word) => (!isLatin(word) || word.length >= 3) && !publicWords.has(word));
console.log(`Working words to find: ${workingWords.length === 0 ? 'none' : workingWords.join(', ')}`);
const hits = [];
for (const file of await listFiles(out)) {
  const bytes = await readFile(join(out, ...file.split('/')));
  const text = `${file}\n${file.endsWith('.png') ? pngText(bytes) : bytes.toString('utf8')}`.toLowerCase();
  const textWords = new Set(words(text));
  for (const word of workingWords) {
    if (isLatin(word) ? textWords.has(word) : text.includes(word)) hits.push(`${file} (${word})`);
  }
}
console.log(`Working words left in the stage: ${hits.length === 0 ? 'none' : hits.join(', ')}`);

const total = countCombinations(manifest);
console.log(`Combinations: ${total}`);
console.log(`Staged ${id}`);
if (hits.length > 0) process.exit(1);
