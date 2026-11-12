#!/usr/bin/env node
/**
 * Write the builder as a folder of static files, for GitHub Pages.
 *
 * Usage: node bin/build-site.js   (run it from the repository root, or use npm run build:site)
 *
 * It empties _site/ and writes web/, src/, styles/index.json, each manifest
 * the index lists and each layer file those manifests name. Manifest and
 * layer paths go through resolveManifestUrl and resolveLayerUrl, the path
 * rule the builder page uses, so the site holds the files the page asks for.
 *
 * Exit code 0: the site is written. 1: the index, a manifest or a file it
 * names is wrong, and nothing but an empty _site/ is left.
 */
import { copyFile, cp, lstat, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { resolveLayerUrl, validateManifest } from '../src/manifest.js';
import { resolveManifestUrl, styleMismatch, validateStyleIndex } from '../src/styles.js';

export const SITE_DIR = '_site';
export const STYLE_INDEX = 'styles/index.json';
/** Folders copied whole, without their dotfiles. */
export const CODE_DIRS = Object.freeze(['web', 'src']);
/** Files the build writes itself. No style file may take their place. */
export const GENERATED_FILES = Object.freeze(['index.html']);

/** The page at the site's address. Relative links, so it works from a sub-path. */
export const REDIRECT_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="refresh" content="0; url=web/" />
    <title>Agent PFP builder</title>
  </head>
  <body>
    <p><a href="web/">Open the Agent PFP builder</a></p>
  </body>
</html>
`;

class SiteError extends Error {}

async function readJson(path, what) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new SiteError(`Could not read ${what} ${path}: ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new SiteError(`${what[0].toUpperCase()}${what.slice(1)} ${path} is not valid JSON: ${error.message}`);
  }
}

function isInside(root, path) {
  const rel = relative(root, path);
  return rel !== '' && !isAbsolute(rel) && !rel.split(sep).includes('..');
}

/**
 * Check that a file exists, is a file, and is inside the root once each
 * symlink on its way is followed, so the site never takes in a file from
 * outside the repository.
 * @param {string} realRoot the root with its own symlinks followed
 */
async function requireFile(realRoot, path, what) {
  let info;
  try {
    info = await stat(path);
  } catch {
    throw new SiteError(`${what} ${path} is missing`);
  }
  if (!info.isFile()) throw new SiteError(`${what} ${path} is not a file`);
  const real = await realpath(path);
  if (!isInside(realRoot, real)) {
    throw new SiteError(`${what} ${path} leads to ${real}, which is outside ${realRoot}`);
  }
}

/** The path of a file URL relative to the root, with forward slashes. */
function insideRoot(root, url) {
  const path = fileURLToPath(url);
  if (!isInside(root, path)) throw new SiteError(`${path} is outside ${root}`);
  return relative(root, path).split(sep).join('/');
}

/**
 * The style files the site needs: the index, each manifest it lists and each
 * layer they name, as paths relative to the root. Throws a SiteError that
 * says what is wrong when the index or a manifest isn't valid or a file is
 * missing.
 * @param {string} root the repository folder
 * @returns {Promise<string[]>}
 */
export async function collectStyleFiles(root) {
  const realRoot = await realpath(root);
  const indexPath = join(root, ...STYLE_INDEX.split('/'));
  await requireFile(realRoot, indexPath, 'the style index');
  const index = await readJson(indexPath, 'the style index');
  const indexResult = validateStyleIndex(index);
  if (!indexResult.ok) {
    throw new SiteError(`${indexPath} is not a valid style index: ${indexResult.errors.join('; ')}`);
  }

  const indexUrl = pathToFileURL(indexPath);
  const files = new Set([STYLE_INDEX]);
  for (const entry of index.styles) {
    let manifestUrl;
    try {
      manifestUrl = resolveManifestUrl(entry, indexUrl);
    } catch (error) {
      throw new SiteError(`${indexPath}: ${error.message}`);
    }
    const manifestPath = fileURLToPath(manifestUrl);
    await requireFile(realRoot, manifestPath, 'the manifest');
    const manifest = await readJson(manifestPath, 'the manifest');
    const result = validateManifest(manifest);
    if (!result.ok) throw new SiteError(`${manifestPath} is not a valid manifest: ${result.errors.join('; ')}`);
    const mismatch = styleMismatch(entry, manifest);
    if (mismatch) throw new SiteError(`${manifestPath}: ${mismatch}`);
    files.add(insideRoot(root, manifestUrl));

    for (const group of manifest.groups) {
      for (const option of group.options) {
        let layerUrl;
        try {
          layerUrl = resolveLayerUrl(option.src, manifestUrl);
        } catch (error) {
          throw new SiteError(`${manifestPath}: ${error.message}`);
        }
        const what = `layer "${group.id}/${option.id}"`;
        await requireFile(realRoot, fileURLToPath(layerUrl), what);
        const file = insideRoot(root, layerUrl);
        if (GENERATED_FILES.includes(file)) {
          throw new SiteError(`${manifestPath}: ${what} is ${file}, which the build writes itself`);
        }
        files.add(file);
      }
    }
  }
  return [...files];
}

/**
 * Empty the output folder and write the site into it.
 * @param {{ root: string, out?: string }} options `out` defaults to _site/ in the root
 * @returns {Promise<string[]>} the style files copied, relative to the root
 */
export async function buildSite({ root, out = join(root, SITE_DIR) }) {
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });

  const styleFiles = await collectStyleFiles(root);
  try {
    for (const dir of CODE_DIRS) await copyCodeDir(root, dir, out);
    for (const file of styleFiles) {
      const target = join(out, ...file.split('/'));
      await mkdir(dirname(target), { recursive: true });
      await copyFile(join(root, ...file.split('/')), target);
    }
    await writeFile(join(out, 'index.html'), REDIRECT_PAGE);
  } catch (error) {
    // A failed build leaves an empty _site/, never part of a site.
    await rm(out, { recursive: true, force: true });
    await mkdir(out, { recursive: true });
    if (error instanceof SiteError) throw error;
    throw new SiteError(`Could not write the site: ${error.message}`);
  }
  return styleFiles;
}

/**
 * Copy web/ or src/ without its dotfiles. A symlink is refused, because the
 * file it points to could be outside the repository.
 */
async function copyCodeDir(root, dir, out) {
  const from = join(root, dir);
  const info = await lstat(from).catch(() => null);
  if (!info) throw new SiteError(`${from} is missing`);
  if (!info.isDirectory()) throw new SiteError(`${from} is not a folder`);
  await cp(from, join(out, dir), {
    recursive: true,
    filter: async (source) => {
      if (relative(from, source).split(sep).some((part) => part.startsWith('.'))) return false;
      if ((await lstat(source)).isSymbolicLink()) {
        throw new SiteError(`${source} is a symlink, and the site takes none from ${dir}/`);
      }
      return true;
    },
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 2) {
    console.error('Usage: node bin/build-site.js   (run it from the repository root)');
    process.exit(1);
  }
  const root = process.cwd();
  try {
    const styleFiles = await buildSite({ root });
    console.log(`Site written to ${SITE_DIR}/ with ${styleFiles.length} style files.`);
  } catch (error) {
    if (!(error instanceof SiteError)) throw error;
    console.error(`Site not built: ${error.message}`);
    process.exit(1);
  }
}
