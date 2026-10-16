/**
 * Host-agnostic HTTP handlers of the authorization server (`Request →
 * Response`, never `next`). The Next route files under `src/app/oauth/**`,
 * `src/app/.well-known/**`, `src/app/(app)/delegations/**` and
 * `src/app/admin/(guarded)/oauth-clients/**` are one-line adapters over these.
 *
 *   GET  /.well-known/oauth-authorization-server            RFC 8414 metadata
 *   GET  /.well-known/oauth-protected-resource/mcp/manage   RFC 9728 metadata
 *   GET  /.well-known/oauth-protected-resource   RFC 9728 metadata of the
 *                            execution door (`executionResourceMetadataResponse`)
 *   POST /oauth/register     dynamic client registration (RFC 7591)
 *   GET  /oauth/authorize    authorization request → sign-in → consent screen
 *   POST /oauth/authorize/decision   the user's answer (origin-checked, user session)
 *   POST /oauth/token        code and refresh grants
 *   POST /oauth/revoke       token revocation (RFC 7009)
 *   POST /delegations/:id/revoke      the user ends a delegation
 *   POST /admin/oauth-clients/:id     the operator approves or disables a client
 *
 * Two families, which never mix:
 *
 * - **Protocol endpoints** (`register`, `token`, `revoke`, the metadata) are
 *   called by OAuth clients. They never read a cookie: nothing ambient
 *   authenticates them, only what the request carries (a code, a refresh
 *   token, client credentials). That is why they may answer any origin
 *   (CORS, for browser-based MCP clients) and need no origin check. Each is
 *   rate-limited through the `RateLimiter` port, per client address.
 * - **Human endpoints** (`authorize`, `decide`, `revokeDelegation`,
 *   `decideClient`) act for the web session: every mutation goes through
 *   `guardMutation` (origin, session, role) like the rest of the interface.
 *
 * No token, code or secret is ever logged; a failed request logs the OAuth
 * error code and the client id.
 */
import {
  auditActorId,
  guardMutation,
  OPERATOR_REFUSALS,
  refusalResponse,
  type Authenticator,
  type RefusalWording,
} from '../auth';
import type { RateLimiter } from '../compose/ports';
import type { BuildInfo } from '../config/build-info';
import { documentThemeOf } from '../http/document';
import type { OAuthConfig } from '../config/types';
import type { Logger } from '../logging';
import { EXECUTION_DOOR_PATH } from '../missions';
import {
  type AuthorizationService,
  authorizationResponseUrl,
  type ConsentDecision,
} from './authorization';
import { registrationResponse, type ClientRegistry } from './clients';
import type { DelegationService } from './delegations';
import {
  AUTHORIZE_PATH,
  authorizationServerMetadata,
  CONSENT_DECISION_PATH,
  executionResourceMetadata,
  protectedResourceMetadata,
  type OAuthEndpoints,
} from './endpoints';
import {
  AuthorizationPageError,
  AuthorizationRedirectError,
  OAuthProtocolError,
  slowDown,
  type OAuthErrorCode,
} from './errors';
import {
  CONSENT_FIELD,
  consentPage as renderConsentPage,
  DECISION_FIELD,
  messagePage as renderMessagePage,
  type ConsentView,
} from './pages';
import { redirectDestination } from './redirect-uri';
import { clientCredentialsOf, type TokenService } from './token-service';

/** The page of a person's connected apps ("delegations" in the spec and the store). */
export const DELEGATIONS_PAGE = '/settings/connected-apps';
export const OAUTH_CLIENTS_PAGE = '/admin/oauth-clients';
const LOGIN_ROUTE = '/auth/login';

/** Token and revocation requests per client address and per window. */
export const TOKEN_REQUESTS_PER_WINDOW = 60;
/**
 * Token requests per **confidential** client, whatever the address, counted
 * once its secret matched. A public client proves nothing by naming itself
 * (its `client_id` is public): its renewals are counted per delegation
 * instead, once its refresh token is recognised (`RENEWALS_PER_DELEGATION`).
 */
export const TOKEN_REQUESTS_PER_CLIENT = 120;
export const TOKEN_WINDOW_MS = 60_000;
/** Registrations per client address and per window. */
export const REGISTRATIONS_PER_WINDOW = 20;
export const REGISTRATION_WINDOW_MS = 10 * 60_000;
/** Registrations the whole instance accepts per window, whatever the address. */
export const REGISTRATIONS_PER_INSTANCE = 300;
export const REGISTRATION_INSTANCE_WINDOW_MS = 3_600_000;
/** A token, revocation or registration request is never larger than this. */
export const MAX_REQUEST_BYTES = 16 * 1024;

