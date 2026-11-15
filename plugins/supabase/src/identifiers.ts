/**
 * The identifier grammars of the `supabase` service — one per kind, shared
 * by `classify.ts` and `execute.ts`.
 *
 * Spec : docs/spec/vaubaan-gateway.md §10 ("a classification error is a security hole").
 * Handbook : docs/handbook/services/supabase.md ; ADR
 *            plugin-identifiers-one-grammar-for-classify-and-execute.
 *
 * Every argument that lands in a URL path, a query string, a host, a header
 * or the SQL text the plugin writes is read with the grammar of its kind :
 * `pathIdent` for opaque ids and slugs, `bucketId` and `objectPath` for the
 * dotted storage names, `emailAddress`, and closed sets or integers for the
 * rest. The classifier's `readIdentifiers(tool, args)` (and `tableSchemas`
 * for `list_tables`) applies them ; `execute.ts` builds its request from the
 * same answer, never from `args`. A value outside its grammar is denied —
 * never escaped, never replaced by another argument : a dot-only segment
 * would otherwise be classified as a function or an object and sent to the
 * parent endpoint, which URL parsers resolve `..` to.
 *
 * Pure : no IO.
 */

type Args = Readonly<Record<string, unknown>>;

/**
 * A project ref becomes a URL path segment **and a host label**
 * (`https://<ref>.supabase.co`), so it is held to the grammar of a host
 * label : lowercase letters, digits and inner hyphens, 63 characters at most.
 * No dot, slash, colon, `@`, `?` or `#` ; no uppercase either, which a URL
 * parser would fold in the host while the path kept it.
 */
const PROJECT_REF = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** The value as a project ref, or `null`. */
export function projectRefIdent(value: unknown): string | null {
  return typeof value === 'string' && PROJECT_REF.test(value) ? value : null;
}

/**
 * An opaque identifier the service issues or constrains (a user, SSO
 * provider or third-party-auth id — UUIDs —, an edge function slug, a closed
 * keyword such as a link type) : one path segment, no dot, no separator, no
 * escape, bounded. It lands in a slice **and** in a request path, so one
 * grammar serves both. A wider class is not safe for a URL :
 * `encodeURIComponent` leaves `.` and `..` untouched and every URL parser
 * then removes them, so `…/functions/..` would be sent as the project
 * endpoint while the slice named a function.
 */
export const PATH_IDENT = /^[A-Za-z0-9_-]{1,64}$/;

/** The value as a path-safe identifier, or `null`. */
export function pathIdent(value: unknown): string | null {
  return typeof value === 'string' && PATH_IDENT.test(value) ? value : null;
}

/** Characters of a name that is legitimately dotted (a bucket id, a segment of an object path). */
const DOTTED_SEGMENT = /^[A-Za-z0-9_.@+:~-]+$/;
const DOT_ONLY = /^\.+$/;

/** One path segment that may hold dots but is not made of dots alone, and holds no separator. */
function isDottedSegment(value: string): boolean {
  return DOTTED_SEGMENT.test(value) && !DOT_ONLY.test(value);
}

const BUCKET_ID_MAX_LENGTH = 100;

/**
 * A bucket id : one dotted segment (`my.bucket-1`), never `.` or `..`, never
 * a separator. `execute` percent-encodes it ; the grammar is what keeps it
 * one segment a URL parser leaves in place.
 */
export function bucketId(value: unknown): string | null {
  return typeof value === 'string' && value.length <= BUCKET_ID_MAX_LENGTH && isDottedSegment(value)
    ? value
    : null;
}

const OBJECT_PATH_MAX_LENGTH = 1024;

/**
 * An object path inside a bucket (`folder/file.v1.png`) : `/`-separated
 * dotted segments, none empty (no leading, trailing or doubled separator)
 * and none made of dots alone, so the path cannot climb out of its bucket.
 */
export function objectPath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > OBJECT_PATH_MAX_LENGTH) return null;
  return value.split('/').every(isDottedSegment) ? value : null;
}

