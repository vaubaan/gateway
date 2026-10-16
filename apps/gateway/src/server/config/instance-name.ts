/**
 * The instance's name (spec §4.3, §4.2): a label the interface shows so that
 * someone with several instances open can tell them apart. One rule, used by
 * the configuration loader (`instance_name`) and by the Administration page
 * alike:
 *
 *   - the spaces around it are trimmed;
 *   - 1 to `INSTANCE_NAME_MAX_LENGTH` characters (code points) remain;
 *   - no control character, line or paragraph separator, nor bidirectional
 *     override or isolate (a label that reorders the text around it could
 *     make one instance read as another).
 *
 * It is rendered as text, never as markup: React escapes it, and nothing
 * builds HTML from it by hand.
 */

export const INSTANCE_NAME_MAX_LENGTH = 64;

/**
 * C0 and C1 controls (`\p{Cc}`, tab and newline included), the line and
 * paragraph separators, and the bidirectional embeddings, overrides and
 * isolates (U+202A–U+202E, U+2066–U+2069).
 */
const FORBIDDEN = /[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069]/u;

export type InstanceNameCheck =
  | { readonly ok: true; readonly name: string }
  | { readonly ok: false; readonly problem: 'empty' | 'too-long' | 'control-character' };

/** The words of a refusal, said by the loader and by the Administration page. */
export const INSTANCE_NAME_PROBLEMS: Readonly<
  Record<Exclude<InstanceNameCheck, { ok: true }>['problem'], string>
> = {
  empty: 'must not be empty once the spaces around it are trimmed',
  'too-long': `must be ${INSTANCE_NAME_MAX_LENGTH} characters or fewer`,
  'control-character':
    'must not contain control characters, line breaks or bidirectional overrides',
};

/** Trims `raw` and says whether what remains is a valid instance name. */
export function checkInstanceName(raw: string): InstanceNameCheck {
  const name = raw.trim();
  if (name.length === 0) return { ok: false, problem: 'empty' };
  if (FORBIDDEN.test(name)) return { ok: false, problem: 'control-character' };
  if ([...name].length > INSTANCE_NAME_MAX_LENGTH) return { ok: false, problem: 'too-long' };
  return { ok: true, name };
}
