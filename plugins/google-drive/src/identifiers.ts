/**
 * The identifier grammars of the `google-drive` service, shared by
 * `classify`, `execute` and discovery. Each returns the value or `null`; a
 * value outside its grammar is refused, never repaired.
 *
 * Handbook : docs/handbook/services/google-drive.md ("Identifiers").
 * ADR      : docs/decisions/plugin-identifiers-one-grammar-for-classify-and-execute.md.
 */

/**
 * A Drive file or folder id: letters, digits, `_` and `-` (Drive writes ids
 * such as `1A2b3C_d-E`), up to 128 characters. `root` is one too: Drive's
 * alias of the account's top folder. Never a dot segment, a separator or `%`.
 */
export const DRIVE_FILE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function fileId(value: unknown): string | null {
  return typeof value === 'string' && DRIVE_FILE_ID.test(value) ? value : null;
}

/**
 * One path segment of a request URL from a value its grammar already
 * accepted: refused (`null`) when it is empty, a dot segment, or holds `/`,
 * `?`, `#`, `%`, `\` or a control character — never repaired — then
 * percent-encoded.
 */
export function pathSegment(value: string): string | null {
  if (value === '' || value === '.' || value === '..') return null;
  // eslint-disable-next-line no-control-regex -- control characters are what this refuses
  if (/[/?#%\\\u0000-\u001f\u007f]/.test(value)) return null;
  return encodeURIComponent(value);
}

/**
 * `local` + `separator` + a dotted domain, checked part by part (no nested
 * quantifier: no backtracking on a long input): a local part of letters,
 * digits and `._%+-`, then labels of letters, digits and `-`, at least two.
 */
function isAddressLike(value: string, separator: '@' | '~'): boolean {
  if (value.length > 254 || value.includes('..')) return false;
  const at = value.indexOf(separator);
  if (at <= 0 || value.indexOf(separator, at + 1) !== -1) return false;
  const labels = value.slice(at + 1).split('.');
  return (
    /^[a-z0-9._%+-]+$/.test(value.slice(0, at)) &&
    labels.length >= 2 &&
    labels.every((label) => /^[a-z0-9-]+$/.test(label))
  );
}

/** An address as Google names the account: lower-cased, one `@`, a dotted domain. */
export function accountAddress(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const address = value.trim().toLowerCase();
  return isAddressLike(address, '@') ? address : null;
}

/** The ref of a drive from the account's address: `@` written `~` (alice~acme.com). */
export function driveRefOf(address: string): string {
  return address.replace('@', '~');
}

/** A drive ref as an agent writes it: the ref itself, or the account's address. */
export function driveRefFromArgument(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (value.includes('@')) {
    const address = accountAddress(value);
    return address === null ? null : driveRefOf(address);
  }
  return isAddressLike(value, '~') ? value : null;
}

// eslint-disable-next-line no-control-regex -- control characters are what this refuses
const CONTROL = /[\u0000-\u001f\u007f]/;

/** A file or folder name: 1 to 255 characters, no control character, not a dot segment. */
export function itemName(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 255) return null;
  if (value === '.' || value === '..' || CONTROL.test(value)) return null;
  return value;
}

/** Search text: 1 to 200 characters, no control character. */
export function searchText(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 200) return null;
  return CONTROL.test(value) ? null : value;
}

/**
 * The type of a file an agent uploads: text it can write — any `text/*`, JSON,
 * XML or YAML. Binary content is not uploaded in this version.
 */
export function textMimeType(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const lower = value.toLowerCase();
  return /^(text\/[a-z0-9.+-]{1,64}|application\/(json|xml|x-yaml|yaml))$/.test(lower)
    ? lower
    : null;
}

/** Whether a stored file of this type is read as text (`files.get?alt=media`). */
export function isTextType(mimeType: string): boolean {
  return textMimeType(mimeType.split(';')[0]!.trim()) !== null;
}
