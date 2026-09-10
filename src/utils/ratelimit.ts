// ─── Rate limiter: cap LLM requests per minute (sliding window) ───
// Guards against runaway loops burning quota + provider 429s.
// rpm <= 0 means unlimited (used for local limitless providers).
export class RateLimiter {
  private stamps: number[] = [];

  constructor(
    private maxPerMinute: number,
    private windowMs = 60_000,
  ) {}

  setLimit(n: number): void {
    this.maxPerMinute = n;
  }

  usage(): { used: number; limit: number } {
    this.prune(Date.now());
    return { used: this.stamps.length, limit: this.maxPerMinute };
  }

  private prune(now: number): void {
    this.stamps = this.stamps.filter((t) => now - t < this.windowMs);
  }

  /** Wait for a free slot. Refuses when the signal aborts. */
  async acquire(signal?: AbortSignal): Promise<void> {
    if (this.maxPerMinute <= 0) return;
    for (;;) {
      const now = Date.now();
      this.prune(now);
      if (this.stamps.length < this.maxPerMinute) {
        this.stamps.push(now);
        return;
      }
      const waitMs = Math.max(0, this.stamps[0] + this.windowMs - now);
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      await new Promise<void>((res, rej) => {
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          res();
        }, waitMs);
        const onAbort = () => {
          clearTimeout(timer);
          rej(new DOMException("Aborted", "AbortError"));
        };
        if (signal) {
          if (signal.aborted) {
            clearTimeout(timer);
            rej(new DOMException("Aborted", "AbortError"));
          } else {
            signal.addEventListener("abort", onAbort, { once: true });
          }
        }
      });
    }
  }
}
