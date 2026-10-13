/**
 * Validation of what a human types into the connect flows: the fields a
 * `CredentialSpec` declares, the connection name, the return address, and the
 * owner's edits on a resource. Pure functions; problems are sentences safe to
 * show (a secret value is never echoed).
 */
import { ENV_LABEL_PATTERN } from '@vaubaan/shared';
import type { CredentialField } from '@vaubaan/plugin-sdk';

export const MAX_NAME_CHARS = 80;
const MAX_FIELD_CHARS = 8192;
const MAX_LIST_ENTRIES = 200;
const MAX_LIST_ENTRY_CHARS = 254;

export interface FieldValues {
  /** Every provided value, keyed by field name. */
  readonly values: Record<string, string>;
  /** The non-secret subset: safe to keep in clear next to the connection. */
  readonly visible: Record<string, string>;
  readonly problems: readonly string[];
}

export function readCredentialFields(
  fields: readonly CredentialField[],
  input: Readonly<Record<string, string>>,
): FieldValues {
  const values: Record<string, string> = {};
  const visible: Record<string, string> = {};
  const problems: string[] = [];
  for (const field of fields) {
    const raw = (input[field.name] ?? '').trim();
    if (raw.length === 0) {
      if (field.required !== false) problems.push(`${field.label} is required`);
      continue;
    }
    if (raw.length > MAX_FIELD_CHARS) {
      problems.push(`${field.label} is too long`);
      continue;
    }
    if (field.pattern && !new RegExp(field.pattern).test(raw)) {
      problems.push(`${field.label} does not have the expected format`);
      continue;
    }
    values[field.name] = raw;
    if (!field.secret) visible[field.name] = raw;
  }
  return { values, visible, problems };
}

/** A display name: trimmed, single line, bounded; `null` when blank. */
export function cleanName(raw: string | null | undefined): string | null {
  const name = (raw ?? '').replace(/\s+/g, ' ').trim();
  return name.length === 0 ? null : name.slice(0, MAX_NAME_CHARS);
}

export { resolveReturnTo } from '../http/return-to';

/** `prod`, `staging`… (`ENV_LABEL_PATTERN`); blank clears the label. */
export function parseEnvLabel(
  raw: string,
): { ok: true; env: string | null } | { ok: false; problem: string } {
  const label = raw.trim().toLowerCase();
  if (label.length === 0) return { ok: true, env: null };
  if (!ENV_LABEL_PATTERN.test(label)) {
    return {
      ok: false,
      problem:
        'an environment label is lower-case letters, digits and dashes, starting with a letter',
    };
  }
  return { ok: true, env: label };
}

/**
 * Metadata keys the owner may edit on a resource: the ones whose discovered
 * value is a list of strings (Resend's `internal_domains`,
 * `allowlist_domains`, `allowlist_addresses`). Scalars are provider facts
 * (ids, status, region) and stay read-only.
 */
export function editableMetadataKeys(metadata: Readonly<Record<string, unknown>> | null): string[] {
  if (!metadata) return [];
  return Object.entries(metadata)
    .filter(([, value]) => Array.isArray(value) && value.every((v) => typeof v === 'string'))
    .map(([key]) => key)
    .sort();
}

/** Whitespace, comma or newline separated entries → a de-duplicated lower-cased list. */
export function parseListValue(
  raw: string,
): { ok: true; list: string[] } | { ok: false; problem: string } {
  const list: string[] = [];
  for (const part of raw.split(/[\s,]+/)) {
    const entry = part.trim().toLowerCase();
    if (entry.length === 0 || list.includes(entry)) continue;
    if (entry.length > MAX_LIST_ENTRY_CHARS) return { ok: false, problem: 'an entry is too long' };
    list.push(entry);
  }
  if (list.length > MAX_LIST_ENTRIES) {
    return { ok: false, problem: `at most ${MAX_LIST_ENTRIES} entries per list` };
  }
  return { ok: true, list };
}
