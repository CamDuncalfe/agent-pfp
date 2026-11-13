/**
 * Local styles: style folders that sit outside this repository, so artwork
 * can be looked at in the builder before it is approved (AGENTS.md rule 5).
 * The local server lists them at /local-styles/index.json. The format is the
 * style index format in docs/styles.md.
 *
 * This module has no Node or browser dependencies. bin/serve.js gives it the
 * parsed manifests, and the builder page gives it the two indexes.
 */
import { validateManifest } from './manifest.js';
import { STYLE_INDEX_VERSION, validateStyleIndex } from './styles.js';

/** The URL path the local server serves the styles folder under. */
export const LOCAL_STYLES_PREFIX = 'local-styles';

/** A canvas narrower than this is a small fixture. The preview keeps its pixels sharp when it is scaled up. */
export const PIXEL_ART_BELOW = 256;

/**
 * Whether the preview shows a canvas of this width with sharp pixels. A
 * large picture is scaled down smoothly.
 * @param {number} canvasWidth
 * @returns {boolean}
 */
export function isPixelArt(canvasWidth) {
  return canvasWidth < PIXEL_ART_BELOW;
}

/**
 * Whether the page asks for /local-styles/index.json. Only the local preview
 * server has it, so the page asks on a loopback host name and nowhere else.
 * @param {string} hostname the host name of the page, without a port
 * @returns {boolean}
 */
export function mayLoadLocalStyles(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost';
}

const FOLDER_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

/**
 * Build the index of local styles from the folders found in the styles
 * folder. A folder is left out, with a warning, when its name cannot be a
 * URL path part, its manifest could not be read or is not valid, or its
 * style id is taken by a repository style or an earlier folder.
 *
 * @param {{ folder: string, manifest?: unknown, error?: string }[]} folders
 *   one entry per folder that has a manifest.json; `error` says why it could not be read
 * @param {Iterable<string>} takenIds ids of the styles in styles/index.json
 * @returns {{ index: { version: number, styles: import('./styles.js').StyleEntry[] }, warnings: string[] }}
 */
export function buildLocalIndex(folders, takenIds = []) {
  const taken = new Set(takenIds);
  const styles = [];
  const warnings = [];
  const skip = (folder, why) => warnings.push(`Left out local style folder "${folder}": ${why}`);
  for (const { folder, manifest, error } of [...folders].sort((a, b) => (a.folder < b.folder ? -1 : a.folder > b.folder ? 1 : 0))) {
    if (!FOLDER_PATTERN.test(folder)) {
      skip(folder, 'the folder name may only use letters, digits, hyphens, underscores and dots');
      continue;
    }
    if (error !== undefined) {
      skip(folder, error);
      continue;
    }
    const result = validateManifest(manifest);
    if (!result.ok) {
      skip(folder, `manifest.json is not valid (${result.errors.join('; ')})`);
      continue;
    }
    if (taken.has(manifest.style)) {
      skip(folder, `the style id "${manifest.style}" is already used by another style`);
      continue;
    }
    taken.add(manifest.style);
    styles.push({
      id: manifest.style,
      name: manifest.name,
      manifest: `${LOCAL_STYLES_PREFIX}/${folder}/manifest.json`,
    });
  }
  styles.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { index: { version: STYLE_INDEX_VERSION, styles }, warnings };
}

/**
 * The styles the Character tab shows: the repository's styles first, then the
 * local ones with "(local)" after the name. Each entry remembers the URL of
 * the index it came from, because manifest paths are relative to it.
 *
 * A local index that is missing, empty or not valid adds nothing. A local
 * style whose id a repository style already uses is left out.
 *
 * @param {{ styles: import('./styles.js').StyleEntry[] }} repoIndex a valid style index
 * @param {string | URL} repoIndexUrl
 * @param {unknown} localIndex the parsed local index, or null when there is none
 * @param {string | URL} localIndexUrl
 * @returns {{ id: string, name: string, manifest: string, indexUrl: string | URL, local: boolean }[]}
 */
export function mergeStyleLists(repoIndex, repoIndexUrl, localIndex, localIndexUrl) {
  const merged = repoIndex.styles.map((entry) => ({ ...entry, indexUrl: repoIndexUrl, local: false }));
  if (localIndex === null || !validateStyleIndex(localIndex).ok) return merged;
  const taken = new Set(merged.map((entry) => entry.id));
  for (const entry of localIndex.styles) {
    if (taken.has(entry.id)) continue;
    merged.push({ ...entry, name: `${entry.name} (local)`, indexUrl: localIndexUrl, local: true });
  }
  return merged;
}
