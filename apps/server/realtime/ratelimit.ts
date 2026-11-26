// Rate limiting por token bucket (Etapa 4 T5). Reloj inyectable para tests.
export interface BucketOpts {
  capacity: number;
  refillPerSec: number;
}

export class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(
    private readonly opts: BucketOpts,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.tokens = opts.capacity;
    this.last = this.now();
  }

  /** Consume un token si hay disponible. */
  take(): boolean {
    const now = this.now();
    const elapsed = Math.max(0, now - this.last) / 1000;
    this.last = now;
    this.tokens = Math.min(this.opts.capacity, this.tokens + elapsed * this.opts.refillPerSec);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/** Registro de buckets por clave (conexión, usuario, IP). */
export class RateLimiter {
  private readonly buckets = new Map<string, TokenBucket>();
  constructor(
    private readonly opts: BucketOpts,
    private readonly now?: () => number,
  ) {}

  take(key: string): boolean {
    let b = this.buckets.get(key);
    if (!b) {
      b = new TokenBucket(this.opts, this.now);
      this.buckets.set(key, b);
    }
    return b.take();
  }

  forget(key: string): void {
    this.buckets.delete(key);
  }
}
