/**
 * Classifier of the `context7` service : `(tool, args, resources) → slices`.
 *
 * Spec     : docs/spec/gateway-risk-model.md §7 ; docs/spec/vaubaan-gateway.md §10
 *            ("a classification error is a security hole").
 * Handbook : docs/handbook/services/context7.md.
 *
 * Pure : no IO, no credential, no clock. Both tools read : they send the
 * agent's question to Context7 and read documentation back.
 *
 *   context7__resolve-library-id → context7.index[<ref>].library[*].R      (a search of the index)
 *   context7__query-docs         → context7.index[<ref>].library[<id>].R   (one library)
 *
 * `readCall` is the one reader of a call's arguments, used by `classify` and
 * by `execute` : the arguments sent upstream are rebuilt from what it
 * returned, never copied from `args`. The upstream server reads aliases its
 * schema does not declare (`libraryName` for `libraryId` on `query-docs`,
 * `userQuery` for `query`…), so an undeclared argument is refused here and
 * again in `execute` : an alias would carry the library a call reads past
 * the classifier.
 */

import {
  ANY_IDENT,
  declaredArgumentsOf,
  identSegment,
  undeclaredArgumentDenial,
  type ClassifyOutcome,
  type Resource,
  type Slice,
  type SliceSegment,
} from '@vaubaan/plugin-sdk';

import { INDEX_REF, SERVICE_ID, TOOL, UPSTREAM_TOOL } from './identity.ts';
import { context7Tools } from './tools.ts';

/** Context7's own limit on `libraryId`, `query` and the other texts of `GET /v2/context` (REST reference). */
export const MAX_TEXT_LENGTH = 500;

/**
 * A Context7 library id : a leading `/`, then 1 to 4 segments of
 * `[A-Za-z0-9_.~@+-]` (`/vercel/next.js`, `/org/project/v14.3.0`,
 * `/vercel/next.js@v14.3.0`), no dot-only segment, at most 500 characters.
 * No whitespace, control character, `*`, `?`, `#`, `%` or `\` can match. The
 * id travels in the JSON-RPC body, never in a URL ; it is also written into
 * the slice, where a `..` or a glob has no legitimate reading.
 */
const LIBRARY_ID = /^(?:\/[A-Za-z0-9_.~@+-]+){1,4}$/;
const DOT_ONLY_SEGMENT = /\/\.+(?=\/|$)/;

/** The value as a Context7 library id, or `null`. Shared by `classify` and `execute`. */
export function libraryId(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_TEXT_LENGTH) return null;
  // nosemgrep: detect-redos -- each repetition of LIBRARY_ID starts with '/', outside its segment class, so a string splits one way only (linear), and the length is capped at 500 above (pinned by classify.test.ts)
  if (!LIBRARY_ID.test(value) || DOT_ONLY_SEGMENT.test(value)) return null;
  return value;
}

/** A free text of the caller (a question, a product name, a language) : 1 to 500 characters. */
export function freeText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TEXT_LENGTH
    ? value
    : null;
}

export const MALFORMED_LIBRARY_ID = 'libraryId: malformed Context7 library id.';

/** The refusal of a free-text argument that is missing, empty, too long or not a string. */
export function malformedText(argument: string): string {
  return `${argument}: expected a non-empty string of at most ${MAX_TEXT_LENGTH} characters.`;
}

export const NO_CONTEXT7_INDEX = 'no context7 resource in this mission';
export const NOT_A_CONTEXT7_INDEX =
  'context7: the resource of this mission is not a Context7 index.';

/** What `readCall` read : the upstream tool, the arguments to send, the library named. */
export type Context7Call =
  | {
      readonly upstream: typeof UPSTREAM_TOOL.resolveLibraryId;
      readonly arguments: { readonly query: string; readonly libraryName: string };
    }
  | {
      readonly upstream: typeof UPSTREAM_TOOL.queryDocs;
      readonly arguments: {
        readonly libraryId: string;
        readonly query: string;
        readonly language?: string;
      };
    };

const DECLARED_ARGUMENTS = declaredArgumentsOf(context7Tools);

/** The denial of the first argument the tool does not declare ; `null` when there is none. */
export function undeclaredArgument(
  tool: string,
  args: Readonly<Record<string, unknown>>,
): string | null {
  return undeclaredArgumentDenial(DECLARED_ARGUMENTS, tool, args);
}

/**
 * The one reader of a call : the tool, then the closed argument surface,
 * then each argument through its grammar. Every refusal is a sentence the
 * agent can act on.
 */
export function readCall(
  tool: string,
  args: Readonly<Record<string, unknown>>,
): Context7Call | { readonly denied: string } {
  if (tool !== TOOL.resolveLibraryId && tool !== TOOL.queryDocs) {
    return { denied: `unknown tool '${tool}'` };
  }
  const undeclared = undeclaredArgument(tool, args);
  if (undeclared !== null) return { denied: undeclared };

  const query = freeText(args.query);
  if (tool === TOOL.resolveLibraryId) {
    const libraryName = freeText(args.libraryName);
    if (libraryName === null) return { denied: malformedText('libraryName') };
    if (query === null) return { denied: malformedText('query') };
    return { upstream: UPSTREAM_TOOL.resolveLibraryId, arguments: { query, libraryName } };
  }

  const id = libraryId(args.libraryId);
  if (id === null) return { denied: MALFORMED_LIBRARY_ID };
  if (query === null) return { denied: malformedText('query') };
  if (args.language === undefined) {
    return { upstream: UPSTREAM_TOOL.queryDocs, arguments: { libraryId: id, query } };
  }
  const language = freeText(args.language);
  if (language === null) return { denied: malformedText('language') };
  return { upstream: UPSTREAM_TOOL.queryDocs, arguments: { libraryId: id, query, language } };
}

/**
 * The index a call reads : the mission's single Context7 resource. The
 * tools take no resource argument (the upstream schemas have none) ; a
 * mission holds at most one Context7 account, and an account has one
 * resource, so several are refused as ambiguous all the same.
 */
export function resolveIndex(
  resources: readonly Resource[],
): { readonly ref: string } | { readonly denied: string } {
  const own = resources.filter((r) => r.service === SERVICE_ID);
  if (own.length === 0) return { denied: NO_CONTEXT7_INDEX };
  if (own.length > 1) {
    return { denied: `the mission holds ${own.length} Context7 resources — one is expected` };
  }
  return own[0]!.ref === INDEX_REF ? { ref: INDEX_REF } : { denied: NOT_A_CONTEXT7_INDEX };
}

export function classifyContext7(
  tool: string,
  args: Readonly<Record<string, unknown>>,
  resources: readonly Resource[],
): ClassifyOutcome {
  const call = readCall(tool, args);
  if ('denied' in call) return call;
  const index = resolveIndex(resources);
  if ('denied' in index) return index;
  // A search reads every library of the index, whatever `libraryName` says
  // (a product name, free text, never put in a slice). A library id the
  // slice grammar cannot carry (`@` of a version) is classified as any.
  const library =
    call.upstream === UPSTREAM_TOOL.queryDocs ? identSegment(call.arguments.libraryId) : ANY_IDENT;
  return { slices: [readSlice(index.ref, library)] };
}

function readSlice(ref: string, library: SliceSegment): Slice {
  return {
    service: SERVICE_ID,
    path: [
      { kind: 'name', value: 'index' },
      { kind: 'ident', value: ref },
      { kind: 'name', value: 'library' },
      library,
    ],
    action: 'R',
  };
}
