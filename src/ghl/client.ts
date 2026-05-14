import type { Logger } from 'pino';
import { ReinstallRequiredError, type Tokens, refreshTokens } from '../oauth/flow.js';
import { CooldownGate, TokenBucket } from './rate-limiter.js';

export interface GhlClientConfig {
  baseUrl: string;
  apiVersion: string;
  oauth: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  };
  tokens: Tokens;
  persistTokens: (tokens: Tokens) => Promise<void>;
  logger: Logger;
  /** Max concurrent in-flight requests. Default 8. */
  maxConcurrent?: number;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

class Mutex {
  private p: Promise<void> = Promise.resolve();
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const tail = this.p.then(() => fn());
    this.p = tail.then(
      () => undefined,
      () => undefined,
    );
    return tail;
  }
}

class Semaphore {
  private permits: number;
  private q: Array<() => void> = [];
  constructor(n: number) {
    this.permits = n;
  }
  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits -= 1;
      return;
    }
    return new Promise<void>((resolve) => this.q.push(resolve));
  }
  release(): void {
    const next = this.q.shift();
    if (next) next();
    else this.permits += 1;
  }
}

export interface RequestOpts {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** If true, body is FormData (multipart). Don't set Content-Type — fetch sets it with boundary. */
  isFormData?: boolean;
  /** Override timeout in ms. Default 60s. */
  timeoutMs?: number;
}

export class GhlClient {
  private readonly bucket = new TokenBucket(30, 7);
  private readonly cooldown = new CooldownGate();
  private readonly semaphore: Semaphore;
  private readonly refreshMutex = new Mutex();
  private tokens: Tokens;
  private dailyRemaining = Number.POSITIVE_INFINITY;

  constructor(private readonly cfg: GhlClientConfig) {
    this.tokens = cfg.tokens;
    this.semaphore = new Semaphore(cfg.maxConcurrent ?? 4);
  }

  /** Most recent X-RateLimit-Daily-Remaining seen. Use for circuit breaker. */
  getDailyRemaining(): number {
    return this.dailyRemaining;
  }

  getLocationId(): string {
    return this.tokens.locationId;
  }

  async request<T = unknown>(path: string, opts: RequestOpts = {}): Promise<T> {
    const method = opts.method ?? 'GET';
    const url = new URL(path, this.cfg.baseUrl);
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }

