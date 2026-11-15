/**
 * `mockFetch` — a `fetch` double for plugin tests.
 *
 * Spec : docs/spec/vaubaan-gateway.md §10 ("no integration test against a
 * real service, ever"). Plugins receive `fetch` through their context ;
 * tests hand them this one. An unmatched request rejects with an error
 * naming the method and URL, so a test can never reach the network by
 * accident.
 */

/** What `fetch` accepts as its first argument. */
export type FetchInput = Parameters<typeof fetch>[0];

export interface RecordedCall {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  /** Request body as text (`null` when absent). */
  readonly body: string | null;
  /** `body` parsed as JSON when it is JSON, else `undefined`. */
  readonly json: unknown;
}

export interface MockRoute {
  /** HTTP method ; any when omitted. */
  readonly method?: string;
  /** Exact URL, regex, or predicate on the URL. */
  readonly url: string | RegExp | ((url: string) => boolean);
  /** Defaults to 200. */
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  /** Response body : an object is serialized as JSON, a string sent as text. */
  readonly body?: unknown;
  /** Computes the body from the recorded request ; takes precedence over `body`. */
  readonly respond?: (call: RecordedCall) => unknown;
  /** How many times the route may answer ; unlimited when omitted. */
  readonly times?: number;
}

export interface MockFetch {
  (input: FetchInput, init?: RequestInit): Promise<Response>;
  /** Every request received, in order. */
  readonly calls: readonly RecordedCall[];
  /** Routes that still have unused answers (`times` not exhausted) — assert emptiness for strict tests. */
  pending(): readonly MockRoute[];
}

export function mockFetch(routes: readonly MockRoute[]): MockFetch {
  const calls: RecordedCall[] = [];
  const remaining = new Map<MockRoute, number>(
    routes.map((r) => [r, r.times ?? Number.POSITIVE_INFINITY]),
  );

  const fn = async (input: FetchInput, init?: RequestInit): Promise<Response> => {
    const call = await record(input, init);
    calls.push(call);
    for (const route of routes) {
      const left = remaining.get(route) ?? 0;
      if (left <= 0) continue;
      if (route.method && route.method.toUpperCase() !== call.method) continue;
      if (!urlMatches(route.url, call.url)) continue;
      remaining.set(route, left - 1);
      return respond(route, call);
    }
    throw new Error(
      `mockFetch: unexpected ${call.method} ${call.url} — no route matches (routes: ${routes.length})`,
    );
  };

  return Object.assign(fn, {
    calls,
    pending: () => routes.filter((r) => r.times !== undefined && (remaining.get(r) ?? 0) > 0),
  });
}

function urlMatches(matcher: MockRoute['url'], url: string): boolean {
  if (typeof matcher === 'string') return matcher === url;
  if (matcher instanceof RegExp) return matcher.test(url);
  return matcher(url);
}

async function record(input: FetchInput, init?: RequestInit): Promise<RecordedCall> {
  let url: string;
  let method = init?.method ?? 'GET';
  let headers: Record<string, string> = {};
  let body: string | null = null;
  if (input instanceof Request) {
    url = input.url;
    method = init?.method ?? input.method;
    input.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    body = input.body ? await input.clone().text() : null;
  } else {
    url = input instanceof URL ? input.toString() : input;
  }
  if (init?.headers) {
    headers = { ...headers, ...normalizeHeaders(init.headers) };
  }
  if (init?.body !== undefined && init.body !== null) {
    body = typeof init.body === 'string' ? init.body : await new Response(init.body).text();
  }
  let json: unknown = undefined;
  if (body !== null) {
    try {
      json = JSON.parse(body);
    } catch {
      json = undefined;
    }
  }
  return { method: method.toUpperCase(), url, headers, body, json };
}

function normalizeHeaders(h: NonNullable<RequestInit['headers']>): Record<string, string> {
  const out: Record<string, string> = {};
  if (h instanceof Headers) {
    h.forEach((v, k) => {
      out[k.toLowerCase()] = v;
    });
  } else if (Array.isArray(h)) {
    for (const pair of h) {
      const [k, v] = pair;
      if (k !== undefined && v !== undefined) out[k.toLowerCase()] = v;
    }
  } else {
    for (const [k, v] of Object.entries(h as Record<string, string>)) out[k.toLowerCase()] = v;
  }
  return out;
}

function respond(route: MockRoute, call: RecordedCall): Response {
  const raw = route.respond ? route.respond(call) : route.body;
  const headers = new Headers(route.headers ?? {});
  let payload: string | null;
  if (raw === undefined || raw === null) payload = null;
  else if (typeof raw === 'string') payload = raw;
  else {
    payload = JSON.stringify(raw);
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  }
  return new Response(payload, { status: route.status ?? 200, headers });
}
