/**
 * `assertIdentifiersRefused` — the behavioural proof that what a plugin
 * executes is what it classified (ADR
 * plugin-identifiers-one-grammar-for-classify-and-execute).
 *
 * The kit takes the sample calls a plugin already declares for
 * `assertCatalogCoverage`, and for every string argument of every sample it
 * replaces the value by each hostile identifier, then asks the plugin twice :
 * `classify`, and `execute` against a `fetch` that records and answers
 * anything. It holds four rules on what it observes :
 *
 *   1. **Refused by `classify` means nothing sent by `execute`.** The executor
 *      validates by itself ; it never relies on having been classified first.
 *   2. **No request carries a dot segment.** A path segment that decodes to
 *      `.` or `..` names another resource once a URL parser has read it.
 *   3. **No delimiter passes verbatim.** A value holding `?`, `#` or a line
 *      break never appears as it is in a request URL.
 *   4. **An accepted identifier is named exactly.** When the sample's own
 *      value is a whole segment of a request path — that is what makes the
 *      argument an identifier here, found by running the sample, not declared
 *      by hand — the request made for the hostile value has the same shape and
 *      carries that value, encoded, in the same segment. A dot segment cannot
 *      satisfy 2 and 4 together : it has to be refused.
 *
 * What it does not see : an identifier that is not a top-level string
 * argument (a resource ref, connection metadata, a nested field), a request
 * an executor only reaches after a provider answer the catch-all `{}` does not
 * give (pass `routes`), and an upstream that is not HTTP. Each plugin keeps
 * its own identifier tests for those ; this one makes sure none is without a
 * proof that runs its code.
 */

import type { Resource } from '@vaubaan/shared';

import type { ExecuteContext, ProviderPlugin } from '../plugin.ts';
import { PluginAssertionError, type ToolSamples } from './assertions.ts';
import { mockFetch, type MockFetch, type MockRoute } from './mock-fetch.ts';

/**
 * The values the defect lived on : dot segments, plain and encoded, a
 * separator, an encoded separator, a line break, and the delimiters of a
 * query and a fragment.
 */
export const HOSTILE_IDENTIFIERS: readonly string[] = [
  '..',
  '.',
  'a/../b',
  '%2e%2e',
  '..%2f',
  '%2f',
  'x\ny',
  'r1?x=1#y',
];

export interface IdentifierProofOptions {
  /** The execution context of the plugin around the recording `fetch`. */
  readonly context: (fetch: MockFetch, resources: readonly Resource[]) => ExecuteContext;
  /** Resources of the samples that declare none. */
  readonly resources?: readonly Resource[];
  /**
   * Answers tried before the catch-all : what an executor must read before it
   * reaches the request that carries the identifier (a derived token, a
   * lookup).
   */
  readonly routes?: readonly MockRoute[];
  /** Body of the catch-all answer. Default : `{}`. */
  readonly fallbackBody?: unknown;
  /**
   * Arguments left out, tool by tool, each with the reason. For a value the
   * provider defines as free text and the kit would misread.
   */
  readonly exempt?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /**
   * What the executor sends by another road than `ctx.fetch` (an SSH
   * transport) : emptied before each execution and read after it, so that
   * rule 1 holds for an upstream that is not HTTP.
   */
  readonly elsewhere?: {
    reset(): void;
    sent(): readonly { readonly method: string; readonly url: string }[];
  };
  /**
   * A plugin with tools is expected to show at least one identifier in a
   * request path ; otherwise the proof ran on nothing. `{ none: reason }`
   * states that the plugin has none (its upstream is not HTTP, or its
   * identifiers travel in a body) and why.
   */
  readonly pathIdentifiers?: 'required' | { readonly none: string };
}

/** One argument the sample runs showed as a whole segment of a request path. */
export interface PathIdentifier {
  readonly tool: string;
  readonly argument: string;
}

