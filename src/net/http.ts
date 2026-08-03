/**
 * HTTP access to public OSM infrastructure.
 *
 * Both Nominatim and Overpass are volunteer-run services with published usage
 * policies. This module enforces the parts that are our responsibility: a
 * descriptive User-Agent, no more than one request per second per host,
 * bounded retries with backoff, and honouring Retry-After.
 *
 * See ATTRIBUTION.md for the policy links.
 */

import { envVar } from './cache.js';
import { PACKAGE_NAME, PROJECT_URL, VERSION } from '../version.js';

export const DEFAULT_USER_AGENT =
  envVar('ISO_CITIES_USER_AGENT') ?? `${PACKAGE_NAME}/${VERSION} (+${PROJECT_URL})`;

/** Minimum gap between requests to the same host, in milliseconds. */
const MIN_INTERVAL_MS = 1100;

const lastRequestAt = new Map<string, number>();
const hostQueues = new Map<string, Promise<unknown>>();

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Serialises work per host and spaces it out to respect the rate limit. */
async function withHostLimit<T>(host: string, task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const previous = hostQueues.get(host) ?? Promise.resolve();
  const run = previous.then(async () => {
    const last = lastRequestAt.get(host) ?? 0;
    const wait = MIN_INTERVAL_MS - (Date.now() - last);
    if (wait > 0) await sleep(wait, signal);
    lastRequestAt.set(host, Date.now());
    return task();
  });
  // Keep the chain alive even when a link rejects, so later calls still queue.
  hostQueues.set(
    host,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

export class HttpError extends Error {
  readonly status: number;
  readonly url: string;
  readonly body: string;

  constructor(status: number, url: string, body: string) {
    super(`HTTP ${status} from ${url}${body ? `: ${body.slice(0, 200)}` : ''}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: string;
  headers?: Record<string, string>;
  userAgent?: string;
  timeoutMs?: number;
  retries?: number;
  signal?: AbortSignal;
  onRetry?: (attempt: number, delayMs: number, reason: string) => void;
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * Performs a rate-limited request with retries, returning the response body
 * as text. Throws {@link HttpError} for non-retryable or exhausted failures.
 */
export async function request(url: string, options: RequestOptions = {}): Promise<string> {
  const {
    method = 'GET',
    body,
    headers = {},
    userAgent = DEFAULT_USER_AGENT,
    timeoutMs = 90_000,
    retries = 3,
    signal,
    onRetry,
  } = options;

  const host = new URL(url).host;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const delay = Math.min(30_000, 1500 * 2 ** (attempt - 1));
      onRetry?.(attempt, delay, describe(lastError));
      await sleep(delay, signal);
    }

    try {
      return await withHostLimit(
        host,
        async () => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);
          const onOuterAbort = () => controller.abort();
          signal?.addEventListener('abort', onOuterAbort, { once: true });

          try {
            const init: RequestInit = {
              method,
              headers: {
                'User-Agent': userAgent,
                Accept: 'application/json',
                ...headers,
              },
              signal: controller.signal,
            };
            if (body !== undefined) init.body = body;

            const response = await fetch(url, init);
            const text = await response.text();
            if (!response.ok) {
              const retryAfter = Number(response.headers.get('retry-after'));
              if (RETRYABLE.has(response.status) && Number.isFinite(retryAfter) && retryAfter > 0) {
                await sleep(Math.min(60_000, retryAfter * 1000), signal);
              }
              throw new HttpError(response.status, url, text);
            }
            return text;
          } finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onOuterAbort);
          }
        },
        signal,
      );
    } catch (error) {
      lastError = error;
      if (signal?.aborted) throw error;
      const retryable =
        (error instanceof HttpError && RETRYABLE.has(error.status)) ||
        (error instanceof Error && (error.name === 'AbortError' || error.name === 'TypeError'));
      if (!retryable || attempt === retries) throw error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function describe(error: unknown): string {
  if (error instanceof HttpError) return `HTTP ${error.status}`;
  if (error instanceof Error) return error.message;
  return 'unknown error';
}
