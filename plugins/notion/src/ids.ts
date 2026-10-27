/**
 * Identifier grammars of the `notion` provider, shared by `classify` and
 * `execute` (ADR plugin-identifiers-one-grammar-for-classify-and-execute).
 *
 * Handbook : docs/handbook/providers/notion.md.
 *
 * A value outside its grammar is refused, never repaired. Reading the two
 * spellings Notion documents for one id (with or without dashes, "you may
 * omit dashes from the ID when making requests") into one canonical form is
 * reading the grammar : a slice, a resource ref and an ancestry comparison
 * must see one spelling. The canonical form — 36 characters, lower-case hex
 * and dashes — is a single safe URL path segment and a valid slice
 * identifier.
 */

import type { Resource } from '@vaubaan/plugin-sdk';

import { PROVIDER_ID } from './identity.ts';

const DASHED = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const UNDASHED = /^[0-9a-fA-F]{32}$/;

/** A Notion id in canonical form (lower case, dashed), or `null`. */
export function notionId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (DASHED.test(value)) return value.toLowerCase();
  if (!UNDASHED.test(value)) return null;
  const hex = value.toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The refusal of an id outside the grammar ; a Notion page URL gets a hint. */
export function malformedId(argument: string, value: unknown): string {
  const hint =
    typeof value === 'string' && /notion\.(so|site|com)/i.test(value)
      ? ' (a page URL is not an id: pass the 32 hexadecimal characters at its end)'
      : '';
  return `${argument}: malformed Notion id${hint}`;
}

/**
 * A pagination cursor : opaque for Notion (typed as a UUID string on search
 * and block children). The grammar is wider than a UUID and carries no
 * separator ; it only ever travels in a query string or a JSON body.
 */
const CURSOR = /^[A-Za-z0-9-]{1,128}$/;

export function cursor(value: unknown): string | null {
  return typeof value === 'string' && CURSOR.test(value) ? value : null;
}

/** Longest URL or text value Notion accepts in one field (request limits page). */
export const MAX_TEXT_LENGTH = 2000;

/** An integer within `[min, max]`, or `null`. */
export function boundedInt(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value
    : null;
}

/** What discovery records on a root : a page or a database. */
export type RootKind = 'page' | 'database';

export interface ResolvedRoot {
  readonly ref: string;
  readonly kind: RootKind | null;
}

/**
 * The root a call is on, for `classify` and `execute` alike :
 *   - `args.root` given : a well-formed id AND one of the mission's Notion
 *     resources — anything else is refused, never substituted ;
 *   - absent : the mission's single Notion resource, or a refusal when it
 *     holds none or several.
 * The classifier never infers the root from a page or block id.
 */
export function resolveRoot(
  args: Readonly<Record<string, unknown>>,
  resources: readonly Resource[],
): ResolvedRoot | { readonly denied: string } {
  const own = resources.filter((r) => r.provider === PROVIDER_ID);
  if (args.root !== undefined) {
    const explicit = notionId(args.root);
    if (!explicit) return { denied: malformedId('root', args.root) };
    const found = own.find((r) => notionId(r.ref) === explicit);
    return found
      ? { ref: explicit, kind: rootKindOf(found) }
      : { denied: `root '${explicit}' is not selected in this mission` };
  }
  if (own.length === 1) {
    const only = notionId(own[0]!.ref);
    return only
      ? { ref: only, kind: rootKindOf(own[0]!) }
      : { denied: 'root: the mission resource is not a Notion id' };
  }
  return {
    denied:
      own.length === 0
        ? 'root: argument missing and the mission selects no Notion root'
        : `root: argument missing and the mission selects ${own.length} Notion roots — name one`,
  };
}

function rootKindOf(resource: Resource): RootKind | null {
  const kind = resource.metadata?.kind;
  return kind === 'page' || kind === 'database' ? kind : null;
}
