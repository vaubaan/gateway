/**
 * Ports of the composition root.
 *
 * Everything that holds state or talks to the outside world is reached
 * through one of these interfaces so that the single-process v5 deployment
 * (SQLite, in-memory windows) and a later hosted deployment (Postgres, Redis)
 * differ only in the implementations the root is built with
 * (plan §3.1; `_common.md` "keep the hosted/managed path open").
 *
 * The embedded store (`../store`) and the plugin registry
 * (`@vaubaan/plugin-sdk`) are owned by their own modules; the root
 * holds them by their real types. This file states what the *host* side
 * needs from the store (liveness, for `/healthz` and shutdown) and the
 * in-memory ports the root still implements itself.
 */

export type { CacheClient } from '@vaubaan/gateway-core';

/** What `/healthz` and `close()` need from the store; the embedded `Store` satisfies it. */
export interface StoreLiveness {
  /** `sqlite`, `memory`, `postgres`… for the boot log and `/healthz`. */
  readonly kind: string;
  /** Cheap liveness probe (`SELECT 1`); rejects when the store is unusable. */
  ping(): Promise<void>;
  close(): Promise<void>;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Credits left in the current window after this call. */
  readonly remaining: number;
  /** Milliseconds until the window resets; 0 when allowed. */
  readonly retryAfterMs: number;
}

/** Fixed-window surface rate limit (spec §6 "surface rate limits"). */
export interface RateLimiter {
  take(key: string, limit: number, windowMs: number): Promise<RateLimitDecision>;
}

// The short-lived cache for verified contexts (plan §3.5, risk 27) is
// `@vaubaan/gateway-core`'s `CacheClient` (TTL in seconds, `del`), re-exported
// above: the door consumes it through gateway-core, so it has one definition.

/** Opaque web sessions keyed by cookie value (the record shape is the authentication module's). */
export interface SessionStore<T = unknown> {
  get(id: string): Promise<T | null>;
  set(id: string, value: T, ttlMs: number): Promise<void>;
  delete(id: string): Promise<void>;
}
