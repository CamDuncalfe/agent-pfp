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
import { copyFile, cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { resolveLayerUrl, validateManifest } from '../src/manifest.js';
import { resolveManifestUrl, styleMismatch, validateStyleIndex } from '../src/styles.js';

export const SITE_DIR = '_site';
export const STYLE_INDEX = 'styles/index.json';
/** Folders copied whole, without their dotfiles. */
export const CODE_DIRS = Object.freeze(['web', 'src']);

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

async function requireFile(path, what) {
  let info;
  try {
    info = await stat(path);
  } catch {
    throw new SiteError(`${what} ${path} is missing`);
  }
  if (!info.isFile()) throw new SiteError(`${what} ${path} is not a file`);
}

/** The path of a file URL relative to the root, with forward slashes. */
function insideRoot(root, url) {
  const path = relative(root, fileURLToPath(url));
  if (path === '' || path.startsWith('..') || path.split(sep).includes('..')) {
    throw new SiteError(`${fileURLToPath(url)} is outside ${root}`);
  }
  return path.split(sep).join('/');
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
  const indexPath = join(root, ...STYLE_INDEX.split('/'));
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
        await requireFile(fileURLToPath(layerUrl), `layer "${group.id}/${option.id}"`);
        files.add(insideRoot(root, layerUrl));
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
  for (const dir of CODE_DIRS) {
    const from = join(root, dir);
    await cp(from, join(out, dir), {
      recursive: true,
      filter: (source) => !relative(from, source).split(sep).some((part) => part.startsWith('.')),
    });
  }
  for (const file of styleFiles) {
    const target = join(out, ...file.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(root, ...file.split('/')), target);
  }
  await writeFile(join(out, 'index.html'), REDIRECT_PAGE);
  return styleFiles;
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
