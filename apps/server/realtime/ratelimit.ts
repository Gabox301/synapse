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

/**
 * Perfil calibrado (Etapa 7 T4; medido en ratelimit_tuning_test.ts).
 * Legítimo 1 pestaña ~= 21 msg/s (5 updates + 16 awareness con throttle
 * 60ms); 5 pestañas ~= 105 msg/s. Abuso típico: 200 msg/s por conexión.
 */
/** Por conexión: ráfagas de join (100) + 2.4x del ritmo legítimo. */
export const CONN_LIMIT: BucketOpts = { capacity: 100, refillPerSec: 50 };
/** Por usuario: cubre 5 pestañas sostenidas (105/s) con margen; el abuso
 *  distribuido (300/s) se cierra igual por drops acumulados. */
export const USER_LIMIT: BucketOpts = { capacity: 300, refillPerSec: 150 };
/** Auth por IP: 5 intentos y luego 1/min (antes 20: laxo ante fuerza bruta). */
export const AUTH_LIMIT: BucketOpts = { capacity: 5, refillPerSec: 5 / 60 };
/** Rechazos acumulados (conn+usuario) antes de cerrar con 4429. */
export const CLOSE_AFTER_DROPS = 25;
