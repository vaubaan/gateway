/**
 * Token buckets for `POST /attest`, the one call anyone may make (it carries
 * no key: the gateway sends no secret before the connection is verified).
 * The answer is a token cached in memory (src/attestation.ts), so the limits
 * are generous: they only stop one caller from occupying the listener. One
 * bucket per source address, the least recently seen forgotten first, and one
 * for all callers together.
 */
interface Bucket {
  tokens: number;
  at: number;
}

export interface RateLimitOptions {
  readonly now?: () => number;
  /** Per address: burst and refill per second. */
  readonly perAddress?: { readonly burst: number; readonly perSecond: number };
  readonly global?: { readonly burst: number; readonly perSecond: number };
  /** Addresses remembered at most; the least recently seen are forgotten beyond. */
  readonly maxAddresses?: number;
}

export class AttestRateLimit {
  readonly #now: () => number;
  readonly #perAddress: { readonly burst: number; readonly perSecond: number };
  readonly #globalRate: { readonly burst: number; readonly perSecond: number };
  readonly #maxAddresses: number;
  readonly #buckets = new Map<string, Bucket>();
  readonly #global: Bucket;

  constructor(options: RateLimitOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#perAddress = options.perAddress ?? { burst: 30, perSecond: 5 };
    this.#globalRate = options.global ?? { burst: 1000, perSecond: 300 };
    this.#maxAddresses = options.maxAddresses ?? 10_000;
    this.#global = { tokens: this.#globalRate.burst, at: this.#now() };
  }

  /** True when the call may go on; it then counts. */
  allow(address: string): boolean {
    const now = this.#now();
    let bucket = this.#buckets.get(address);
    if (bucket !== undefined) {
      // Seen now: moved last. A Map iterates in insertion order, so the first is the least recently seen.
      this.#buckets.delete(address);
      this.#buckets.set(address, bucket);
    } else {
      if (this.#buckets.size >= this.#maxAddresses) {
        const oldest = this.#buckets.keys().next().value;
        if (oldest !== undefined) this.#buckets.delete(oldest);
      }
      bucket = { tokens: this.#perAddress.burst, at: now };
      this.#buckets.set(address, bucket);
    }
    refill(bucket, this.#perAddress, now);
    refill(this.#global, this.#globalRate, now);
    if (bucket.tokens < 1 || this.#global.tokens < 1) return false;
    bucket.tokens -= 1;
    this.#global.tokens -= 1;
    return true;
  }
}

function refill(bucket: Bucket, rate: { burst: number; perSecond: number }, now: number): void {
  bucket.tokens = Math.min(rate.burst, bucket.tokens + ((now - bucket.at) / 1000) * rate.perSecond);
  bucket.at = now;
}

/**
 * Refreshes per instance (spec oauth-broker §2): every instance shares the
 * provider's client and its quota, so one instance in a loop must not spend
 * it for the others. A bucket per enrolled instance holding an hour's
 * allowance, refilled evenly over the hour; the enrolled instances are few
 * and fixed until the next restart, so nothing is evicted.
 */
export class RefreshLimit {
  readonly #now: () => number;
  readonly #rate: { readonly burst: number; readonly perSecond: number };
  readonly #buckets = new Map<string, Bucket>();

  constructor(perHour: number, now: () => number = Date.now) {
    this.#now = now;
    this.#rate = { burst: perHour, perSecond: perHour / 3600 };
  }

  /** `0` when the refresh may go on (it then counts), else the seconds to wait. */
  take(instanceId: string): number {
    const now = this.#now();
    let bucket = this.#buckets.get(instanceId);
    if (bucket === undefined) {
      bucket = { tokens: this.#rate.burst, at: now };
      this.#buckets.set(instanceId, bucket);
    }
    refill(bucket, this.#rate, now);
    if (bucket.tokens < 1) return Math.ceil((1 - bucket.tokens) / this.#rate.perSecond);
    bucket.tokens -= 1;
    return 0;
  }
}
