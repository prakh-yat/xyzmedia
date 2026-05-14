import { request } from 'undici';

const CDN_BASE = 'https://trends-assets.trends.nz/Images/ProductImg';

export interface CdnImage {
  bytes: Uint8Array;
  contentType: string;
}

export interface FetchImageOpts {
  /** Max bytes to accept. Defaults to 24 MB (just under GHL's 25 MB limit). */
  maxBytes?: number;
  /** Per-attempt timeout. Defaults to 90s (the CDN is occasionally slow on first byte). */
  timeoutMs?: number;
  /** Total retry attempts on transient failures (timeout/socket/5xx). Defaults to 4. */
  maxAttempts?: number;
}

const DEFAULT_MAX_BYTES = 24 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_ATTEMPTS = 4;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch a single product image from the public trends.nz CDN.
 *
 * - Returns null on 403/404 (image is not present — not an error).
 * - Retries up to `maxAttempts` times on timeout, network error, or 5xx.
 * - Throws only after retries are exhausted or on non-retryable HTTP errors.
 *
 * Backoff is exponential with jitter: ~1s, ~2s, ~4s, ~8s capped at 10s.
 */
export async function fetchImage(
  code: string,
  idx: number,
  opts: FetchImageOpts = {},
): Promise<CdnImage | null> {
  const url = `${CDN_BASE}/${encodeURIComponent(code)}-${idx}.jpg`;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const max = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  let lastErr: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await request(url, { method: 'GET', signal: ctrl.signal });

      if (res.statusCode === 403 || res.statusCode === 404) {
        await res.body.dump().catch(() => {});
        return null;
      }

      if (res.statusCode >= 500 && res.statusCode < 600) {
        await res.body.dump().catch(() => {});
        lastErr = new Error(`CDN ${url} returned ${res.statusCode}`);
        if (attempt < maxAttempts) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw lastErr;
      }

      if (res.statusCode < 200 || res.statusCode >= 300) {
        const text = await res.body.text().catch(() => '');
        throw new Error(`CDN ${url} returned ${res.statusCode}: ${text.slice(0, 200)}`);
      }

      const lenHeader = res.headers['content-length'];
      const contentLength = Array.isArray(lenHeader) ? Number(lenHeader[0]) : Number(lenHeader);
      if (Number.isFinite(contentLength) && contentLength > max) {
        await res.body.dump().catch(() => {});
        throw new Error(`CDN image ${url} is ${contentLength} bytes (max ${max})`);
      }

      const buf = Buffer.from(await res.body.arrayBuffer());
      if (buf.byteLength > max) {
        throw new Error(`CDN image ${url} streamed ${buf.byteLength} bytes (max ${max})`);
      }

      const ctHeader = res.headers['content-type'];
      const contentType = (Array.isArray(ctHeader) ? ctHeader[0] : ctHeader) ?? 'image/jpeg';

      return { bytes: new Uint8Array(buf), contentType };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Retry on aborts (timeout), socket / network errors. Non-retryable size
      // errors (caught above) bubble through without retrying because they
      // re-throw a fresh Error rather than a transient one.
      const transient =
        msg.includes('aborted') ||
        msg.includes('socket') ||
        msg.includes('ECONNRESET') ||
        msg.includes('ETIMEDOUT') ||
        msg.includes('ENOTFOUND') ||
        msg.includes('EAI_AGAIN') ||
        msg.includes('returned 5');
      lastErr = err instanceof Error ? err : new Error(msg);
      if (transient && attempt < maxAttempts) {
        await sleep(backoffMs(attempt));
        continue;
      }
      throw lastErr;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastErr ?? new Error(`CDN ${url} failed after ${maxAttempts} attempts`);
}

function backoffMs(attempt: number): number {
  const base = Math.min(10_000, 1000 * 2 ** (attempt - 1));
  return Math.floor(base * (0.6 + Math.random() * 0.6));
}
