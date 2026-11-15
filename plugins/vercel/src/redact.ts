/**
 * Redaction of env-var values on the encrypted read of `list_env_vars`.
 *
 * Handbook : docs/handbook/services/vercel.md (env vars).
 *
 * `vercel.read-env-var` (`data: metadata`, in the `watch` macro-action) prices the
 * listing of env-var **keys** ; reading values is `vercel.read-env-var-plaintext`
 * (`data: secret`, `decrypt=true`). Without `decrypt`, Vercel still answers
 * with a `value` per entry — ciphertext for `encrypted` vars, but the value in
 * clear for `plain` ones, and other fields that may carry one (`vsmValue`,
 * `internalContentHint.encryptedValue`). So the encrypted read keeps an
 * **allow-list** of descriptive fields per entry ; every other field holding
 * a value is replaced by `REDACTED_VALUE`, a field Vercel adds tomorrow
 * included.
 */

import { isList, isRecord } from '@vaubaan/plugin-sdk';

/** The fixed marker that replaces a value the risk does not cover. */
export const REDACTED_VALUE = '[redacted by Vaubaan]';

/** Fields of one env-var entry returned on the encrypted read. `value` is not one. */
export const ENV_VAR_PUBLIC_FIELDS: ReadonlySet<string> = new Set([
  'id',
  'key',
  'type',
  'target',
  'gitBranch',
  'customEnvironmentIds',
  'comment',
  'decrypted',
  'system',
  'configurationId',
  'createdAt',
  'updatedAt',
  'createdBy',
  'updatedBy',
]);

export function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || value === '';
}

export function redactEntry(entry: unknown): unknown {
  if (!isRecord(entry)) return isEmpty(entry) ? entry : REDACTED_VALUE;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    out[key] = ENV_VAR_PUBLIC_FIELDS.has(key) || isEmpty(value) ? value : REDACTED_VALUE;
  }
  return out;
}

/**
 * The answer of `GET /v10/projects/{id}/env` without `decrypt` : `{ envs,
 * pagination }`, a bare list, or one entry. Entries keep their descriptive
 * fields only ; `pagination` stays as it is.
 */
export function redactEncryptedEnvListing(payload: unknown): unknown {
  if (isList(payload)) return payload.map(redactEntry);
  if (!isRecord(payload)) return payload;
  if (isList(payload.envs)) return { ...payload, envs: payload.envs.map(redactEntry) };
  return redactEntry(payload);
}
