/**
 * Host-agnostic HTTP handlers of the request surface (`Request → Response`,
 * never `next`). The Next route files under `src/app/r/**` and
 * `src/app/api/requests/**` are one-line adapters over these.
 *
 *   GET  /r/:id                      the URL a refusal carries: gate, then the creator's view
 *   GET  /api/requests               my open requests as creator (the inbox, as JSON)
 *   POST /api/requests/:id/decide    the creator's answer
 *
 * Order of the checks, the same on the three routes (spec §6):
 *
 *   1. per-IP rate limit (`/r/*` only)           → 429
 *   2. a bearer was presented                    → 403 `wrong-credential-kind`
 *      (a mission token opens the execution door only, a delegated token the
 *      management door only; requests are granted in a human session, so an
 *      `Authorization` header is refused whatever it holds, even next to a
 *      valid session cookie)
 *   3. origin check (mutation only)              → 403 `origin-mismatch`
 *   4. a user session                            → sign-in redirect / 401
 *   5. the user is the mission's creator         → 403, with no detail
 */
import {
  guardMutation,
  guardSession,
  refusalResponse,
  type Authenticator,
  type GuardResult,
  type UserPrincipal,
} from '../auth';
import type { RateLimiter } from '../compose/ports';
import { prefixOfBearer } from '../missions/token';
import type { ApprovalProblemCode } from './approval';
import type { ClaimProblemCode } from './claim';
import type { DecideResult, RequestService } from './request-service';
import { inboxRequestPath, requestPath } from './url';

/** Requests per client address and per window on the request surface. */
export const REQUEST_PAGE_RATE_LIMIT = 30;
export const REQUEST_PAGE_RATE_WINDOW_MS = 60_000;

/** The only sentence a non-creator ever reads (spec §3.4). */
export const ADDRESSED_TO_CREATOR = 'This request is addressed to its creator.';

/** The bootstrap operator is nobody's creator: the same sentence as any non-creator. */
const REFUSALS = {
  field: 'message',
  noSession: 'Sign in first.',
  forbidden: ADDRESSED_TO_CREATOR,
} as const;

const LOGIN_ROUTE = '/auth/login';
const MS_PER_SECOND = 1000;

/** Codes the creator's page shows after a refused form post (`?problem=`). */
export type DecideProblemCode =
  | ClaimProblemCode
  | ApprovalProblemCode
  | 'request-not-open'
  | 'unsupported-kind';

export interface RequestHandlerDeps {
  readonly publicUrl: URL;
  readonly authenticator: Authenticator;
  readonly rateLimiter: RateLimiter;
  /** The address the per-IP limit is keyed on (`clientIpResolver(config.trustedProxies)`). */
  readonly clientIp: (headers: Headers) => string;
  readonly service: RequestService;
}

export interface RequestHandlers {
  /** `GET /r/:id`. */
  open(request: Request, requestId: string): Promise<Response>;
  /** `GET /api/requests`. */
  inbox(request: Request): Promise<Response>;
  /** `POST /api/requests/:id/decide` (JSON, or the page's form). */
  decide(request: Request, requestId: string): Promise<Response>;
}

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...NO_STORE, ...headers },
  });
}

function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { Location: location, ...NO_STORE } });
}

