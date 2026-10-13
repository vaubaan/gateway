/**
 * "Have an agent act on my behalf" in a browser, against an ephemeral instance
 * with a simulated IdP (spec §4.1 bis, §4.2 "Delegations", §7.10
 * definition of done).
 *
 * The agent is the official MCP client, pointed at the management door with
 * nothing configured but its URL: it discovers the authorization server,
 * registers itself and asks for the user's browser. The user signs in, reads
 * the consent screen in a real browser and clicks Authorize — the form post is
 * the browser's own, with the `Origin` header it really sends — and the agent
 * is admitted. The agent then prepares a mission by itself (spec §7.10): it
 * reads the user's authority, previews a policy, issues the mission, and the
 * mission token it receives works on the execution door. The user finds the
 * mission under their name, marked as delegated, and the delegation — with
 * that mission — on the Delegations page, where they revoke it in one click;
 * the agent is locked out at its next request and the mission stays theirs.
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

import { connectAgent, kitToolsList } from './agent';
import { routeToInstance, signInAs } from './browser';
import { E2E_USER, localOrigin, PUBLIC_URL } from './instance';

/** Where the agent would listen for the authorization response, on the user's machine. */
const CALLBACK = 'http://127.0.0.1:43217/callback';
const MANAGEMENT_URL = `${PUBLIC_URL}/mcp/manage`;
const CLIENT_NAME = 'E2E coding agent';
const MISSION_NAME = 'Read the app repository (prepared by the agent)';

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

/** The structured content of a tool answer of the management door. */
async function manage<T>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(`${name} refused: ${JSON.stringify(result.content)}`);
  return result.structuredContent as T;
}

interface ListedConnection {
  readonly connection_id: string;
  readonly provider: string;
  readonly authority: { readonly basis: string; readonly risk_ids: readonly string[] };
  readonly resources: readonly { readonly ref: string }[];
  readonly presets: readonly { readonly id: string; readonly within_authority: boolean }[];
}

/** Keeps a screenshot of a step when `E2E_V5_SCREENSHOT_DIR` names a folder (design review). */
async function snap(page: Page, name: string): Promise<void> {
  const dir = process.env.E2E_V5_SCREENSHOT_DIR;
  if (dir) await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
}

test.beforeEach(async ({ request }) => {
  await signInAs(request, E2E_USER);
});

