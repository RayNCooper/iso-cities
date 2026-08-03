/**
 * The on-disk response cache. Node only — the browser build uses
 * {@link MemoryCache} from `cache.js` instead.
 */

import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { DAY_MS, envVar, type CacheLike } from './cache.js';

export function defaultCacheDir(): string {
  const override = envVar('ISO_CITIES_CACHE_DIR');
  if (override) return override;
  const xdg = envVar('XDG_CACHE_HOME');
  if (xdg) return join(xdg, 'iso-cities');
  const home = homedir();
  if (home && home !== '/') return join(home, '.cache', 'iso-cities');
  return join(tmpdir(), 'iso-cities-cache');
}

export interface CacheOptions {
  dir?: string;
  enabled?: boolean;
  /** Entries older than this are treated as missing. */
  maxAgeMs?: number;
}

export class ResponseCache implements CacheLike {
  private readonly dir: string;
  private readonly enabled: boolean;
  private readonly maxAgeMs: number;

  constructor(options: CacheOptions = {}) {
    this.dir = options.dir ?? defaultCacheDir();
    this.enabled = options.enabled ?? true;
    this.maxAgeMs = options.maxAgeMs ?? 7 * DAY_MS;
  }

  get directory(): string {
    return this.dir;
  }

  async get(key: string, maxAgeMs = this.maxAgeMs): Promise<string | null> {
    if (!this.enabled) return null;
    const file = join(this.dir, `${key}.json`);
    try {
      const info = await stat(file);
      if (Date.now() - info.mtimeMs > maxAgeMs) return null;
      return await readFile(file, 'utf8');
    } catch {
      return null;
    }
  }

  async set(key: string, value: string): Promise<void> {
    if (!this.enabled) return;
    try {
      await mkdir(this.dir, { recursive: true });
      // Write to a unique temp file then rename, so concurrent renders never
      // observe a half-written entry.
      const temp = join(this.dir, `.${key}.${process.pid}.${Math.floor(performance.now())}.tmp`);
      await writeFile(temp, value, 'utf8');
      await rename(temp, join(this.dir, `${key}.json`));
    } catch {
      // A cache failure must never break a render.
    }
  }

  /** Removes every entry. Returns the number of files deleted. */
  async clear(): Promise<number> {
    try {
      const entries = await readdir(this.dir);
      let removed = 0;
      for (const entry of entries) {
        if (!entry.endsWith('.json') && !entry.endsWith('.tmp')) continue;
        await rm(join(this.dir, entry), { force: true });
        removed++;
      }
      return removed;
    } catch {
      return 0;
    }
  }
}
