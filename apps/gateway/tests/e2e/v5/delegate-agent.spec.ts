/**
 * "Have an agent act on my behalf" in a browser, against an ephemeral instance
 * with a simulated IdP (spec §4.1 bis, §4.2 "Delegations", §7.10; plan P2.3
 * definition of done).
 *
 * The agent is the official MCP client, pointed at the management door with
 * nothing configured but its URL: it discovers the authorization server,
 * registers itself and asks for the user's browser. The user signs in, reads
 * the consent screen in a real browser and clicks Authorize — the form post is
 * the browser's own, with the `Origin` header it really sends — and the agent
 * is admitted. The user then finds the delegation on the Delegations page and
 * revokes it in one click; the agent is locked out at its next request.
 */
import {
  Client,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from '@modelcontextprotocol/client';
import { expect, test, type Page } from '@playwright/test';

import { routeToInstance, signInAs } from './browser';
import { E2E_USER, localOrigin, PUBLIC_URL } from './instance';

/** Where the agent would listen for the authorization response, on the user's machine. */
const CALLBACK = 'http://127.0.0.1:43217/callback';
const MANAGEMENT_URL = `${PUBLIC_URL}/mcp/manage`;
const CLIENT_NAME = 'E2E coding agent';

type ClientInformation = NonNullable<Awaited<ReturnType<OAuthClientProvider['clientInformation']>>>;
type Tokens = NonNullable<Awaited<ReturnType<OAuthClientProvider['tokens']>>>;

/** What an agent runtime keeps between two runs: only what the flow hands it. */
class MemoryOAuthProvider implements OAuthClientProvider {
  information: ClientInformation | undefined;
  stored: Tokens | undefined;
  verifier = '';
  discovery: OAuthDiscoveryState | undefined;
  authorizationUrl: URL | null = null;

  get redirectUrl(): string {
    return CALLBACK;
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: CLIENT_NAME,
      redirect_uris: [CALLBACK],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    };
  }
  clientInformation(): ClientInformation | undefined {
    return this.information;
  }
  saveClientInformation(information: ClientInformation): void {
    this.information = information;
  }
  tokens(): Tokens | undefined {
    return this.stored;
  }
  saveTokens(tokens: Tokens): void {
    this.stored = tokens;
  }
  redirectToAuthorization(url: URL): void {
    this.authorizationUrl = url;
  }
  saveCodeVerifier(verifier: string): void {
    this.verifier = verifier;
  }
  codeVerifier(): string {
    return this.verifier;
  }
  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.discovery = state;
  }
  discoveryState(): OAuthDiscoveryState | undefined {
    return this.discovery;
  }
  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'all' || scope === 'tokens') this.stored = undefined;
    if (scope === 'all' || scope === 'client') this.information = undefined;
  }
}

/**
 * The agent's HTTP: it addresses the instance by its public URL, as the
 * metadata documents tell it to; the test delivers those requests to the
 * local listener, as the TLS terminator would.
 */
const viaLocalListener: typeof fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin !== PUBLIC_URL) throw new TypeError(`unexpected host ${url.origin}`);
  return fetch(`${localOrigin()}${url.pathname}${url.search}`, init);
};

function connectWith(provider: MemoryOAuthProvider): {
  client: Client;
  transport: StreamableHTTPClientTransport;
} {
  const transport = new StreamableHTTPClientTransport(new URL(MANAGEMENT_URL), {
    authProvider: provider,
    fetch: viaLocalListener,
  });
  return { client: new Client({ name: 'e2e-delegated-agent', version: '1.0.0' }), transport };
}

/** The connection is refused for want of a token: the agent must go through the user. */
async function expectUnauthorized(connecting: Promise<void>): Promise<void> {
  const outcome = await connecting.then(
    () => 'connected',
    (err: unknown) => (UnauthorizedError.isInstance(err) ? 'unauthorized' : String(err)),
  );
  expect(outcome).toBe('unauthorized');
}

/** Keeps a screenshot of a step when `E2E_V5_SCREENSHOT_DIR` names a folder (design review). */
async function snap(page: Page, name: string): Promise<void> {
  const dir = process.env.E2E_V5_SCREENSHOT_DIR;
  if (dir) await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
}

test.beforeEach(async ({ request }) => {
  await signInAs(request, E2E_USER);
});

