#!/usr/bin/env node
/**
 * Local preview server for the builder page. It serves files from the
 * repository root on 127.0.0.1 only. It is a development tool, not a
 * production server.
 *
 * Usage: npm start                        (port 4173)
 *        PORT=8080 npm start
 *        npm start -- --styles <folder>   also serve style folders kept outside the repository
 *        STYLES_DIR=<folder> npm start    the same
 *
 * With a styles folder, each folder directly inside it that has a
 * manifest.json is one style. The folder is served read-only under
 * /local-styles/, and /local-styles/index.json lists its styles.
 */
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { buildLocalIndex, LOCAL_STYLES_PREFIX } from '../src/local-styles.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const HOST = '127.0.0.1';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

/** The only file types served from a local styles folder. */
const LOCAL_STYLE_TYPES = ['.json', '.png'];

/** URL path parts of a request, or null when the path cannot be decoded. */
function requestSegments(requestUrl) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(requestUrl, 'http://localhost').pathname);
  } catch {
    return null;
  }
  if (pathname.includes('\0')) return null;
  return pathname.split('/').filter(Boolean);
}

/** Map a request path to a file inside ROOT, or null when it is not servable. */
export function resolveRequestPath(root, requestUrl) {
  const segments = requestSegments(requestUrl);
  if (!segments) return null;
  // Dotfiles and dependency folders are never served.
  if (segments.some((segment) => segment.startsWith('.') || segment === 'node_modules')) return null;
  const target = resolve(join(root, ...segments));
  if (target !== root && !target.startsWith(root + sep)) return null;
  return target;
}

/**
 * Map a request under /local-styles/ to a file inside the styles folder.
 * Returns undefined when the request is not under /local-styles/, and null
 * when it is but cannot be served: a dotfile, a path that leaves the folder
 * or a file type other than .json and .png.
 */
export function resolveLocalStylePath(stylesDir, requestUrl) {
  const segments = requestSegments(requestUrl);
  if (!segments || segments[0] !== LOCAL_STYLES_PREFIX) return undefined;
  const rest = segments.slice(1);
  if (rest.length === 0) return null;
  if (rest.some((segment) => segment.startsWith('.') || segment.includes('\\'))) return null;
  if (!LOCAL_STYLE_TYPES.includes(extname(rest[rest.length - 1]).toLowerCase())) return null;
  const target = resolve(join(stylesDir, ...rest));
  if (!target.startsWith(stylesDir + sep)) return null;
  return target;
}

/** Read the manifest of each folder directly inside the styles folder. */
export async function readStyleFolders(stylesDir) {
  const folders = [];
  for (const entry of await readdir(stylesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    let text;
    try {
      text = await readFile(join(stylesDir, entry.name, 'manifest.json'), 'utf8');
    } catch {
      // A folder without a manifest.json is not a style.
      continue;
    }
    try {
      folders.push({ folder: entry.name, manifest: JSON.parse(text) });
    } catch {
      folders.push({ folder: entry.name, error: 'manifest.json is not valid JSON' });
    }
  }
  return folders;
}

async function repoStyleIds(root) {
  try {
    const index = JSON.parse(await readFile(join(root, 'styles', 'index.json'), 'utf8'));
    return index.styles.map((entry) => entry.id);
  } catch {
    return [];
  }
}

function send(response, status, body) {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  response.end(body);
}

function sendJson(request, response, value) {
  const body = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  response.writeHead(200, {
    'content-type': TYPES['.json'],
    'content-length': body.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(request.method === 'HEAD' ? undefined : body);
}

async function sendFile(request, response, target, info) {
  const type = TYPES[extname(target).toLowerCase()];
  if (!type) {
    send(response, 404, 'Not found');
    return;
  }
  response.writeHead(200, {
    'content-type': type,
    'content-length': info.size,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  createReadStream(target).on('error', () => response.destroy()).pipe(response);
}

/**
 * The request handler.
 * @param {{ root?: string, stylesDir?: string | null, warn?: (line: string) => void }} [options]
 *   `stylesDir` is the real path of the local styles folder, or null for none
 */
export function createHandler({ root: rootOption = ROOT, stylesDir = null, warn = console.warn } = {}) {
  const root = resolve(rootOption);
  // A warning is printed once, not on each reload of the page.
  const warned = new Set();

  async function handleLocalStyle(request, response, target) {
    if (isIndexRequest(request.url)) {
      const { index, warnings } = buildLocalIndex(await readStyleFolders(stylesDir), await repoStyleIds(root));
      for (const line of warnings) {
        if (!warned.has(line)) {
          warned.add(line);
          warn(line);
        }
      }
      sendJson(request, response, index);
      return;
    }
    // A symlink inside the folder may point outside it. Serve the file only
    // when its real path is still inside the styles folder.
    const real = await realpath(target);
    if (!real.startsWith(stylesDir + sep)) throw new Error('outside the styles folder');
    const info = await stat(real);
    if (!info.isFile()) throw new Error('not a file');
    await sendFile(request, response, real, info);
  }

  function isIndexRequest(requestUrl) {
    const segments = requestSegments(requestUrl);
    return segments !== null && segments.length === 2 && segments[1] === 'index.json';
  }

  return async function handle(request, response) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      send(response, 405, 'Method not allowed');
      return;
    }
    try {
      const local = resolveLocalStylePath(stylesDir ?? '', request.url ?? '/');
      if (local !== undefined) {
        if (local === null || stylesDir === null) throw new Error('not servable');
        await handleLocalStyle(request, response, local);
        return;
      }
      let target = resolveRequestPath(root, request.url ?? '/');
      if (!target) throw new Error('not servable');
      let info = await stat(target);
      if (info.isDirectory()) {
        target = join(target, 'index.html');
        info = await stat(target);
      }
      if (!info.isFile()) throw new Error('not a file');
      await sendFile(request, response, target, info);
    } catch {
      if (!response.headersSent) send(response, 404, 'Not found');
      else response.destroy();
    }
  };
}

/**
 * The real path of the styles folder named on the command line or in
 * STYLES_DIR, or null when neither is set. Throws when the folder does not
 * exist or is not a folder.
 */
export async function resolveStylesDir(value) {
  if (value === undefined || value === '') return null;
  const path = resolve(value);
  let info;
  try {
    info = await stat(path);
  } catch {
    throw new Error(`The styles folder ${path} does not exist.`);
  }
  if (!info.isDirectory()) throw new Error(`${path} is not a folder.`);
  return realpath(path);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const USAGE = 'Usage: node bin/serve.js [--styles <folder>]';
  const fail = (message) => {
    console.error(message);
    console.error(USAGE);
    process.exit(2);
  };
  let parsed;
  try {
    parsed = parseArgs({ options: { styles: { type: 'string' } } });
  } catch (error) {
    fail(error.message);
  }
  const port = Number.parseInt(process.env.PORT ?? '4173', 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail('PORT must be a number from 1 to 65535');
  let stylesDir;
  try {
    stylesDir = await resolveStylesDir(parsed.values.styles ?? process.env.STYLES_DIR);
  } catch (error) {
    fail(error.message);
  }
  const handle = createHandler({ stylesDir });
  createServer((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent) send(response, 500, 'Server error');
      else response.destroy();
    });
  }).listen(port, HOST, () => {
    console.log(`Builder: http://${HOST}:${port}/web/`);
    if (stylesDir) console.log(`Local styles: ${stylesDir}`);
  });
}
