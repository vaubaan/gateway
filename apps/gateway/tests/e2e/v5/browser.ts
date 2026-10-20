/**
 * How a Playwright browser reaches the ephemeral instance.
 *
 * The instance's `public_url` is always https (cookies are `Secure`, the
 * origin check compares with it), while the launcher listens on plain http on
 * 127.0.0.1. Rather than terminating TLS in a test, the browser context routes
 * every request for the public origin to the local listener and hands the
 * response back unchanged: the page lives on `https://gateway.e2e.test`, with
 * real cookies and a real `Origin` header, exactly as behind a TLS
 * terminator. The pages a browser is sent to outside the instance — the
 * simulated IdP's consent screen, the pages of a mocked provider —
 * are answered by the launcher's control endpoints: the "user" consents and
 * the browser is sent back with what the real page would hand over.
 */
import { base32Decode, totpCode, totpStepOf } from '../../../src/server/crypto/totp';
import type { APIRequestContext, BrowserContext, Page, Route } from '@playwright/test';

import { controlUrl, GITHUB_SIGN_IN_BASE, IDP_ISSUER, localOrigin, PUBLIC_URL } from './instance';

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
 * fails with "Target page, context or browser has been closed" or, when the
 * answer arrived just as the page went away, "Fetch response has been
 * disposed". Nobody waits for that answer; anything else is a real failure
 * and is rethrown.
 */
function ignoreClosedTarget(err: unknown): void {
  // "Test ended" is the same situation seen from the route: a prefetch still in flight when
  // the test returns. Nothing was asserted on that request.
  if (err instanceof Error && /has been (closed|disposed)|Test ended/.test(err.message)) return;
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
      url: `${controlUrl('/idp/authorize')}${url.search}`,
    });
    const { callback } = (await consent.json()) as { callback: string };
    await fulfillRedirect(route, callback, []);
  });

  // The consent page of the simulated GitHub sign-in (the sign-in spec only).
  await context.route(`${GITHUB_SIGN_IN_BASE}/login/oauth/authorize**`, async (route) => {
    const url = new URL(route.request().url());
    const consent = await route.fetch({
      url: `${controlUrl('/github/authorize')}${url.search}`,
    });
    const { callback } = (await consent.json()) as { callback: string };
    await fulfillRedirect(route, callback, []);
  });

  // The provider pages of the connect flows (which ones is the launcher's to say).
  const listed = await context.request.get(controlUrl('/provider-pages'));
  const { pages } = (await listed.json()) as { pages: string[] };
  for (const page of pages) {
    await context.route(`${page}**`, async (route) => {
      const visited = encodeURIComponent(route.request().url());
      const step = await route.fetch({
        url: `${controlUrl('/provider-page')}?url=${visited}`,
      });
      const { callback } = (await step.json()) as { callback: string };
      await fulfillRedirect(route, callback, []);
    });
  }
}

export interface TokenCheck {
  readonly outcome: 'verified' | 'retired' | 'unknown';
  readonly reason: 'rotated' | 'revoked' | null;
  readonly mission_status: string | null;
}

/** Asks the instance what `MissionService.verifyToken` says of a bearer. */
export async function checkToken(request: APIRequestContext, token: string): Promise<TokenCheck> {
  const response = await request.post(controlUrl('/verify-token'), {
    data: { token },
  });
  if (!response.ok()) throw new Error(`verify-token answered ${response.status()}`);
  return (await response.json()) as TokenCheck;
}

/**
 * Chooses who the simulated IdP signs in at the next consent. There is no
 * default user: every spec calls this in its `beforeEach` (and again when a
 * scenario changes hands).
 */
/**
 * The gateway's own second factor at the end of a sign-in (ADR
 * administrators-live-in-the-instance §7), answered as the person's authenticator app
 * would: the enrolment with the secret the page shows (then "continue" past the
 * recovery codes), or the code of the factor enrolled earlier. Nothing when the
 * sign-in asked none.
 */