const EMAIL_MAX_LENGTH = 254;
const EMAIL_LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?';
// nosemgrep: detect-redos -- linear: labels are joined by a literal separator the label class excludes (measured: 20 000 chars in < 1 ms)
const EMAIL = new RegExp(`^[A-Za-z0-9_.+~-]+@${EMAIL_LABEL}(?:\\.${EMAIL_LABEL})+$`);

/** An email address : a local part, one `@`, a dotted domain. It travels in a JSON body. */
export function emailAddress(value: unknown): string | null {
  return typeof value === 'string' && value.length <= EMAIL_MAX_LENGTH && EMAIL.test(value)
    ? value
    : null;
}

/**
 * A name that lands in a slice segment and a JSON body only (a function
 * secret) : brackets, whitespace, commas and glob characters are refused
 * rather than escaped, since they would corrupt the slice.
 */
const SLICE_NAME = /^[a-zA-Z0-9_.@+:/~-]{1,256}$/;

export function sliceName(value: unknown): string | null {
  return typeof value === 'string' && SLICE_NAME.test(value) ? value : null;
}

/** The advisor families the Management API serves. */
const ADVISOR_TYPES: ReadonlySet<string> = new Set(['security', 'performance']);
const DEFAULT_ADVISOR_TYPE = 'security';

export function advisorType(value: unknown): string | null {
  if (value === undefined) return DEFAULT_ADVISOR_TYPE;
  return typeof value === 'string' && ADVISOR_TYPES.has(value) ? value : null;
}

const PAGE_NUMBER_MAX = 1_000_000;

/** A page number or page size : a positive integer, as its decimal digits ; `fallback` when absent. */
export function pageNumber(value: unknown, fallback: number): string | null {
  if (value === undefined) return String(fallback);
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= PAGE_NUMBER_MAX
    ? String(value)
    : null;
}

const BASE64_TEXT = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * A base64 payload : the content of an uploaded object, in the standard alphabet,
 * padded or not, possibly empty. A length no encoding produces (one character over a
 * multiple of four) is refused rather than decoded to whatever fits.
 */
export function base64Text(value: unknown): string | null {
  if (typeof value !== 'string' || !BASE64_TEXT.test(value)) return null;
  const symbols = value.replace(/=+$/, '').length;
  return symbols % 4 === 1 ? null : value;
}

const MEDIA_TOKEN = '[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}';
// nosemgrep: detect-redos -- parameters are joined by a literal `;` the token classes exclude, each bounded: linear
const MEDIA_TYPE = new RegExp(
  `^${MEDIA_TOKEN}/${MEDIA_TOKEN}(?:; ?[A-Za-z0-9_-]{1,64}=[A-Za-z0-9_.-]{1,64})*$`,
);
const DEFAULT_MEDIA_TYPE = 'application/octet-stream';

/** A media type (`image/png`, `text/plain; charset=utf-8`) : it becomes a request header. */
export function mediaType(value: unknown): string | null {
  if (value === undefined) return DEFAULT_MEDIA_TYPE;
  return typeof value === 'string' && MEDIA_TYPE.test(value) ? value : null;
}

/** A Postgres schema name as an unquoted identifier : no quote, no backslash, no whitespace. */
const SCHEMA_NAME = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;
const DEFAULT_SCHEMAS: readonly string[] = ['public'];

/**
 * The schemas `list_tables` reads, for `classify` and `execute` alike :
 * `public` when the argument is absent or empty, otherwise an array of
 * schema identifiers. `null` — a denial — for anything else : a name that is
 * not an identifier is refused, never quoted nor dropped, since the names are
 * written into the SQL text the plugin sends.
 */
export function tableSchemas(args: Args): readonly string[] | null {
  const raw = args.schemas;
  if (raw === undefined) return DEFAULT_SCHEMAS;
  if (!Array.isArray(raw)) return null;
  if (raw.length === 0) return DEFAULT_SCHEMAS;
  const names: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string' || !SCHEMA_NAME.test(item)) return null;
    names.push(item);
  }
  return names;
}
