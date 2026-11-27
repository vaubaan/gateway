/**
 * The identifier grammars of the `onedrive` service, shared by `classify`,
 * `execute` and discovery. Each returns the value or `null`; a value outside
 * its grammar is refused, never repaired.
 *
 * Handbook : docs/handbook/services/onedrive.md ("Identifiers").
 * ADR      : docs/decisions/plugin-identifiers-one-grammar-for-classify-and-execute.md.
 */

import { DOWNLOAD_HOST_SUFFIXES } from './identity.ts';

/**
 * A drive item id: letters, digits, `!`, `_` and `-` (personal OneDrive
 * writes `D4648F06C91D9D3D!54927`, OneDrive for work `01BYE5RZ6QN3ZW…`), up
 * to 256 characters. `root` is one too: Graph's alias of the top folder.
 * Never a dot, a separator or `%`. In a slice it goes through `identSegment`
 * (a `!` makes it `[*]`).
 */
export const ITEM_ID = /^[A-Za-z0-9!_-]{1,256}$/;

export function itemId(value: unknown): string | null {
  return typeof value === 'string' && ITEM_ID.test(value) ? value : null;
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
    /^[a-z0-9._%+'-]+$/.test(value.slice(0, at)) &&
    labels.length >= 2 &&
    labels.every((label) => /^[a-z0-9-]+$/.test(label))
  );
}

/** An address as Microsoft names the account: lower-cased, one `@`, a dotted domain. */
export function accountAddress(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const address = value.trim().toLowerCase();
  return isAddressLike(address, '@') ? address : null;
}

/** The ref of a drive from the account's address: `@` written `~` (alice~contoso.com). */
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

/**
 * A file or folder name OneDrive accepts: 1 to 255 characters, none of
 * `" * : < > ? / \ |` nor `%` or `#` (kept out of a path segment) nor a control character, no leading or trailing space,
 * not a dot segment. It becomes a segment of the upload path.
 */
export function itemName(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 255) return null;
  if (value === '.' || value === '..' || value.trim() !== value) return null;
  if (CONTROL.test(value) || /["*:<>?/\\|%#]/.test(value)) return null;
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

/** Whether a stored file of this type is read as text. */
export function isTextType(mimeType: string): boolean {
  return textMimeType(mimeType.split(';')[0]!.trim()) !== null;
}

/** A pre-authenticated download address: https, on a OneDrive or SharePoint host. */
export function downloadUrl(value: unknown): URL | null {
  if (typeof value !== 'string') return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return null;
  const host = url.hostname.toLowerCase();
  return DOWNLOAD_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix)) ? url : null;
}

/** The OData string literal of a search: the text between single quotes, each quote doubled. */
export function odataString(value: string): string {
  return `'${value.split("'").join("''")}'`;
}