export async function passSecondFactor(
  page: Page,
  request: APIRequestContext,
  email: string,
): Promise<void> {
  // The sign-in hops through the provider and the callback: wait for the page it lands on.
  const gateway = new URL(PUBLIC_URL).host;
  await page.waitForURL((url) => url.host === gateway && !url.pathname.startsWith('/auth/'));
  await page.waitForLoadState();
  const path = new URL(page.url()).pathname;
  if (path === '/login/second-factor') {
    const shown = (await page.getByTestId('totp-secret').locator('code').innerText()).replace(
      /\s/g,
      '',
    );
    const bytes = base32Decode(shown);
    if (!bytes) throw new Error(`not a base32 secret: ${shown}`);
    await page
      .getByLabel(/^The code the app shows now/)
      .fill(totpCode(bytes, totpStepOf(Date.now())));
    await page.getByRole('button', { name: 'Confirm' }).click();
    await page.waitForURL(/\/settings\/security\?notice=/);
    const next = page.getByTestId('continue-after-enrolment').getByRole('link');
    if (await next.count()) await next.click();
    return;
  }
  if (path === '/login/code') {
    const response = await request.post(controlUrl('/factor/code'), { data: { email } });
    if (!response.ok()) throw new Error(`factor/code answered ${response.status()}`);
    const { code } = (await response.json()) as { code: string };
    await page.getByLabel(/^Code/).fill(code);
    await page.getByRole('button', { name: 'Sign in' }).click();
  }
}

export async function signInAs(
  request: APIRequestContext,
  user: { readonly sub: string; readonly email: string; readonly name: string },
): Promise<void> {
  const response = await request.post(controlUrl('/idp/next-user'), {
    data: user,
  });
  if (!response.ok()) throw new Error(`idp/next-user answered ${response.status()}`);
}

export interface SmallMission {
  readonly mission_id: string;
  /** The mission token, as the creator would paste it into the agent's environment. */
  readonly token: string;
}

/**
 * Issues a mission of Ada on her GitHub connection with a two-action quota on
 * `github.read-code` and hands back its token. The calls are the spec's to
 * make, over HTTP on `/mcp` (`agent.ts`).
 */
export async function issueSmallMission(
  request: APIRequestContext,
  name: string,
): Promise<SmallMission> {
  const response = await request.post(controlUrl('/small-mission'), {
    data: { name },
  });
  if (!response.ok()) throw new Error(`small-mission answered ${response.status()}`);
  return (await response.json()) as SmallMission;
}

/**
 * Issues a mission of the approver (`E2E_APPROVER_USER`) from the GitHub plugin's
 * `developer` preset as shipped, on a connection of their own, and hands back its
 * token. Some of the preset's risks are gated `approval`.
 */
export async function issueDeveloperMission(
  request: APIRequestContext,
  name: string,
): Promise<SmallMission> {
  const response = await request.post(controlUrl('/developer-mission'), {
    data: { name },
  });
  if (!response.ok()) throw new Error(`developer-mission answered ${response.status()}`);
  return (await response.json()) as SmallMission;
}

/**
 * A GitHub connection owned by the share spec's owner (a token of the mocked GitHub,
 * so calls go through), with the owner, the beneficiary and the operator known
 * to the instance as if each had signed in once.
 */
export async function seedShareScenario(
  request: APIRequestContext,
  connectionName: string,
): Promise<{ connection_id: string }> {
  const response = await request.post(controlUrl('/share-scenario'), {
    data: { name: connectionName },
  });
  if (!response.ok()) throw new Error(`share-scenario answered ${response.status()}`);
  return (await response.json()) as { connection_id: string };
}

export interface UpstreamLog {
  /** The token of Ada's GitHub connection, as pasted: never to reach a browser or an executor. */
  readonly connection_token: string;
  readonly calls: readonly {
    readonly method: string;
    readonly url: string;
    readonly with_connection_token: boolean;
  }[];
}

/** What the mocked provider received since the instance started. */
export async function upstreamLog(request: APIRequestContext): Promise<UpstreamLog> {
  const response = await request.get(controlUrl('/upstream'));
  if (!response.ok()) throw new Error(`upstream answered ${response.status()}`);
  return (await response.json()) as UpstreamLog;
}

export interface SeededDay {
  readonly mission_id: string;
  readonly claim_id: string;
  readonly approval_id: string;
}

/**
 * Issues a mission for the audit user and leaves a day of calls on it. The one
 * fixture recorded below the door (through the root's budget and audit
 * writer): it holds gated and refused calls no mocked provider could answer.
 */
export async function seedDay(request: APIRequestContext): Promise<SeededDay> {
  const response = await request.post(controlUrl('/seed-day'));
  if (!response.ok()) throw new Error(`seed-day answered ${response.status()}`);
  return (await response.json()) as SeededDay;
}