/** A self-contained page: the route answers before any application shell exists. */
function page(status: number, title: string, sentence: string, headers = {}): Response {
  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="color-scheme" content="light dark">
<title>${title}</title>
<style>
body { font-family: system-ui, sans-serif; margin: 0; min-height: 100vh; display: grid; place-items: center; }
main { max-width: 32rem; padding: 2rem; text-align: center; line-height: 1.5; }
h1 { font-size: 1.125rem; font-weight: 600; margin: 0 0 0.5rem; }
p { margin: 0; }
</style>
</head>
<body><main><h1>${title}</h1><p>${sentence}</p></main></body>
</html>
`;
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...NO_STORE, ...headers },
  });
}

function forbiddenPage(): Response {
  return page(403, 'Not for you', ADDRESSED_TO_CREATOR);
}

function wantsForm(request: Request): boolean {
  const type = request.headers.get('content-type') ?? '';
  return (
    type.startsWith('application/x-www-form-urlencoded') || type.startsWith('multipart/form-data')
  );
}

/** Form fields as a plain object; fields left blank are absent. */
function fieldsOf(form: FormData): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [name, value] of form.entries()) {
    if (typeof value === 'string' && value.trim() !== '') fields[name] = value.trim();
  }
  return fields;
}

export function createRequestHandlers(deps: RequestHandlerDeps): RequestHandlers {
  /** Step 1, on the forwarded URL only: `null` when the request may go on. */
  async function limited(request: Request): Promise<Response | null> {
    const limit = await deps.rateLimiter.take(
      `request-page:ip:${deps.clientIp(request.headers)}`,
      REQUEST_PAGE_RATE_LIMIT,
      REQUEST_PAGE_RATE_WINDOW_MS,
    );
    if (limit.allowed) return null;
    const retryAfter = String(Math.max(1, Math.ceil(limit.retryAfterMs / MS_PER_SECOND)));
    return page(429, 'Too many requests', `Try again in ${retryAfter} seconds.`, {
      'Retry-After': retryAfter,
    });
  }

  /** Step 2: `null` when no bearer was presented. */
  function bearerRefusal(request: Request): Response | null {
    const authorization = request.headers.get('authorization');
    if (authorization === null) return null;
    const bearer = authorization.replace(/^bearer\s+/i, '');
    return json(403, {
      error: 'wrong-credential-kind',
      presented: prefixOfBearer(bearer) ? 'mission-token' : 'bearer',
      expected: 'human-session',
      message:
        'Requests are read and decided in a human session of the mission creator. A mission token or a delegated token cannot open this surface: give the URL to the human as is.',
    });
  }

  /** Steps 3 and 4 as the JSON routes answer them (`guardMutation` / `guardSession`). */
  function userOr(guard: GuardResult<UserPrincipal>): UserPrincipal | Response {
    return guard.ok ? guard.principal : refusalResponse(guard, REFUSALS);
  }

  function decided(result: DecideResult, requestId: string, form: boolean): Response {
    const back = inboxRequestPath(requestId);
    if (result.ok) {
      return form ? seeOther(`${back}?decided=1`) : json(200, { request: result.request });
    }
    const problem = (code: DecideProblemCode, status: number, body: object): Response =>
      form ? seeOther(`${back}?problem=${code}`) : json(status, { error: code, ...body });
    switch (result.reason) {
      case 'forbidden':
        return form
          ? forbiddenPage()
          : json(403, { error: 'forbidden', message: ADDRESSED_TO_CREATOR });
      case 'not-open':
        return problem('request-not-open', 409, {
          state: result.state,
          message: `The request is already ${result.state}.`,
        });
      case 'unsupported-kind':
        return problem('unsupported-kind', 409, {
          message: `This decision does not apply to a request of kind '${result.kind}'.`,
        });
      case 'invalid':
        return problem(result.problem.code, 422, { message: result.problem.message });
    }
  }

  return {
    async open(request, requestId) {
      const early = (await limited(request)) ?? bearerRefusal(request);
      if (early) return early;
      const guard = await guardSession(request, deps, 'user');
      if (!guard.ok) {
        // The bootstrap operator is nobody's creator.
        if (guard.reason !== 'no-session') return forbiddenPage();
        return seeOther(`${LOGIN_ROUTE}?return_to=${encodeURIComponent(requestPath(requestId))}`);
      }
      const result = await deps.service.view(guard.principal.user, requestId);
      if (result.outcome !== 'ok') return forbiddenPage();
      return seeOther(inboxRequestPath(requestId));
    },

    async inbox(request) {
      const early = bearerRefusal(request);
      if (early) return early;
      const principal = userOr(await guardSession(request, deps, 'user'));
      if (principal instanceof Response) return principal;
      return json(200, { requests: await deps.service.inbox(principal.user) });
    },

    async decide(request, requestId) {
      const early = bearerRefusal(request);
      if (early) return early;
      const principal = userOr(await guardMutation(request, deps, 'user'));
      if (principal instanceof Response) return principal;

      const form = wantsForm(request);
      let raw: unknown;
      try {
        raw = form ? fieldsOf(await request.formData()) : await request.json();
      } catch {
        return json(400, { error: 'invalid-decision', message: 'The body is not a decision.' });
      }
      return decided(await deps.service.decide(principal.user, requestId, raw), requestId, form);
    },
  };
}
