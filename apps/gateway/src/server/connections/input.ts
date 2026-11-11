/**
 * Validation of what a human types into the connect flows: the fields a
 * `CredentialSpec` declares, the connection name, the return address, and the
 * owner's edits on a resource. Pure functions; problems are sentences safe to
 * show (a secret value is never echoed).
 */
import { ENV_LABEL_PATTERN } from '@vaubaan/shared';
import type { CredentialAlternative, CredentialField, Resource } from '@vaubaan/plugin-sdk';

import type { DiscoveredResource } from '../store/types';

export const MAX_NAME_CHARS = 80;
const MAX_FIELD_CHARS = 8192;
const MAX_LIST_ENTRIES = 200;
const MAX_LIST_ENTRY_CHARS = 254;

/** What is wrong with the value of one field. */
export type FieldProblem = 'required' | 'too-long' | 'format';

export interface FieldValues {
  /** Every provided value, keyed by field name. */
  readonly values: Record<string, string>;
  /** The non-secret subset: safe to keep in clear next to the connection. */
  readonly visible: Record<string, string>;
  readonly problems: readonly string[];
  /** The same problems by field name, for a form that marks the field itself. */
  readonly invalid: Readonly<Record<string, FieldProblem>>;
}

export function readCredentialFields(
  fields: readonly CredentialField[],
  input: Readonly<Record<string, string>>,
): FieldValues {
  const values: Record<string, string> = {};
  const visible: Record<string, string> = {};
  const problems: string[] = [];
  const invalid: Record<string, FieldProblem> = {};
  for (const field of fields) {
    const raw = (input[field.name] ?? '').trim();
    if (raw.length === 0) {
      if (field.required !== false) {
        problems.push(`${field.label} is required`);
        invalid[field.name] = 'required';
      }
      continue;
    }
    if (raw.length > MAX_FIELD_CHARS) {
      problems.push(`${field.label} is too long`);
      invalid[field.name] = 'too-long';
      continue;
    }
    // nosemgrep: detect-non-literal-regexp -- pattern is a plugin's credential-field declaration (code shipped in the image), not input
    if (field.pattern && !new RegExp(field.pattern).test(raw)) {
      problems.push(`${field.label} does not have the expected format`);
      invalid[field.name] = 'format';
      continue;
    }
    values[field.name] = raw;
    if (!field.secret) visible[field.name] = raw;
  }
  return { values, visible, problems, invalid };
}

/**
 * The fields of a connect form: the spec's, and its alternatives when the
 * key comes in several shapes (`CredentialAlternative`, Vercel: a team or one
 * project). `ConnectableProvider` and an `api-key` spec are both one.
 */
export interface FormFields {
  readonly fields: readonly CredentialField[];
  readonly alternatives?: readonly CredentialAlternative[];
}

export type AlternativeChoice =
  | { readonly ok: true; readonly alternative: CredentialAlternative | null }
  | { readonly ok: false; readonly problem: string };

/**
 * The alternative a form is read with: the one the person chose
 * (`chosen`, the radio), or — when nothing was chosen (the v4 import, a
 * client that posts no radio) — the only alternative whose own fields hold a
 * value. No choice and no field, or the fields of several: a problem. A spec
 * without alternatives: `null`.
 */
export function chooseAlternative(
  form: FormFields,
  input: Readonly<Record<string, string>>,
  chosen: string | null | undefined,
): AlternativeChoice {
  const alternatives = form.alternatives ?? [];
  if (alternatives.length === 0) return { ok: true, alternative: null };
  const labels = alternatives.map((a) => a.label).join(' or ');
  const id = (chosen ?? '').trim();
  if (id.length > 0) {
    const alternative = alternatives.find((a) => a.id === id);
    return alternative ? { ok: true, alternative } : { ok: false, problem: `choose ${labels}` };
  }
  const filled = alternatives.filter((a) =>
    a.fields.some((name) => (input[name] ?? '').trim().length > 0),
  );
  if (filled.length === 1) return { ok: true, alternative: filled[0]! };
  return {
    ok: false,
    problem:
      filled.length === 0
        ? `choose ${labels}`
        : `choose ${labels}, not both: fill the fields of one`,
  };
}

/**
 * The fields asked under one alternative: the shared ones and its own; the
 * other alternatives' are neither read nor kept.
 */
export function askedFields(
  form: FormFields,
  alternative: CredentialAlternative | null,
): readonly CredentialField[] {
  const others = new Set(
    (form.alternatives ?? []).filter((a) => a !== alternative).flatMap((a) => a.fields),
  );
  return form.fields.filter((field) => !others.has(field.name));
}

/**
 * `readCredentialFields` over the fields one alternative asks
 * (`chooseAlternative`); a form whose choice cannot be made has that one
 * problem.
 */
export function readCredentialForm(
  form: FormFields,
  input: Readonly<Record<string, string>>,
  chosen: string | null | undefined,
): FieldValues & { readonly alternative: string | null } {
  const choice = chooseAlternative(form, input, chosen);
  if (!choice.ok) {
    return { values: {}, visible: {}, problems: [choice.problem], invalid: {}, alternative: null };
  }
  return {
    ...readCredentialFields(askedFields(form, choice.alternative), input),
    alternative: choice.alternative?.id ?? null,
  };
}

/**
 * What a form that was refused is drawn with again: the name and the
 * non-secret values the person typed, the alternative they chose, and which
 * field is wrong. **Never a secret**: a field declared `secret` is left out
 * whatever it held, so a key is typed again rather than kept anywhere between
 * two requests.
 */
export interface FormEcho {
  readonly name: string;
  readonly values: Readonly<Record<string, string>>;
  readonly invalid: Readonly<Record<string, FieldProblem>>;
  /** The alternative the form was read with; absent when the spec has none or none was made out. */
  readonly alternative?: string;
}

export function echoOfForm(
  form: FormFields,
  input: Readonly<Record<string, string>>,
  name: string | null | undefined,
  chosen?: string | null,
): FormEcho {
  const { invalid, alternative } = readCredentialForm(form, input, chosen);
  const values: Record<string, string> = {};
  for (const field of form.fields) {
    if (field.secret) continue;
    const raw = (input[field.name] ?? '').trim();
    if (raw.length > 0 && raw.length <= MAX_FIELD_CHARS) values[field.name] = raw;
  }
  return {
    name: cleanName(name) ?? '',
    values,
    invalid,
    ...(alternative !== null ? { alternative } : {}),
  };
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

/**
 * What a plugin returned as resources (`discoverResources`, `createdResources`), as the
 * store keeps them: a resource of another provider or without a ref is left out (and
 * counted), a name is cleaned, a label the plugin sets must be a valid environment label
 * (otherwise the resource is kept unlabelled and the owner decides). One rule for the
 * discovery merge and for a created resource.
 */
export function usableResourcesOf(
  providerId: string,
  resources: readonly Resource[],
): { readonly usable: DiscoveredResource[]; readonly unusable: number } {
  const usable: DiscoveredResource[] = [];
  let unusable = 0;
  for (const r of resources) {
    if (r.provider !== providerId || typeof r.ref !== 'string' || r.ref.length === 0) {
      unusable += 1;
      continue;
    }
    const label = typeof r.env === 'string' ? parseEnvLabel(r.env) : null;
    usable.push({
      ref: r.ref,
      displayName: cleanName(r.displayName) ?? r.ref,
      env: label?.ok ? label.env : null,
      metadata: r.metadata ?? null,
    });
  }
  return { usable, unusable };
}
