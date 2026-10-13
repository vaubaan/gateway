/**
 * The whole delegation flow driven by the official MCP client package (spec
 * §4.1 bis "the flow follows the standard authorization of MCP servers,
 * metadata discovery included, so that a client such as Claude Code connects
 * with no special configuration"; §10 "OAuth delegation … by an MCP client").
 *
 * The client is `@modelcontextprotocol/client` as an agent runtime embeds it:
 * a `StreamableHTTPClientTransport` pointed at `/mcp/manage` with an
 * `OAuthClientProvider` that only stores what it is handed. Nothing is
 * configured by hand — neither the authorization server, nor a client id, nor
 * a scope. The human part (sign-in at the simulated IdP, consent screen) is
 * played by `Browser`.
 */
import {
  Client,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MANAGEMENT_TOOL_NAMES } from '../../../src/server/management';
import { ACCESS_TOKEN_PREFIX, REFRESH_TOKEN_PREFIX } from '../../../src/server/oauth-as';
import {
  ADA,
  LOOPBACK_REDIRECT,
  MANAGEMENT_URL,
  openInstance,
  PUBLIC_CLIENT_METADATA,
  PUBLIC_URL,
  type Instance,
} from './support';

type ClientInformation = NonNullable<Awaited<ReturnType<OAuthClientProvider['clientInformation']>>>;
type Tokens = NonNullable<Awaited<ReturnType<OAuthClientProvider['tokens']>>>;

/** What an agent runtime persists between two runs: nothing but what the flow hands it. */
class MemoryOAuthProvider implements OAuthClientProvider {
  information: ClientInformation | undefined;
  stored: Tokens | undefined;
  verifier = '';
  discovery: OAuthDiscoveryState | undefined;
  /** Where the runtime would open the user's browser. */
  authorizationUrl: URL | null = null;

  constructor(private readonly metadata: OAuthClientMetadata = PUBLIC_CLIENT_METADATA) {}

  get redirectUrl(): string {
    return LOOPBACK_REDIRECT;
  }
  get clientMetadata(): OAuthClientMetadata {
    return this.metadata;
  }
  state(): string {
    return 'runtime-state';
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
    if (scope === 'all' || scope === 'verifier') this.verifier = '';
    if (scope === 'all' || scope === 'discovery') this.discovery = undefined;
  }
}

