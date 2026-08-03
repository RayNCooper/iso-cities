#!/usr/bin/env node
/**
 * Runs the compiled test suite.
 *
 * Passing an explicit file list rather than a directory or a glob is the one
 * form the test runner accepts identically on every supported Node version and
 * on Windows, where the shell does not expand globs for us.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = join('build', 'test');

if (!existsSync(dir)) {
  console.error(`No compiled tests at ${dir}. Run "npm run pretest" (or "npm test") first.`);
  process.exit(1);
}

const files = readdirSync(dir)
  .filter((name) => name.endsWith('.test.js'))
  .sort()
  .map((name) => join(dir, name));

if (files.length === 0) {
  console.error(`No *.test.js files found in ${dir}.`);
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], {
  stdio: 'inherit',
});

process.exit(result.status ?? 1);