test('an agent obtains a delegation through the consent screen, and the user revokes it', async ({
  browser,
}) => {
  // ── The agent's first contact: discovery, registration, "open this URL" ────
  const provider = new MemoryOAuthProvider();
  const first = connectWith(provider);
  await expectUnauthorized(first.client.connect(first.transport));
  const authorizationUrl = provider.authorizationUrl;
  if (!authorizationUrl) throw new Error('the agent did not ask for the browser');
  expect(authorizationUrl.href.startsWith(`${PUBLIC_URL}/oauth/authorize?`)).toBe(true);
  expect(provider.information?.client_id).toMatch(/^vbn_client_/);

  // ── The user's browser ─────────────────────────────────────────────────────
  const context = await browser.newContext();
  await routeToInstance(context);
  // The agent's loopback listener: the browser lands there with the code.
  let landed: URL | null = null;
  await context.route('http://127.0.0.1:43217/**', async (route) => {
    landed = new URL(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><title>Agent</title><p>You can close this tab.</p>',
    });
  });
  const page = await context.newPage();

  // Not signed in: the instance sends the user through the IdP and back.
  await page.goto(authorizationUrl.href);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    `Let ${CLIENT_NAME} manage your missions?`,
  );
  await expect(page.locator('main')).toContainText(E2E_USER.email);
  await expect(page.locator('main')).toContainText('It is not verified');
  await expect(page.locator('main')).toContainText('127.0.0.1:43217');
  await expect(page.locator('main')).toContainText('mgmt');
  await expect(page.locator('main')).toContainText('answer a request');
  await expect(page.getByRole('button')).toHaveText(['Deny', 'Authorize']);
  await snap(page, 'delegate-consent');

  await page.getByRole('button', { name: 'Authorize' }).click();
  await expect(page.getByText('You can close this tab.')).toBeVisible();
  const callback = landed as URL | null;
  if (!callback) throw new Error('the browser never reached the agent');
  expect(callback.searchParams.get('iss')).toBe(PUBLIC_URL);
  expect(callback.searchParams.get('code')).toMatch(/^[A-Za-z0-9_-]{43}$/);

  // ── Back in the agent: code → tokens, and the door opens ───────────────────
  await first.transport.finishAuth(callback.searchParams);
  expect(provider.stored?.access_token).toMatch(/^vbn_dat_/);
  const admitted = connectWith(provider);
  await admitted.client.connect(admitted.transport);
  expect((await admitted.client.listTools()).tools).toEqual([]);
  await admitted.client.close();

  // ── The user sees the delegation and revokes it in one click ───────────────
  await page.goto(`${PUBLIC_URL}/delegations`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Delegations');
  const card = page.locator(`[id]`, { hasText: CLIENT_NAME }).first();
  await expect(card).toContainText('active');
  await expect(card).toContainText(provider.information?.client_id ?? 'no client id');
  await expect(card).toContainText('127.0.0.1:43217');
  await snap(page, 'delegations');

  await card.getByRole('button', { name: 'Revoke' }).click();
  await expect(page.getByText('Delegation revoked')).toBeVisible();
  await expect(page.locator('body')).toContainText('revoked by you');
  await snap(page, 'delegations-revoked');

  // ── The agent is locked out at its next request, and asks the user again ───
  provider.authorizationUrl = null;
  const lockedOut = connectWith(provider);
  await expectUnauthorized(lockedOut.client.connect(lockedOut.transport));
  expect(provider.stored).toBeUndefined();
  expect(provider.authorizationUrl).not.toBeNull();

  await context.close();
});

test('the navigation shows Delegations, and an empty page says how to authorize an agent', async ({
  browser,
  request,
}) => {
  // Someone who delegated nothing.
  await signInAs(request, { sub: 'idp|linus', email: 'linus@example.com', name: 'Linus' });
  const context = await browser.newContext();
  await routeToInstance(context);
  const page = await context.newPage();
  await page.goto(`${PUBLIC_URL}/auth/login?return_to=/delegations`);
  await expect(page.getByRole('navigation', { name: 'Main' })).toContainText('Delegations');
  await expect(page.getByText('You authorized no application.')).toBeVisible();
  await expect(page.locator('body')).toContainText(`${PUBLIC_URL}/mcp/manage`);
  await context.close();
});
