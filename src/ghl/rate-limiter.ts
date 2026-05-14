/**
 * Token bucket rate limiter.
 * GHL allows 100 requests / 10 seconds = 10/s sustained.
 * We run conservatively at 7/s sustained with burst 30 — 30% headroom under
 * the documented limit so jitter and clock drift don't trigger 429s.
 */

export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
  ) {
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSec);
    this.lastRefill = now;
  }

  async acquire(): Promise<void> {
    while (true) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const tokensNeeded = 1 - this.tokens;
      const waitMs = Math.ceil((tokensNeeded / this.refillPerSec) * 1000) + 1;
      await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

/**
 * Global cooldown gate. When any request hits 429, we set a future timestamp
 * here and ALL concurrent requests block until it passes. Without this, the
 * other in-flight requests keep firing while one is in retry-backoff and pile
 * up more 429s (retry amplification).
 */
export class CooldownGate {
  private pausedUntil = 0;

  /** Block until any active cooldown has expired. */
  async wait(): Promise<void> {
    while (true) {
      const now = Date.now();
      if (this.pausedUntil <= now) return;
      await new Promise<void>((resolve) => setTimeout(resolve, this.pausedUntil - now));
    }
  }

  /** Extend the cooldown to at least now+ms. Multiple 429s extend, not reset. */
  pauseFor(ms: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + ms);
  }
}