const SEE_OTHER = 303;
const FORM_TYPE = 'application/x-www-form-urlencoded';
const JSON_TYPE = 'application/json';
/** Parameters a token or revocation request may carry once (RFC 6749 §3.2). */
const SINGLE_VALUED = [
  'grant_type',
  'code',
  'code_verifier',
  'redirect_uri',
  'refresh_token',
  'client_id',
  'client_secret',
  'scope',
  'token',
  'token_type_hint',
];

const NO_STORE = { 'Cache-Control': 'no-store', Pragma: 'no-cache' } as const;
const CORS = { 'Access-Control-Allow-Origin': '*' } as const;

/** The JSON refusals of the two user mutations. */
const USER_REFUSALS: RefusalWording = {
  field: 'message',
  noSession: 'Sign in first.',
  forbidden: 'A connected app belongs to a person: sign in through the identity provider.',
};

export interface OAuthHandlerDeps {
  readonly publicUrl: URL;
  readonly config: OAuthConfig;
  readonly endpoints: OAuthEndpoints;
  readonly authenticator: Authenticator;
  readonly rateLimiter: RateLimiter;
  /** The address the rate limits are keyed on (`clientIpResolver(config.trustedProxies)`). */
  readonly clientIp: (headers: Headers) => string;
  readonly clients: ClientRegistry;
  readonly authorization: AuthorizationService;
  readonly tokens: TokenService;
  readonly delegations: DelegationService;
  readonly logger: Logger;
  /** The running build, shown in the footer of the pages rendered here. */
  readonly build?: BuildInfo;
}

export interface OAuthHandlers {
  /** `GET /.well-known/oauth-authorization-server`. */
  authorizationServerMetadata(request: Request): Promise<Response>;
  /** `GET /.well-known/oauth-protected-resource/mcp/manage`. */
  protectedResourceMetadata(request: Request): Promise<Response>;
  /** `POST /oauth/register`. */
  register(request: Request): Promise<Response>;
  /** `GET /oauth/authorize`. */
  authorize(request: Request): Promise<Response>;
  /** `POST /oauth/authorize/decision` — the consent form. */
  decide(request: Request): Promise<Response>;
  /** `POST /oauth/token`. */
  token(request: Request): Promise<Response>;
  /** `POST /oauth/revoke`. */
  revoke(request: Request): Promise<Response>;
  /** `POST /delegations/:id/revoke`. */
  revokeDelegation(request: Request, delegationId: string): Promise<Response>;
  /** `POST /admin/oauth-clients/:id`. */
  decideClient(request: Request, clientId: string): Promise<Response>;
}

class TooLarge extends Error {}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': JSON_TYPE, ...NO_STORE, ...headers },
  });
}

function oauthError(
  code: OAuthErrorCode,
  description: string,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return json(status, { error: code, error_description: description }, { ...CORS, ...headers });
}

/** A redirect that carries nothing of the page it leaves. */
function seeOther(location: string): Response {
  return new Response(null, {
    status: SEE_OTHER,
    headers: { Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
  });
}

/**
 * The request headers a browser-based client may send to a protocol endpoint: a fixed
 * list, never an echo of what the preflight asked for (security review 2026-10-15,
 * external M2).
 */
export const CORS_ALLOWED_HEADERS = 'authorization, content-type, mcp-protocol-version';

/** The answer to a CORS preflight of a protocol endpoint. */
function preflight(methods: string): Response {
  return new Response(null, {
    status: 204,
    headers: {
      ...CORS,
      'Access-Control-Allow-Methods': methods,
      'Access-Control-Allow-Headers': CORS_ALLOWED_HEADERS,
      'Access-Control-Max-Age': '600',
    },
  });
}

function methodNotAllowed(allow: string): Response {
  return oauthError('invalid_request', `this endpoint answers ${allow}`, 405, { Allow: allow });
}

/** The body as text, read no further than `MAX_REQUEST_BYTES`. */
async function readBounded(request: Request): Promise<string> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) throw new TooLarge();
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_REQUEST_BYTES) {
      await reader.cancel();
      throw new TooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function hasType(request: Request, type: string): boolean {
  return (request.headers.get('content-type') ?? '').toLowerCase().startsWith(type);
}

/** The form of a token or revocation request; a repeated parameter is a malformed request. */
async function readOAuthForm(request: Request): Promise<URLSearchParams> {
  if (!hasType(request, FORM_TYPE)) {
    throw new OAuthProtocolError('invalid_request', `the body must be ${FORM_TYPE}`);
  }
  const form = new URLSearchParams(await readBounded(request));
  for (const name of SINGLE_VALUED) {
    if (form.getAll(name).length > 1) {
      throw new OAuthProtocolError('invalid_request', `${name} was sent more than once`);
    }
  }
  return form;
}

/** A discovery document: `GET`/`HEAD` from any origin, never cached; `OPTIONS` is the preflight. */
function metadata(request: Request, document: Record<string, unknown>): Response {
  if (request.method === 'OPTIONS') return preflight('GET, HEAD, OPTIONS');
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return methodNotAllowed('GET, HEAD, OPTIONS');
  }
  const response = json(200, document, { ...CORS, 'Cache-Control': 'no-store' });
  return request.method === 'HEAD'
    ? new Response(null, { status: 200, headers: response.headers })
    : response;
}

