/**
 * Ports of the composition root.
 *
 * Everything that holds state or talks to the outside world is reached
 * through one of these interfaces so that the single-process v5 deployment
 * (SQLite, in-memory windows) and a later hosted deployment (Postgres, Redis)
 * differ only in the implementations the root is built with
 * (plan §3.1; `_common.md` "keep the hosted/managed path open").
 *
 * The concrete `Store` (P0.3) and `PluginRegistry` (P0.2) are defined by
 * their own features; this file states only what the root needs from them.
 */

/** What the composition root needs from the embedded store (P0.3 owns the repositories). */
export interface Store {
  /** `sqlite`, `memory`, `postgres`… for the boot log and `/healthz`. */
  readonly kind: string;
  /** Cheap liveness probe (`SELECT 1`); rejects when the store is unusable. */
  ping(): Promise<void>;
  close(): Promise<void>;
}

export interface PluginSummary {
  readonly id: string;
  readonly displayName: string;
  readonly version: string;
}

/** The single source of truth for the provider list (P0.2 owns the real one). */
export interface PluginRegistry {
  list(): readonly PluginSummary[];
  has(id: string): boolean;
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

/** Short-lived cache for verified contexts (plan §3.5, risk 27). */
export interface CacheClient {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttlMs: number): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Opaque web sessions keyed by cookie value (P1.1 decides the record shape). */
export interface SessionStore<T = unknown> {
  get(id: string): Promise<T | null>;
  set(id: string, value: T, ttlMs: number): Promise<void>;
  delete(id: string): Promise<void>;
}