export interface IdentifierProofReport {
  readonly toolsChecked: number;
  /** String arguments that were fed the hostile values. */
  readonly argumentsChecked: number;
  /** Calls made with a hostile value : each went to `classify` and to `execute`. */
  readonly hostileCalls: number;
  /** Hostile calls `classify` refused. */
  readonly refusedByClassify: number;
  /** Hostile calls after which `execute` sent nothing. */
  readonly nothingSent: number;
  readonly pathIdentifiers: readonly PathIdentifier[];
}

interface Observed {
  readonly method: string;
  readonly url: string;
  /** Path segments as written, before any decoding. */
  readonly segments: readonly string[];
}

interface Run {
  readonly plugin: ProviderPlugin;
  readonly options: IdentifierProofOptions;
  readonly findings: string[];
}

const SCHEME_AND_HOST = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i;
const DELIMITERS = /[?#\n\r]/;
/** Longest value or URL quoted whole in a finding. */
const SHOWN_LENGTH = 120;

function segmentsOf(url: string): string[] {
  const path = url.replace(SCHEME_AND_HOST, '').split(/[?#]/, 1)[0] ?? '';
  return path.split('/');
}

function decoded(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function isDotSegment(segment: string): boolean {
  const value = decoded(segment);
  return value === '.' || value === '..';
}

function shown(value: string): string {
  return JSON.stringify(value.length > SHOWN_LENGTH ? `${value.slice(0, SHOWN_LENGTH)}…` : value);
}

/** Runs `execute` against a fresh recording fetch ; what it throws is not the kit's matter. */
async function requestsOf(
  run: Run,
  tool: string,
  args: Readonly<Record<string, unknown>>,
  resources: readonly Resource[],
): Promise<Observed[]> {
  const fetch = mockFetch([
    ...(run.options.routes ?? []),
    { url: () => true, body: run.options.fallbackBody ?? {} },
  ]);
  run.options.elsewhere?.reset();
  try {
    await run.plugin.execute(run.options.context(fetch, resources), tool, args);
  } catch {
    // A provider failure, or a refusal thrown : only what was sent is read.
  }
  return [...fetch.calls, ...(run.options.elsewhere?.sent() ?? [])].map((call) => ({
    method: call.method,
    url: call.url,
    segments: segmentsOf(call.url),
  }));
}

function isDenied(
  run: Run,
  tool: string,
  args: Readonly<Record<string, unknown>>,
  resources: readonly Resource[],
  where: string,
): boolean {
  try {
    return 'denied' in run.plugin.classify(tool, args, resources);
  } catch (err) {
    run.findings.push(
      `${where}: classify threw instead of refusing (${err instanceof Error ? err.message : String(err)})`,
    );
    return true;
  }
}

/** Where the sample's own value is a whole segment : request index → segment indexes. */
function landingOf(base: readonly Observed[], value: string): Map<number, number[]> {
  const landing = new Map<number, number[]>();
  if (value === '') return landing;
  base.forEach((request, i) => {
    const at = request.segments.flatMap((segment, j) => (decoded(segment) === value ? [j] : []));
    if (at.length > 0) landing.set(i, at);
  });
  return landing;
}

function checkRequests(
  run: Run,
  where: string,
  value: string,
  sent: readonly Observed[],
  base: readonly Observed[],
  landing: ReadonlyMap<number, number[]>,
): void {
  for (const request of sent) {
    if (request.segments.some(isDotSegment)) {
      run.findings.push(
        `${where}: a request carries a dot segment (${request.method} ${request.url})`,
      );
    }
    if (DELIMITERS.test(value) && request.url.includes(value)) {
      run.findings.push(
        `${where}: the value reaches a request URL verbatim (${request.method} ${shown(request.url)})`,
      );
    }
  }
  for (const [index, positions] of landing) {
    const request = sent[index];
    const reference = base[index];
    if (!request || !reference) continue;
    const sameShape =
      request.method === reference.method &&
      request.segments.length === reference.segments.length &&
      request.segments.every((segment, j) =>
        positions.includes(j) ? decoded(segment) === value : segment === reference.segments[j],
      );
    if (!sameShape) {
      run.findings.push(
        `${where}: accepted, but the request does not name it exactly (${request.method} ${shown(request.url)} for ${reference.method} ${shown(reference.url)})`,
      );
    }
  }
}

/**
 * Feeds `HOSTILE_IDENTIFIERS` to every string argument of every sample that
 * `classify` accepts, through `classify` and `execute`, and throws a
 * `PluginAssertionError` listing every breach of the four rules above.
 */
export async function assertIdentifiersRefused(
  plugin: ProviderPlugin,
  samples: ToolSamples,
  options: IdentifierProofOptions,
): Promise<IdentifierProofReport> {
  const run: Run = { plugin, options, findings: [] };
  const declared = new Set(plugin.tools.map((tool) => tool.name));
  const pathIdentifiers = new Map<string, PathIdentifier>();
  const tools = new Set<string>();
  const checkedArguments = new Set<string>();
  let hostileCalls = 0;
  let refusedByClassify = 0;
  let nothingSent = 0;

  for (const [tool, calls] of Object.entries(samples)) {
    if (!declared.has(tool)) continue;
    for (const [n, sample] of calls.entries()) {
      if (sample.expectDenied) continue;
      const resources = sample.resources ?? options.resources ?? [];
      if ('denied' in plugin.classify(tool, sample.args, resources)) continue;
      tools.add(tool);
      const base = await requestsOf(run, tool, sample.args, resources);

      for (const [argument, own] of Object.entries(sample.args)) {
        if (typeof own !== 'string') continue;
        if (options.exempt?.[tool]?.[argument] !== undefined) continue;
        checkedArguments.add(`${tool}\u0000${argument}`);
        const landing = landingOf(base, own);
        if (landing.size > 0) pathIdentifiers.set(`${tool}\u0000${argument}`, { tool, argument });

        for (const value of HOSTILE_IDENTIFIERS) {
          const where = `'${tool}' sample #${n + 1}, ${argument} = ${shown(value)}`;
          const args = { ...sample.args, [argument]: value };
          hostileCalls += 1;
          const denied = isDenied(run, tool, args, resources, where);
          const sent = await requestsOf(run, tool, args, resources);
          if (denied) refusedByClassify += 1;
          if (sent.length === 0) nothingSent += 1;
          if (denied && sent.length > 0) {
            const [first] = sent;
            run.findings.push(
              `${where}: classify refuses it, execute sends ${sent.length} request(s) (${first?.method ?? ''} ${shown(first?.url ?? '')})`,
            );
          }
          // Rule 4 is about what was accepted : a refused value that was sent is rule 1's.
          checkRequests(run, where, value, sent, base, denied ? new Map() : landing);
        }
      }
    }
  }

  const expectation = options.pathIdentifiers ?? 'required';
  if (expectation === 'required' && plugin.tools.length > 0 && pathIdentifiers.size === 0) {
    run.findings.push(
      'no argument of any sample is a segment of a request path: the proof ran on nothing. Pass `routes` so that the executions reach their requests, or `pathIdentifiers: { none: reason }`',
    );
  }
  if (expectation !== 'required' && pathIdentifiers.size > 0) {
    const [found] = pathIdentifiers.values();
    run.findings.push(
      `declared without identifier in a request path, but '${found?.tool ?? ''}' carries '${found?.argument ?? ''}' in one`,
    );
  }
  if (run.findings.length > 0) {
    throw new PluginAssertionError(`identifiers of plugin '${plugin.id}'`, run.findings);
  }
  return {
    toolsChecked: tools.size,
    argumentsChecked: checkedArguments.size,
    hostileCalls,
    refusedByClassify,
    nothingSent,
    pathIdentifiers: [...pathIdentifiers.values()],
  };
}