test('an agent obtains a delegation, prepares and issues a mission, and the user revokes the delegation', async ({
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
  await expect(page.locator('main')).toContainText('answer what waits for you');
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
  const manager = admitted.client;
  expect((await manager.listTools()).tools.map((tool) => tool.name)).toEqual([
    'list_my_connections',
    'get_catalog',
    'list_my_missions',
    'preview_policy',
    'issue_mission',
    'rotate_mission_token',
    'revoke_mission',
  ]);

  // ── The agent reads the user's authority and the catalog ───────────────────
  const { connections } = await manage<{ connections: ListedConnection[] }>(
    manager,
    'list_my_connections',
    {},
  );
  const github = connections.find((connection) => connection.provider === 'github');
  if (!github) throw new Error('the user holds no GitHub connection');
  expect(github.authority.basis).toBe('owner');
  expect(github.resources.map((resource) => resource.ref)).toContain('acme/app');
  expect(github.presets.find((preset) => preset.id === 'read-only')?.within_authority).toBe(true);
  const catalog = await manage<{ risks: { risk_id: string }[]; presets: { id: string }[] }>(
    manager,
    'get_catalog',
    { provider: 'github', connection_id: github.connection_id },
  );
  expect(catalog.risks.map((risk) => risk.risk_id)).toContain('github.read-code');

  // ── It composes a policy from a preset, previews it, issues the mission ────
  const draft = {
    name: MISSION_NAME,
    connections: [
      {
        connection_id: github.connection_id,
        preset: 'read-only',
        resources: { scope: 'selected', resource_refs: ['acme/app'] },
      },
    ],
    period: { kind: 'recurring', length_seconds: 86_400 },
    expires_at: null,
  };
  const preview = await manage<{ ok: boolean; uncovered: unknown[]; policy: unknown[] }>(
    manager,
    'preview_policy',
    draft,
  );
  expect(preview).toMatchObject({ ok: true, uncovered: [] });
  expect(preview.policy.length).toBeGreaterThan(0);

  const issued = await manage<{
    mission: { mission_id: string; issued_via_client_id: string };
    token: { secret: string };
    bootstrap_kit: { agent_instructions: string; mcp_json: string };
  }>(manager, 'issue_mission', draft);
  expect(issued.mission.issued_via_client_id).toBe(provider.information?.client_id);
  expect(issued.token.secret).toMatch(/^vbn_live_/);
  expect(issued.bootstrap_kit.mcp_json).toContain(`${PUBLIC_URL}/mcp`);
  expect(issued.bootstrap_kit.agent_instructions).toContain('### The management door');

  // ── The mission token works on the execution door, and only there ──────────
  expect((await kitToolsList(issued.token.secret)).status).toBe(200);
  const executor = await connectAgent(issued.token.secret);
  expect(await executor.listTools()).toContain('github__get_file_contents');
  const read = await executor.call('github__get_file_contents', {
    owner: 'acme',
    repo: 'app',
    path: 'README.md',
  });
  expect(read.outcome).toBe('allowed');
  // A repository outside the selection the agent made cannot be called.
  await expect(
    executor.call('github__get_file_contents', { owner: 'acme', repo: 'docs', path: 'README.md' }),
  ).rejects.toThrow(/not selected in this mission/);
  await executor.close();
  const wrongDoor = await viaLocalListener(MANAGEMENT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${issued.token.secret}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  expect(wrongDoor.status).toBe(403);
  expect(await wrongDoor.json()).toMatchObject({
    error: { data: { code: 'wrong-credential-kind' } },
  });
  await manager.close();

  // ── The user sees the mission under their name, marked as delegated ────────
  await page.goto(`${PUBLIC_URL}/missions`);
  const row = page.getByRole('row').filter({ hasText: MISSION_NAME });
  await expect(row).toContainText(`prepared by ${CLIENT_NAME} for you`);
  await snap(page, 'missions-delegated');
  await row.getByRole('link', { name: MISSION_NAME }).click();
  await expect(page.getByTestId('issued-via')).toContainText(CLIENT_NAME);
  await expect(page.getByTestId('issued-via')).toContainText(
    provider.information?.client_id ?? 'no client id',
  );
  await expect(page.getByTestId('issued-via')).toContainText('it is not verified');
  await snap(page, 'mission-delegated');

  // ── The user sees the delegation and revokes it in one click ───────────────
  await page.goto(`${PUBLIC_URL}/delegations`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Delegations');
  const card = page.locator(`[id]`, { hasText: CLIENT_NAME }).first();
  await expect(card).toContainText('active');
  await expect(card).toContainText(provider.information?.client_id ?? 'no client id');
  await expect(card).toContainText('127.0.0.1:43217');
  await expect(card.getByRole('link', { name: MISSION_NAME })).toBeVisible();
  await expect(card).toContainText('issued in your name');
  // A consent does not last for ever: the page says when it ends (90 days by default).
  await expect(card).toContainText('Consent ends');
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

  // ── The mission it issued is the user's and stays: its token still works ───
  expect((await kitToolsList(issued.token.secret)).status).toBe(200);
  await page.goto(`${PUBLIC_URL}/missions/${issued.mission.mission_id}`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(MISSION_NAME);
  // Still running: a mission that serves calls carries no mark beside its title.
  await expect(page.getByTestId('mission-state')).toHaveCount(0);
  await expect(page.getByTestId('mission-allows')).toBeVisible();

  await context.close();
});

test('connected apps are part of Settings, and an empty page says how to authorize an agent', async ({
  browser,
  request,
}) => {
  // Someone who delegated nothing.
  await signInAs(request, { sub: 'idp|linus', email: 'linus@example.com', name: 'Linus' });
  const context = await browser.newContext();
  await routeToInstance(context);
  const page = await context.newPage();
  await page.goto(`${PUBLIC_URL}/auth/login?return_to=/delegations`);
  await expect(
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Settings' }),
  ).toHaveAttribute('aria-current', 'page');
  await expect(
    page
      .getByRole('navigation', { name: 'Settings' })
      .getByRole('link', { name: 'Connected apps' }),
  ).toHaveAttribute('aria-current', 'page');
  await expect(page.getByText('You authorized no application.')).toBeVisible();
  await expect(page.locator('body')).toContainText(`${PUBLIC_URL}/mcp/manage`);
  await context.close();
});