/**
 * `GET /.well-known/oauth-protected-resource` — the execution door's RFC 9728
 * document, served like the other two discovery documents (same methods, same
 * CORS). It reads nothing of the request but its method.
 */
export function executionResourceMetadataResponse(
  endpoints: OAuthEndpoints,
  request: Request,
): Response {
  return metadata(request, executionResourceMetadata(endpoints, EXECUTION_DOOR_PATH));
}

export function createOAuthHandlers(deps: OAuthHandlerDeps): OAuthHandlers {
  const { endpoints, logger } = deps;
  // Every page of the authorization endpoint carries the build footer and is drawn in
  // the theme the person chose in the application (the cookie of the request).
  function pagesFor(request: Request) {
    const look = { build: deps.build, theme: documentThemeOf(request.headers) };
    return {
      messagePage: (status: number, title: string, message: string): Response =>
        renderMessagePage(status, title, message, look),
      consentPage: (view: ConsentView): Response => renderConsentPage({ ...view, ...look }),
    };
  }
  type MessagePage = ReturnType<typeof pagesFor>['messagePage'];

  /** `null` when the request may go on, else the 429 that stops it. */
  async function limited(key: string, limit: number, windowMs: number): Promise<Response | null> {
    const taken = await deps.rateLimiter.take(key, limit, windowMs);
    return taken.allowed ? null : refusal(slowDown(taken.retryAfterMs), false);
  }

  /** The JSON response of a protocol error, with the header its code calls for. */
  function refusal(err: OAuthProtocolError, basic: boolean): Response {
    return oauthError(err.code, err.message, err.status, {
      ...(err.code === 'invalid_client' && basic
        ? { 'WWW-Authenticate': 'Basic realm="oauth"' }
        : {}),
      ...(err.retryAfterSeconds === null ? {} : { 'Retry-After': String(err.retryAfterSeconds) }),
    });
  }

  /** The response of a failed protocol request; anything unexpected is a logged 500. */
  function failed(
    endpoint: string,
    err: unknown,
    clientId: string | null,
    basic = false,
  ): Response {
    if (err instanceof TooLarge) {
      return oauthError('invalid_request', 'the request body is too large', 413);
    }
    if (err instanceof OAuthProtocolError) {
      logger.warn('oauth request refused', { endpoint, error: err.code, client_id: clientId });
      return refusal(err, basic);
    }
    logger.error('oauth request failed unexpectedly', { endpoint, client_id: clientId, err });
    return oauthError('server_error', 'the request could not be processed', 500);
  }

  function bootstrapCannotDelegate(messagePage: MessagePage): Response {
    return messagePage(
      403,
      'Sign in as yourself',
      'An application is connected by a person of this gateway. Whoever installs the gateway with the install token configures it and owns no mission: sign out, then sign in through the identity provider.',
    );
  }

  function signIn(request: Request): Response {
    const returnTo = `${AUTHORIZE_PATH}${new URL(request.url).search}`;
    return seeOther(`${LOGIN_ROUTE}?return_to=${encodeURIComponent(returnTo)}`);
  }

  return {
    async authorizationServerMetadata(request) {
      return metadata(
        request,
        authorizationServerMetadata(endpoints, {
          policy: deps.config.clientRegistration.policy,
          metadataDocuments: deps.config.clientRegistration.metadataDocuments,
        }),
      );
    },

    async protectedResourceMetadata(request) {
      return metadata(request, protectedResourceMetadata(endpoints));
    },

    async register(request) {
      if (request.method === 'OPTIONS') return preflight('POST, OPTIONS');
      if (request.method !== 'POST') return methodNotAllowed('POST, OPTIONS');
      const stopped =
        (await limited(
          `oauth:register:ip:${deps.clientIp(request.headers)}`,
          REGISTRATIONS_PER_WINDOW,
          REGISTRATION_WINDOW_MS,
        )) ??
        (await limited(
          'oauth:register',
          REGISTRATIONS_PER_INSTANCE,
          REGISTRATION_INSTANCE_WINDOW_MS,
        ));
      if (stopped) return stopped;
      try {
        if (!hasType(request, JSON_TYPE)) {
          throw new OAuthProtocolError('invalid_client_metadata', `the body must be ${JSON_TYPE}`);
        }
        let body: unknown;
        try {
          body = JSON.parse(await readBounded(request)) as unknown;
        } catch (err) {
          if (err instanceof TooLarge) throw err;
          throw new OAuthProtocolError('invalid_client_metadata', 'the body is not valid JSON');
        }
        const registered = await deps.clients.register(body);
        return json(201, registrationResponse(registered), CORS);
      } catch (err) {
        return failed('register', err, null);
      }
    },

    async authorize(request) {
      const { messagePage, consentPage } = pagesFor(request);
      if (request.method !== 'GET') return messagePage(405, 'Method not allowed', 'Use GET.');
      const params = new URL(request.url).searchParams;
      const principal = await deps.authenticator.authenticate(request.headers);
      const user = principal?.kind === 'user' ? principal.user : null;
      try {
        // A metadata document is only ever fetched for a signed-in user.
        if (deps.authorization.needsDocument(params) && !user) {
          return principal ? bootstrapCannotDelegate(messagePage) : signIn(request);
        }
        const { view, redirectUri } = await deps.authorization.resolveClient(
          params,
          user?.id ?? null,
        );
        // Nothing is sent to the redirect URI — not even an error — before a user
        // is signed in and the client is one that may ask: a client anybody
        // registered a minute ago must not turn this endpoint into a redirector
        // (RFC 9700 §4.11.2).
        if (!principal) return signIn(request);
        if (!user) return bootstrapCannotDelegate(messagePage);
        if (view.status === 'disabled') {
          return messagePage(
            403,
            'Application disabled',
            `An administrator of this gateway disabled the application "${view.client.name}". It cannot be connected.`,
          );
        }
        if (view.status === 'pending') {
          return messagePage(
            403,
            'Waiting for an administrator',
            `The application "${view.client.name}" is known to this gateway but no administrator approved it yet. Ask an administrator to approve it under Settings, Registered apps (client id ${view.client.clientId}), then start the connection again from the application.`,
          );
        }
        let accepted;
        try {
          accepted = deps.authorization.validate(view.client, redirectUri, params);
        } catch (err) {
          if (!(err instanceof AuthorizationRedirectError)) throw err;
          logger.warn('authorization request refused', {
            error: err.code,
            client_id: view.client.clientId,
          });
          return seeOther(
            authorizationResponseUrl(
              redirectUri,
              endpoints.issuer,
              err.echoState ? params.get('state') : null,
              { error: err.code, error_description: err.message },
            ),
          );
        }
        const destination = redirectDestination(redirectUri);
        if (!destination)
          throw new Error('authorize: an accepted redirect URI is not classifiable');
        return consentPage({
          consentId: await deps.authorization.createPending(user, accepted),
          userEmail: user.email,
          client: view.client,
          destination,
          action: CONSENT_DECISION_PATH,
        });
      } catch (err) {
        if (err instanceof AuthorizationPageError) {
          logger.warn('authorization request refused', { reason: err.title });
          return messagePage(err.status, err.title, err.message);
        }
        logger.error('authorization request failed unexpectedly', { err });
        return messagePage(500, 'Something went wrong', 'The request could not be processed.');
      }
    },

    async decide(request) {
      const { messagePage } = pagesFor(request);
      const guard = await guardMutation(request, deps, 'user');
      if (!guard.ok) return refusalResponse(guard, USER_REFUSALS);
      let form: FormData;
      try {
        form = await request.formData();
      } catch {
        return messagePage(400, 'Invalid request', 'The answer to a consent is a form.');
      }
      const consentId = form.get(CONSENT_FIELD);
      const decision = form.get(DECISION_FIELD);
      if (typeof consentId !== 'string' || (decision !== 'approve' && decision !== 'deny')) {
        return messagePage(400, 'Invalid request', 'This is not an answer to a consent screen.');
      }
      let outcome;
      try {
        outcome = await deps.authorization.decide(
          guard.principal.user,
          consentId,
          decision satisfies ConsentDecision,
        );
      } catch (err) {
        // The user is on a consent screen: they read a page, and nothing was granted.
        logger.error('consent decision failed unexpectedly', { err });
        return messagePage(
          500,
          'Something went wrong',
          'The connection of the application could not be recorded. Nothing was granted: start the connection again from your application.',
        );
      }
      switch (outcome.outcome) {
        case 'redirect':
          return seeOther(outcome.location);
        case 'expired':
          return messagePage(
            400,
            'This request expired',
            'The consent screen was answered already, or it waited too long. Start the connection again from your application.',
          );
        case 'client-unavailable':
          return messagePage(
            403,
            'Application unavailable',
            'The application can no longer be connected on this gateway. Nothing was granted.',
          );
      }
    },

    async token(request) {
      if (request.method === 'OPTIONS') return preflight('POST, OPTIONS');
      if (request.method !== 'POST') return methodNotAllowed('POST, OPTIONS');
      const stopped = await limited(
        `oauth:token:ip:${deps.clientIp(request.headers)}`,
        TOKEN_REQUESTS_PER_WINDOW,
        TOKEN_WINDOW_MS,
      );
      if (stopped) return stopped;
      let clientId: string | null = null;
      let basic = false;
      try {
        const form = await readOAuthForm(request);
        const credentials = clientCredentialsOf(request.headers, form);
        clientId = credentials.clientId;
        basic = credentials.via === 'basic';
        const client = await deps.tokens.authenticateClient(credentials);
        // Only a caller that proved it is the client spends the client's budget:
        // here, one whose secret matched. Keyed on the stored client, never on a
        // string the caller chose. A public client is limited per delegation, in
        // the grant, once its refresh token is recognised.
        if (client.clientSecretHash !== null) {
          const perClient = await limited(
            `oauth:token:client:${client.id}`,
            TOKEN_REQUESTS_PER_CLIENT,
            TOKEN_WINDOW_MS,
          );
          if (perClient) return perClient;
        }
        const grant = form.get('grant_type');
        if (grant === 'authorization_code') {
          return json(200, await deps.tokens.exchangeCode(client, form), CORS);
        }
        if (grant === 'refresh_token') {
          return json(200, await deps.tokens.refresh(client, form), CORS);
        }
        throw new OAuthProtocolError(
          grant ? 'unsupported_grant_type' : 'invalid_request',
          grant
            ? 'grant_type must be authorization_code or refresh_token'
            : 'grant_type is required',
        );
      } catch (err) {
        return failed('token', err, clientId, basic);
      }
    },

    async revoke(request) {
      if (request.method === 'OPTIONS') return preflight('POST, OPTIONS');
      if (request.method !== 'POST') return methodNotAllowed('POST, OPTIONS');
      const stopped = await limited(
        `oauth:token:ip:${deps.clientIp(request.headers)}`,
        TOKEN_REQUESTS_PER_WINDOW,
        TOKEN_WINDOW_MS,
      );
      if (stopped) return stopped;
      let clientId: string | null = null;
      let basic = false;
      try {
        const form = await readOAuthForm(request);
        const credentials = clientCredentialsOf(request.headers, form);
        clientId = credentials.clientId;
        basic = credentials.via === 'basic';
        const client = await deps.tokens.authenticateClient(credentials);
        await deps.tokens.revoke(client, form);
        // RFC 7009 §2.2: 200 whether or not the token existed.
        return new Response(null, { status: 200, headers: { ...NO_STORE, ...CORS } });
      } catch (err) {
        return failed('revoke', err, clientId, basic);
      }
    },

    async revokeDelegation(request, delegationId) {
      const guard = await guardMutation(request, deps, 'user');
      if (!guard.ok) return refusalResponse(guard, USER_REFUSALS);
      const result = await deps.delegations.revoke(guard.principal.user, delegationId);
      return seeOther(
        result.outcome === 'not-found'
          ? `${DELEGATIONS_PAGE}?problem=not-found`
          : `${DELEGATIONS_PAGE}?revoked=1`,
      );
    },

    async decideClient(request, clientId) {
      const guard = await guardMutation(request, deps, 'operator');
      if (!guard.ok) return refusalResponse(guard, OPERATOR_REFUSALS);
      let action: FormDataEntryValue | null;
      try {
        action = (await request.formData()).get('action');
      } catch {
        action = null;
      }
      if (action !== 'approve' && action !== 'disable') {
        return json(400, { error: 'invalid-request', reason: 'action must be approve or disable' });
      }
      const decided = await deps.clients.decide(
        auditActorId(guard.principal),
        clientId,
        action === 'approve' ? 'approved' : 'disabled',
      );
      return seeOther(
        decided
          ? `${OAUTH_CLIENTS_PAGE}?decided=${action === 'approve' ? 'approved' : 'disabled'}`
          : `${OAUTH_CLIENTS_PAGE}?problem=not-found`,
      );
    },
  };
}
