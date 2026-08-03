#!/usr/bin/env node
/**
 * A tiny static server for previewing the demo site locally.
 *
 * Development only — it exists so `npm run serve` works without pulling in a
 * dev-server dependency. It is not hardened for anything else.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';

const ROOT = resolve('_site');
const PORT = Number(process.env['PORT'] ?? 8080);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = createServer(async (request, response) => {
  const path = decodeURIComponent((request.url ?? '/').split('?')[0]);
  let file = resolve(ROOT, `.${path}`);

  // Never serve anything above the site root.
  if (file !== ROOT && !file.startsWith(ROOT + sep)) {
    response.writeHead(403).end('forbidden');
    return;
  }
  if (path.endsWith('/') || !extname(file)) file = join(file, 'index.html');

  try {
    const body = await readFile(file);
    response.writeHead(200, {
      'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    response.end(body);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
  }
});

server.listen(PORT, () => {
  console.log(`Serving _site/ on http://localhost:${PORT}`);
});
