/**
 * The name of a named token (spec §0 "Mission token": "identified by the name
 * the creator gives it"). Pure and browser-safe: the form states the same rule.
 *
 * The name is shown in the session, the audit and the catalog an agent reads,
 * and is typed back as a filter. It is therefore kept to a line a human reads
 * at a glance: letters, digits, spaces and `. _ -`, starting with a letter or
 * a digit. In particular no `@`: a holder shown with one is a member's email,
 * never a name somebody chose to look like one.
 */
export const TOKEN_NAME_MAX_LENGTH = 60;
const TOKEN_NAME_SHAPE = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/;

export const TOKEN_NAME_RULE = `1 to ${TOKEN_NAME_MAX_LENGTH} characters: letters, digits, spaces, dots, dashes and underscores, starting with a letter or a digit`;

export type ParsedTokenName =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly problem: string };

/** The name as stored: trimmed, inner runs of spaces collapsed to one. */
export function parseTokenName(raw: unknown): ParsedTokenName {
  if (typeof raw !== 'string') {
    return { ok: false, problem: `A name is required (${TOKEN_NAME_RULE}).` };
  }
  const value = raw.trim().replace(/ {2,}/g, ' ');
  if (value.length === 0 || value.length > TOKEN_NAME_MAX_LENGTH || !TOKEN_NAME_SHAPE.test(value)) {
    return { ok: false, problem: `The name must be ${TOKEN_NAME_RULE}.` };
  }
  return { ok: true, value };
}