describe('an MCP client obtains a delegation with no configuration', () => {
  let instance: Instance;
  let provider: MemoryOAuthProvider;

  beforeEach(async () => {
    instance = await openInstance();
    provider = new MemoryOAuthProvider();
  });
  afterEach(() => instance.close());

  function transport(): StreamableHTTPClientTransport {
    return new StreamableHTTPClientTransport(new URL(MANAGEMENT_URL), {
      authProvider: provider,
      fetch: instance.fetch,
    });
  }

  async function connect(): Promise<Client> {
    const client = new Client({ name: 'scripted-agent', version: '1.0.0' });
    await client.connect(transport());
    return client;
  }

  /** First contact: the client discovers, registers and asks for the user's browser. */
  async function firstContact(): Promise<StreamableHTTPClientTransport> {
    const first = transport();
    const client = new Client({ name: 'scripted-agent', version: '1.0.0' });
    await expect(client.connect(first)).rejects.toSatisfy((err) =>
      UnauthorizedError.isInstance(err),
    );
    return first;
  }

  it('discovers, registers, sends the user to consent, and is admitted with a delegated token', async () => {
    const first = await firstContact();

    // ── Discovery, in the order the client performs it ──────────────────────
    const discovery = instance.served.filter(
      (line) => !line.startsWith('POST /mcp/manage') || line === instance.served[0],
    );
    expect(discovery).toEqual([
      'POST /mcp/manage', // 401 + WWW-Authenticate: resource_metadata
      'GET /.well-known/oauth-protected-resource/mcp/manage',
      'GET /.well-known/oauth-authorization-server',
      'POST /oauth/register',
    ]);
    expect(provider.discovery?.authorizationServerUrl).toBe(PUBLIC_URL);
    expect(provider.discovery?.resourceMetadata?.resource).toBe(MANAGEMENT_URL);
    expect(provider.information?.client_id).toMatch(/^vbn_client_/);
    expect(provider.information).not.toHaveProperty('client_secret');

    // ── The authorization request the client built from the metadata ────────
    const authorizationUrl = provider.authorizationUrl;
    if (!authorizationUrl) throw new Error('the client did not ask for the browser');
    expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe(
      `${PUBLIC_URL}/oauth/authorize`,
    );
    expect(Object.fromEntries(authorizationUrl.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: provider.information?.client_id,
      redirect_uri: LOOPBACK_REDIRECT,
      code_challenge_method: 'S256',
      scope: 'mgmt',
      resource: MANAGEMENT_URL,
      state: 'runtime-state',
    });

    // ── The human: IdP sign-in, then the consent screen ─────────────────────
    const browser = instance.browser();
    const page = await browser.navigate(authorizationUrl.href, ADA);
    expect(page.status).toBe(200);
    const html = await page.clone().text();
    expect(html).toContain('Scripted MCP client');
    expect(html).toContain('ada@example.com');
    expect(html).toContain('<code>mgmt</code>');
    expect(html).toContain('127.0.0.1:43210');
    const answered = await browser.answerConsent(page, 'approve');
    const callback = new URL(answered.headers.get('location') ?? '');
    expect(`${callback.origin}${callback.pathname}`).toBe(LOOPBACK_REDIRECT);
    expect(callback.searchParams.get('state')).toBe('runtime-state');
    expect(callback.searchParams.get('iss')).toBe(PUBLIC_URL);

    // ── Back in the client: code → tokens, then the door opens ──────────────
    await first.finishAuth(callback.searchParams);
    expect(provider.stored?.access_token.startsWith(ACCESS_TOKEN_PREFIX)).toBe(true);
    expect(provider.stored?.refresh_token?.startsWith(REFRESH_TOKEN_PREFIX)).toBe(true);
    expect(provider.stored).toMatchObject({ token_type: 'Bearer', expires_in: 900, scope: 'mgmt' });

    const client = await connect();
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      ...MANAGEMENT_TOOL_NAMES,
    ]);
    await client.close();

    // ── What the instance recorded ───────────────────────────────────────────
    const ada = await instance.root.store.users.getByIdentity(instance.idp.iss, ADA.sub);
    const delegations = await instance.root.store.delegations.listForUser(ada?.id ?? '');
    expect(delegations).toHaveLength(1);
    expect(delegations[0]).toMatchObject({ status: 'active', scope: 'mgmt' });
    const [view] = await instance.root.oauth.delegations.listFor(ada!);
    expect(view).toMatchObject({ state: 'active', client: { name: 'Scripted MCP client' } });
  });

  it('renews its access token by itself when it expires, and each renewal rotates the refresh token', async () => {
    const first = await firstContact();
    const callback = await instance.browser().authorize(provider.authorizationUrl!);
    await first.finishAuth(callback.searchParams);
    const before = { ...provider.stored! };

    // The access token dies (as if fifteen minutes had passed).
    instance.root.store.db
      .prepare('UPDATE oauth_access_tokens SET expires_at = ?')
      .run('2000-01-01T00:00:00.000Z');

    const client = await connect();
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      ...MANAGEMENT_TOOL_NAMES,
    ]);
    await client.close();
    expect(provider.stored?.access_token).not.toBe(before.access_token);
    expect(provider.stored?.refresh_token).not.toBe(before.refresh_token);
    expect(instance.served).toContain('POST /oauth/token');
    // No second trip through the browser.
    expect(instance.served.filter((line) => line === 'GET /oauth/authorize')).toHaveLength(2);
  });

  it('is sent back to the user when its delegation is revoked', async () => {
    const first = await firstContact();
    const browser = instance.browser();
    const callback = await browser.authorize(provider.authorizationUrl!);
    await first.finishAuth(callback.searchParams);
    await (await connect()).close();

    const ada = await instance.root.store.users.getByIdentity(instance.idp.iss, ADA.sub);
    const [delegation] = await instance.root.store.delegations.listForUser(ada?.id ?? '');
    const revoked = await browser.post(`/delegations/${delegation?.id ?? ''}/revoke`, {});
    expect(revoked.headers.get('location')).toBe('/delegations?revoked=1');

    // The stored tokens are dead: the client tries its refresh token, is told
    // `invalid_grant`, and asks for the browser again.
    provider.authorizationUrl = null;
    const client = new Client({ name: 'scripted-agent', version: '1.0.0' });
    await expect(client.connect(transport())).rejects.toSatisfy((err) =>
      UnauthorizedError.isInstance(err),
    );
    expect(provider.authorizationUrl).not.toBeNull();
    expect(provider.stored).toBeUndefined();
  });

  it('is told access_denied when the user refuses', async () => {
    const first = await firstContact();
    const callback = await instance
      .browser()
      .authorize(provider.authorizationUrl!, { decision: 'deny' });
    expect(callback.searchParams.get('error')).toBe('access_denied');
    await expect(first.finishAuth(callback.searchParams)).rejects.toThrow(/refused|access_denied/);
    expect(provider.stored).toBeUndefined();
    const ada = await instance.root.store.users.getByIdentity(instance.idp.iss, ADA.sub);
    expect(await instance.root.store.delegations.listForUser(ada?.id ?? '')).toEqual([]);
  });
});
