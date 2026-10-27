/**
 * Token buckets for `POST /attest`, the one call anyone may make (it carries
 * no key: the gateway sends no secret before the connection is verified).
 * One bucket per source address, and one for all, kept under Confidential
 * Space's own limit of 5 attestation requests per second per project and
 * region, so that one caller cannot starve the others nor the quota.
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
  /** Addresses remembered at most; the oldest are forgotten beyond. */
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
    this.#perAddress = options.perAddress ?? { burst: 5, perSecond: 0.5 };
    this.#globalRate = options.global ?? { burst: 10, perSecond: 4 };
    this.#maxAddresses = options.maxAddresses ?? 10_000;
    this.#global = { tokens: this.#globalRate.burst, at: this.#now() };
  }

  /** True when the call may go on; it then counts. */
  allow(address: string): boolean {
    const now = this.#now();
    let bucket = this.#buckets.get(address);
    if (bucket === undefined) {
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
