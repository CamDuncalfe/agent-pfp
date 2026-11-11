#!/usr/bin/env node
/**
 * Local preview server for the builder page. It serves files from the
 * repository root on 127.0.0.1 only. It is a development tool, not a
 * production server.
 *
 * Usage: npm start            (port 4173)
 *        PORT=8080 npm start
 */
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const HOST = '127.0.0.1';
const PORT = Number.parseInt(process.env.PORT ?? '4173', 10);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

/** Map a request path to a file inside ROOT, or null when it is not servable. */
export function resolveRequestPath(root, requestUrl) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(requestUrl, 'http://localhost').pathname);
  } catch {
    return null;
  }
  if (pathname.includes('\0')) return null;
  const segments = pathname.split('/').filter(Boolean);
  // Dotfiles and dependency folders are never served.
  if (segments.some((segment) => segment.startsWith('.') || segment === 'node_modules')) return null;
  const target = resolve(join(root, ...segments));
  if (target !== root && !target.startsWith(root + sep)) return null;
  return target;
}

function send(response, status, body) {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  response.end(body);
}

async function handle(request, response) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    send(response, 405, 'Method not allowed');
    return;
  }
  let target = resolveRequestPath(ROOT, request.url ?? '/');
  if (!target) {
    send(response, 404, 'Not found');
    return;
  }
  try {
    let info = await stat(target);
    if (info.isDirectory()) {
      target = join(target, 'index.html');
      info = await stat(target);
    }
    if (!info.isFile()) throw new Error('not a file');
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
  } catch {
    send(response, 404, 'Not found');
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
    console.error('PORT must be a number from 1 to 65535');
    process.exit(2);
  }
  createServer((request, response) => {
    handle(request, response).catch(() => send(response, 500, 'Server error'));
  }).listen(PORT, HOST, () => {
    console.log(`Builder: http://${HOST}:${PORT}/web/`);
  });
}