    await this.semaphore.acquire();
    try {
      return await this.requestWithRetry<T>(url, method, opts);
    } finally {
      this.semaphore.release();
    }
  }

  private async requestWithRetry<T>(url: URL, method: string, opts: RequestOpts): Promise<T> {
    const maxAttempts = 5;
    let attempt = 0;
    let lastErr: Error | undefined;

    while (attempt < maxAttempts) {
      attempt += 1;
      // If a peer request hit 429 recently, every caller waits out the window
      // here before consuming a token. Prevents retry amplification under load.
      await this.cooldown.wait();
      await this.bucket.acquire();
      await this.ensureFreshToken();

      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.tokens.accessToken}`,
        Version: this.cfg.apiVersion,
        Accept: 'application/json',
      };
      let body: BodyInit | undefined;
      if (opts.body !== undefined) {
        if (opts.isFormData) {
          body = opts.body as FormData;
        } else {
          headers['Content-Type'] = 'application/json';
          body = JSON.stringify(opts.body);
        }
      }

      const ctrl = new AbortController();
      const timeoutMs = opts.timeoutMs ?? 60_000;
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);

      let res: Response;
      try {
        res = await fetch(url, { method, headers, body, signal: ctrl.signal });
      } catch (err: unknown) {
        clearTimeout(timer);
        const e = err as { name?: string; message?: string };
        lastErr = new Error(`Network error on ${method} ${url.pathname}: ${e.message ?? String(err)}`);
        if (attempt < maxAttempts) {
          await sleep(jitterBackoff(attempt));
          continue;
        }
        throw lastErr;
      }
      clearTimeout(timer);

      // Track daily quota for circuit breaker
      const dailyHeader = res.headers.get('x-ratelimit-daily-remaining');
      if (dailyHeader) this.dailyRemaining = Number(dailyHeader);

      const reqId = res.headers.get('x-request-id') ?? undefined;

      // 401 → single-flight refresh, retry once
      if (res.status === 401) {
        this.cfg.logger.warn({ method, path: url.pathname, reqId }, 'got 401, refreshing token');
        try {
          await this.refreshOnce();
        } catch (err) {
          throw err; // ReinstallRequiredError or other refresh failure
        }
        if (attempt < maxAttempts) {
          continue;
        }
        const text = await safeReadText(res);
        throw new ApiError('Unauthorized after refresh', res.status, text, reqId);
      }

      // Retryable: 429 / 5xx
      if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
        const text = await safeReadText(res);
        this.cfg.logger.warn(
          { method, path: url.pathname, status: res.status, attempt, reqId, body: text.slice(0, 200) },
          'retryable error',
        );
        if (attempt < maxAttempts) {
          // For 429, prefer the burst window length if set
          const intervalHeader = res.headers.get('x-ratelimit-interval-milliseconds');
          const windowMs = intervalHeader ? Number(intervalHeader) : 0;
          const wait = res.status === 429 && windowMs > 0
            ? windowMs + Math.floor(Math.random() * 500)
            : jitterBackoff(attempt);
          // Open the global cooldown so peer requests pause too — without
          // this, the other 3 in-flight requests would also hit 429 and
          // each retry independently, amplifying the spike.
          if (res.status === 429) this.cooldown.pauseFor(wait);
          await sleep(wait);
          continue;
        }
        throw new ApiError(`HTTP ${res.status} after ${attempt} attempts`, res.status, text, reqId);
      }

      // Non-retryable error
      if (!res.ok) {
        const text = await safeReadText(res);
        throw new ApiError(`HTTP ${res.status}: ${text.slice(0, 500)}`, res.status, text, reqId);
      }

      // Success — parse if there's a body
      const text = await res.text();
      if (!text) return undefined as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        // Some endpoints (collection update/delete) return null body; trust the status
        return undefined as T;
      }
    }

    throw lastErr ?? new Error(`Exhausted ${maxAttempts} attempts`);
  }

  private async ensureFreshToken(): Promise<void> {
    const now = Date.now();
    const skewMs = 60_000;
    if (this.tokens.expiresAt - skewMs > now) return;
    await this.refreshOnce();
  }

  private async refreshOnce(): Promise<void> {
    await this.refreshMutex.run(async () => {
      // Re-check inside mutex — another waiter may have already refreshed
      if (this.tokens.expiresAt - 30_000 > Date.now()) return;

      this.cfg.logger.info('refreshing access token');
      let newTokens: Tokens;
      try {
        newTokens = await refreshTokens({
          clientId: this.cfg.oauth.clientId,
          clientSecret: this.cfg.oauth.clientSecret,
          refreshToken: this.tokens.refreshToken,
          redirectUri: this.cfg.oauth.redirectUri,
        });
      } catch (err) {
        if (err instanceof ReinstallRequiredError) {
          this.cfg.logger.error({ err: err.message }, 'refresh_token rotated/revoked — re-install required');
        }
        throw err;
      }

      // CRITICAL: persist BEFORE updating in-memory tokens, so a crash here
      // surfaces as a clean ReinstallRequiredError on next run rather than
      // silently using a token that's gone from disk.
      await this.cfg.persistTokens(newTokens);
      this.tokens = newTokens;
      this.cfg.logger.info(
        { expiresAt: new Date(newTokens.expiresAt).toISOString() },
        'token refreshed and persisted',
      );
    });
  }
}

function jitterBackoff(attempt: number): number {
  const base = Math.min(60_000, 1000 * 2 ** (attempt - 1));
  return Math.floor(Math.random() * base);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
