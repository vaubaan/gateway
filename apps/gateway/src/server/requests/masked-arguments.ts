/**
 * Secret arguments, as the person answering an approval request sees them.
 *
 * A plugin names, per tool, the arguments whose values are secrets
 * (`ProviderPlugin.secretArguments` : `fly__set_secrets` → `values`). The
 * approval view shows the call's arguments in clear while the request is
 * open; for those arguments it shows, instead of each string value, a short
 * fingerprint — enough to tell two values apart and to compare with the
 * digest the provider lists, never enough to read the value. The keys of an
 * object (the secret names) stay. The sealed arguments and the call that may
 * be replayed are unchanged. Pure.
 *
 * Handbook: docs/handbook/requests.md ("Who reads the arguments").
 */
import { createHash } from 'node:crypto';

import type { PluginRegistry } from '@vaubaan/plugin-sdk';
import { splitToolName } from '@vaubaan/shared';

/** Hex characters of the SHA-256 shown. */
const FINGERPRINT_HEX = 12;

/** What replaces one secret string. */
export function maskedValue(value: string): string {
  const digest = createHash('sha256').update(value, 'utf8').digest('hex');
  return `[secret · sha256:${digest.slice(0, FINGERPRINT_HEX)}]`;
}

/** Every string inside `value` masked ; keys, numbers, booleans and null kept. */
function masked(value: unknown): unknown {
  if (typeof value === 'string') return maskedValue(value);
  if (Array.isArray(value)) return value.map(masked);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, masked(inner)]));
  }
  return value;
}

/** The arguments of `tool` with the plugin's secret arguments masked. */
export function maskSecretArguments(
  registry: Pick<PluginRegistry, 'get'>,
  tool: string,
  args: unknown,
): unknown {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return args;
  const split = splitToolName(tool);
  const names = split ? registry.get(split.providerId)?.plugin.secretArguments?.[tool] : undefined;
  if (!names || names.length === 0) return args;
  const secret = new Set(names);
  return Object.fromEntries(
    Object.entries(args).map(([key, value]) => [key, secret.has(key) ? masked(value) : value]),
  );
}
