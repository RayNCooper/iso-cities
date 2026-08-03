#!/usr/bin/env node
/**
 * Assembles the demo site into `_site/`.
 *
 * There is no bundler here on purpose. The compiled output is plain ES modules
 * with explicit `.js` extensions on every import, which is exactly what a
 * browser can load natively — so "bundling" is a directory copy.
 */

import { cp, mkdir, rm, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const OUT = '_site';

if (!existsSync('dist')) {
  console.error('No dist/ found. Run "npm run build" first.');
  process.exit(1);
}

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

// The page and its assets sit at the root; the library lands in ./dist, which
// is what web/app.js imports from.
await cp('web', OUT, { recursive: true });
await cp('dist', join(OUT, 'dist'), { recursive: true });

// Examples are handy for social previews and for linking from the page.
if (existsSync('examples')) {
  await cp('examples', join(OUT, 'examples'), { recursive: true });
}

async function measure(dir) {
  let bytes = 0;
  let files = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await measure(path);
      bytes += sub.bytes;
      files += sub.files;
    } else {
      bytes += (await stat(path)).size;
      files++;
    }
  }
  return { bytes, files };
}

const { bytes, files } = await measure(OUT);
console.log(`Built ${OUT}/ — ${files} files, ${(bytes / 1024).toFixed(0)} kB`);
