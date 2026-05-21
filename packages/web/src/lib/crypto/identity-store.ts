/**
 * In-memory identity store for the unwrapped user crypto identity.
 *
 * Spec §4.1.1 mandates that the unwrapped private key lives in memory
 * only on browser devices — never in localStorage, sessionStorage, or
 * IndexedDB. This module is the single source of truth for the live
 * keypair, and it intentionally exposes no persistence hook.
 *
 * `clear()` wipes the underlying bytes before dropping the reference
 * (defense in depth — the engine may still keep copies in heap
 * snapshots, but we narrow the window).
 */

export interface Identity {
  readonly publicKey: Uint8Array;
  readonly privateKey: Uint8Array;
  readonly fingerprint: string;
}

let cached: Identity | null = null;

export const identityStore = {
  set(id: Identity): void {
    cached = id;
  },
  get(): Identity | null {
    return cached;
  },
  clear(): void {
    if (cached) {
      cached.privateKey.fill(0);
      cached.publicKey.fill(0);
    }
    cached = null;
  },
};
