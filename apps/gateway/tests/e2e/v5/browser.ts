/**
 * How a Playwright browser reaches the ephemeral instance.
 *
 * The instance's `public_url` is always https (cookies are `Secure`, the
 * origin check compares with it), while the launcher listens on plain http on
 * 127.0.0.1. Rather than terminating TLS in a test, the browser context routes
 * every request for the public origin to the local listener and hands the
 * response back unchanged: the page lives on `https://gateway.e2e.test`, with
 * real cookies and a real `Origin` header, exactly as behind a TLS
 * terminator. The simulated IdP's consent screen is answered the same way.
 */
import type { APIRequestContext, BrowserContext, Route } from '@playwright/test';

import { CONTROL_PREFIX, E2E_USER, IDP_ISSUER, localOrigin, PUBLIC_URL } from './instance';

/** Headers that describe the browser's connection, not the request. */
const HOP_HEADERS = new Set(['host', 'connection', 'content-length', 'accept-encoding']);

async function forwardedHeaders(route: Route): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(await route.request().allHeaders())) {
    if (name.startsWith(':') || HOP_HEADERS.has(name)) continue;
    headers[name] = value;
  }
  return headers;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/**
 * Playwright does not run route handlers for the hops of a redirect it was
 * handed, so a 3xx answered to a navigation would leave the browser alone
 * with a host that does not resolve. A navigation redirect is therefore
 * answered as a page that navigates (keeping its `Set-Cookie` headers), and
 * the next URL is a fresh, routed navigation.
 */
async function fulfillRedirect(route: Route, location: string, setCookies: string[]) {
  const target = new URL(location, route.request().url()).href;
  await route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    headers: setCookies.length > 0 ? { 'set-cookie': setCookies.join('\n') } : {},
    body: `<!doctype html><meta http-equiv="refresh" content="0;url=${escapeAttribute(target)}">`,
  });
}

/**
 * A request still in flight when its test ends (a link prefetch, typically)
 * fails with "Target page, context or browser has been closed". Nobody waits
 * for that answer; anything else is a real failure and is rethrown.
 */
function ignoreClosedTarget(err: unknown): void {
  if (err instanceof Error && /has been closed/.test(err.message)) return;
  throw err;
}

async function forwardToInstance(route: Route): Promise<void> {
  const request = route.request();
  const url = new URL(request.url());
  const navigation = request.isNavigationRequest();
  const response = await route.fetch({
    url: `${localOrigin()}${url.pathname}${url.search}`,
    headers: await forwardedHeaders(route),
    // A navigation's redirects are the browser's to follow: they carry the session cookies.
    maxRedirects: navigation ? 0 : undefined,
  });
  const location = response.headers().location;
  if (navigation && response.status() >= 300 && response.status() < 400 && location) {
    const setCookies = response
      .headersArray()
      .filter((h) => h.name.toLowerCase() === 'set-cookie')
      .map((h) => h.value);
    await fulfillRedirect(route, location, setCookies);
    return;
  }
  await route.fulfill({ response });
}

export async function routeToInstance(context: BrowserContext): Promise<void> {
  await context.route(`${PUBLIC_URL}/**`, (route) =>
    forwardToInstance(route).catch(ignoreClosedTarget),
  );

  await context.route(`${IDP_ISSUER}/authorize**`, async (route) => {
    const url = new URL(route.request().url());
    const consent = await route.fetch({
      url: `${localOrigin()}${CONTROL_PREFIX}/idp/authorize${url.search}`,
    });
    const { callback } = (await consent.json()) as { callback: string };
    await fulfillRedirect(route, callback, []);
  });
}

export interface TokenCheck {
  readonly outcome: 'verified' | 'retired' | 'unknown';
  readonly reason: 'rotated' | 'revoked' | null;
  readonly mission_status: string | null;
}

/** Asks the instance what `MissionService.verifyToken` says of a bearer. */
export async function checkToken(request: APIRequestContext, token: string): Promise<TokenCheck> {
  const response = await request.post(`${localOrigin()}${CONTROL_PREFIX}/verify-token`, {
    data: { token },
  });
  return (await response.json()) as TokenCheck;
}

/** Chooses who the simulated IdP signs in at the next consent. */
export async function signInAs(
  request: APIRequestContext,
  user: { readonly sub: string; readonly email: string; readonly name: string } = E2E_USER,
): Promise<void> {
  await request.post(`${localOrigin()}${CONTROL_PREFIX}/idp/next-user`, { data: user });
}

export interface ExhaustedMission {
  readonly mission_id: string;
  /** The `budget-exhausted` refusal the executor received. */
  readonly refusal: { readonly code: string; readonly claim_url: string; readonly hint: string };
}

/**
 * The executor's side of "exhaust and claim": issues a mission of the default
 * user with a two-action quota and calls it until the budget refuses.
 */
export async function exhaustMission(
  request: APIRequestContext,
  name: string,
): Promise<ExhaustedMission> {
  const response = await request.post(`${localOrigin()}${CONTROL_PREFIX}/exhaust`, {
    data: { name },
  });
  return (await response.json()) as ExhaustedMission;
}

/** The executor replays its call with the same token. */
export async function replayCall(
  request: APIRequestContext,
  missionId: string,
): Promise<{ outcome: 'allowed' | 'refused'; refusal: { code: string } | null }> {
  const response = await request.post(`${localOrigin()}${CONTROL_PREFIX}/replay`, {
    data: { mission_id: missionId },
  });
  return (await response.json()) as {
    outcome: 'allowed' | 'refused';
    refusal: { code: string } | null;
  };
}
