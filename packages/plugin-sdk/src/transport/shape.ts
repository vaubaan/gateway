/**
 * What a service answers is untrusted : it becomes a typed value only
 * through a type guard, never a cast. `readShape` is that step, and fails
 * the way a service failure fails (`UpstreamProtocolError`), so a shape
 * change at the service is a call that failed at the service, with the
 * request named, instead of a `TypeError` deep in `execute`.
 */

import { UpstreamProtocolError } from './errors.ts';

/** A type guard over an untrusted value. */
export type Guard<T> = (value: unknown) => value is T;

/**
 * `value` as a `T`, or `UpstreamProtocolError` "unexpected answer". `what`
 * names where the value came from and what was expected, in the plugin's
 * words (`'GET /workspaces: a list of { id, name }'`) ; never the value.
 */
export function readShape<T>(value: unknown, guard: Guard<T>, what: string): T {
  if (guard(value)) return value;
  throw new UpstreamProtocolError(`${what}: unexpected answer`);
}

/**
 * The guard that accepts every JSON value : for an answer the plugin passes
 * through without reading it (shown to the agent as it is), or ignores (the
 * answer to a `DELETE`).
 */
export function anyJson(value: unknown): value is unknown {
  return value !== undefined;
}
