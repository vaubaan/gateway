/**
 * The attestation `POST /attest` serves: one token, fetched from the platform
 * in the background and served from memory, whose only nonce is
 * base64url(SHA-256(DER SPKI)) of the API's TLS key (ADR amendment "review").
 *
 * No per-request nonce, on purpose: what secures the channel is that the
 * token names the key of the TLS connection the gateway is on, and that it is
 * fresh (the gateway refuses one issued more than 10 minutes ago). A replayed
 * token is harmless, since whoever replays it does not hold the enclave's
 * private key and cannot complete the TLS handshake for that key. Serving a
 * cached answer also means no request ever reaches the launcher or the
 * platform's quota.
 */
import { errorKind, type Logger } from './log.ts';
import { type Attestation, type PlatformAdapter } from './platform/types.ts';

export interface AttestationCacheOptions {
  readonly now?: () => number;
  /** How often a fresh token is fetched. */
  readonly refreshMs?: number;
  /** How soon a failed fetch is tried again. */
  readonly retryMs?: number;
  /** A token older than this is not served (the gateway refuses it anyway). */
  readonly maxAgeMs?: number;
}

export class AttestationCache {
  readonly #platform: PlatformAdapter;
  readonly #publicKeySha256: string;
  readonly #log: Logger;
  readonly #now: () => number;
  readonly #refreshMs: number;
  readonly #retryMs: number;
  readonly #maxAgeMs: number;
  #current: { attestation: Attestation; at: number } | undefined;
  #timer: NodeJS.Timeout | undefined;
  #stopped = false;

  constructor(
    platform: PlatformAdapter,
    publicKeySha256: string,
    log: Logger,
    options: AttestationCacheOptions = {},
  ) {
    this.#platform = platform;
    this.#publicKeySha256 = publicKeySha256;
    this.#log = log;
    this.#now = options.now ?? Date.now;
    this.#refreshMs = options.refreshMs ?? 5 * 60_000;
    this.#retryMs = options.retryMs ?? 15_000;
    this.#maxAgeMs = options.maxAgeMs ?? 9 * 60_000;
  }

  /** Fetches now; true when a fresh token is in memory. Never throws. */
  async refresh(): Promise<boolean> {
    try {
      const attestation = await this.#platform.attest([this.#publicKeySha256]);
      this.#current = { attestation, at: this.#now() };
      return true;
    } catch (error) {
      this.#log.warn('attestation_failed', { kind: errorKind(error) });
      return false;
    }
  }

  /** Fetches once, then keeps refreshing: every 5 minutes, sooner after a failure. */
  async start(): Promise<void> {
    const ok = await this.refresh();
    this.#schedule(ok ? this.#refreshMs : this.#retryMs);
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
  }

  /** The token to serve, or undefined when none is fresh enough. */
  current(): Attestation | undefined {
    const current = this.#current;
    if (current === undefined || this.#now() - current.at > this.#maxAgeMs) return undefined;
    return current.attestation;
  }

  #schedule(delayMs: number): void {
    if (this.#stopped) return;
    this.#timer = setTimeout(() => {
      void this.refresh().then((ok) => this.#schedule(ok ? this.#refreshMs : this.#retryMs));
    }, delayMs);
    this.#timer.unref();
  }
}
