/**
 * The rig of the `vaubaan` plugin tests (spec §4.1 bis, §10 "issuance of a
 * mission by an agent within the user's authority and refusal beyond it"; ADR
 * platform-management-is-a-plugin-on-the-execution-door): the real composition
 * root on the `:memory:` store, a simulated IdP, the instance's HTTP surface as
 * one `fetch`, Ada's seeded connections on the shipped plugins, and an
 * **agent** — the official MCP client on the execution door, holding the key of
 * a platform management mission on its user's Vaubaan account.
 *
 * `ROUTES` is the surface the tests drive: each path with the host-agnostic
 * handler its Next route file delegates to.
 */
import { Client, ProtocolError, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { AdminAuditEntry } from '@vaubaan/gateway-core';
import { TOOL_PREFIX } from '@vaubaan/plugin-vaubaan';

import { SESSION_COOKIE } from '../../../src/server/auth';
import { buildRoot, type GatewayRoot, type RootDeps } from '../../../src/server/compose/root';
import { loadInstanceConfig } from '../../../src/server/config';
import type { Actor } from '../../../src/server/connections';
import { retiredManagementDoorResponse } from '../../../src/server/execution/retired-door';
import { executionResourceMetadataResponse } from '../../../src/server/execution/resource-metadata';
import type { UserRecord } from '../../../src/server/store/types';
import {
  isSecondFactorStep,
  passSecondFactor,
  saveTestOidcProvider,
} from '../../support/auth/testing';
import { memoryStoreDeps } from '../../support/compose/testing';
import { validEnv } from '../../support/config/testing';
import { FakeIdp } from '../auth/fake-idp';
import { seedInstance, type SeededInstance } from '../missions/support';

export const PUBLIC_URL = 'https://gateway.example.com';
export const EXECUTION_URL = `${PUBLIC_URL}/mcp`;
/** The retired management door: 404 with a hint. */
export const MANAGEMENT_URL = `${PUBLIC_URL}/mcp/manage`;
export const OPERATOR_EMAIL = 'ops@example.com';

const IDP_CLIENT = { clientId: 'vaubaan-gateway', clientSecret: 'client-secret-for-tests' };

/** The IdP claims of the seeded people (`seedInstance`) and of the operator. */
export const ADA = { sub: 'idp|ada', email: 'ada@example.com', name: 'Ada' } as const;
export const BOB = { sub: 'idp|bob', email: 'bob@example.com', name: 'Bob' } as const;
export const OPS = { sub: 'idp|ops', email: OPERATOR_EMAIL, name: 'Ops' } as const;

type Handler = (root: GatewayRoot, request: Request, id: string) => Promise<Response>;

interface Route {
  /** The path, `:<name>` standing for one dynamic segment. */
  readonly path: string;
  readonly handle: Handler;
}

const ROUTES: readonly Route[] = [
  {
    path: '/.well-known/oauth-protected-resource',
    handle: async (root, request) =>
      executionResourceMetadataResponse(root.config.publicUrl, request),
  },
  { path: '/mcp/manage', handle: async () => retiredManagementDoorResponse() },
  { path: '/mcp', handle: (root, request) => root.execution.handlers.mcp(request) },
  { path: '/auth/login', handle: (root, request) => root.auth.handlers.loginStart(request) },
  {
    path: '/auth/callback/:provider',
    handle: (root, request, id) => root.auth.handlers.loginCallback(request, id),
  },
];

function match(route: Route, pathname: string): string | null {
  const pattern = route.path.split('/');
  const actual = pathname.split('/');
  if (pattern.length !== actual.length) return null;
  let id = '';
  for (let i = 0; i < pattern.length; i += 1) {
    if (pattern[i]?.startsWith(':')) id = decodeURIComponent(actual[i] ?? '');
    else if (pattern[i] !== actual[i]) return null;
  }
  return id;
}

export interface Instance {
  readonly root: GatewayRoot;
  readonly idp: FakeIdp;
  /** Every log line the instance wrote. */
  readonly logs: string[];
  /** The instance's HTTP surface. Anything outside it rejects: nothing reaches a network. */
  readonly fetch: typeof fetch;
  browser(): Browser;
  close(): Promise<void>;
}

export interface InstanceOptions {
  readonly env?: Record<string, string | undefined>;
  readonly deps?: RootDeps;
}

export async function openInstance(options: InstanceOptions = {}): Promise<Instance> {
  const logs: string[] = [];
  const idp = new FakeIdp(IDP_CLIENT);
  const root = await buildRoot({
    loadConfig: () =>
      loadInstanceConfig({
        env: validEnv({
          VAUBAAN_PUBLIC_URL: PUBLIC_URL,
          VAUBAAN_ADMIN_EMAILS: OPERATOR_EMAIL,
          ...options.env,
        }),
      }),
    logWrite: (_level, line) => logs.push(line),
    oidc: { fetch: idp.fetch, allowInsecureIssuer: true },
    ...memoryStoreDeps,
    ...options.deps,
  });
  await saveTestOidcProvider(root.store.config, {
    issuer: idp.issuer.href,
    clientId: IDP_CLIENT.clientId,
    clientSecret: IDP_CLIENT.clientSecret,
    claims: { sub: 'sub', email: 'email', groups: 'groups' },
    allowedEmailDomains: [],
  });

  const dispatch: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== PUBLIC_URL) {
      throw new TypeError(`the test instance does not serve ${url.origin}`);
    }
    for (const route of ROUTES) {
      const id = match(route, url.pathname);
      if (id !== null) return route.handle(root, request, id);
    }
    return new Response('not found', { status: 404 });
  };

  const instance: Instance = {
    root,
    idp,
    logs,
    fetch: dispatch,
    browser: () => new Browser(instance),
    close: () => root.close(),
  };
  return instance;
}

/**
 * A user's browser: a cookie jar and the walk through the redirects of a
 * sign-in. It never follows a redirect that leaves the instance other than to
 * the simulated IdP.
 */
export class Browser {
  readonly cookies = new Map<string, string>();

  constructor(private readonly instance: Instance) {}

  cookieHeader(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  private absorb(response: Response): void {
    for (const header of response.headers.getSetCookie()) {
      const [pair, ...attributes] = header.split(';');
      const [name, value] = (pair ?? '').split('=');
      if (!name) continue;
      if (attributes.some((a) => a.trim() === 'Max-Age=0') || !value) {
        this.cookies.delete(name.trim());
      } else {
        this.cookies.set(name.trim(), value.trim());
      }
    }
  }

  /** One GET, no redirect followed. */
  async get(pathOrUrl: string): Promise<Response> {
    const response = await this.instance.fetch(new URL(pathOrUrl, PUBLIC_URL), {
      headers: { cookie: this.cookieHeader() },
      redirect: 'manual',
    });
    this.absorb(response);
    return response;
  }

  /** GET, then every redirect through the IdP (where `claims` signs in) and back. */
  async navigate(pathOrUrl: string, claims: Record<string, unknown> = ADA): Promise<Response> {
    let response = await this.get(pathOrUrl);
    for (let hop = 0; hop < 10; hop += 1) {
      const location = response.headers.get('location');
      if (response.status !== 303 || !location) return response;
      const target = new URL(location, PUBLIC_URL);
      if (target.origin === this.instance.idp.issuer.origin) {
        this.instance.idp.nextClaims = { ...claims };
        response = await this.get(this.instance.idp.authorize(target).href);
      } else if (isSecondFactorStep(response)) {
        const answered = await passSecondFactor(
          this.instance.root,
          PUBLIC_URL,
          this.cookieHeader(),
        );
        if (!answered) return response;
        this.absorb(answered);
        response = answered;
      } else if (target.origin === PUBLIC_URL && target.pathname === '/settings/security') {
        const next = target.searchParams.get('return_to');
        if (!next) return response;
        response = new Response(null, { status: 303, headers: { location: next } });
      } else if (
        target.origin === PUBLIC_URL &&
        ROUTES.some((route) => match(route, target.pathname) !== null)
      ) {
        response = await this.get(target.href);
      } else {
        return response;
      }
    }
    throw new Error('too many redirects');
  }

  /** Signs in through the IdP as `claims` and returns the user row. */
  async signIn(claims: Record<string, unknown> = ADA): Promise<UserRecord> {
    const response = await this.navigate('/auth/login?return_to=/missions', claims);
    if (response.headers.get('location') !== '/missions') {
      throw new Error(`sign-in did not complete: ${response.status}`);
    }
    const sessionId = this.cookies.get(SESSION_COOKIE);
    const principal = await this.instance.root.auth.authenticator.authenticate(
      new Headers({ cookie: `${SESSION_COOKIE}=${sessionId ?? ''}` }),
    );
    if (principal?.kind !== 'user') throw new Error('sign-in produced no user session');
    return principal.user;
  }
}

/** A JSON-RPC `tools/list` at the MCP door, with whatever credentials are given. */
export function toolsList(
  instance: Instance,
  url: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return instance.fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
}

export const bearer = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
});

// ─────────────────────────────────────────────────────────────────────────────
// The agent: an MCP client holding the key of a platform management mission
// ─────────────────────────────────────────────────────────────────────────────

/** What a tool answered: its structured content, and whether it is a refusal. */
export interface ToolAnswer<T = Record<string, unknown>> {
  readonly isError: boolean;
  /** True when the door rejected the call itself (a JSON-RPC error: a refusal of the door). */
  readonly protocolError: boolean;
  readonly data: T;
  /** The text content, as a text-only client reads it. */
  readonly text: string;
  /** The refusal code of the door, when `protocolError`. */
  readonly code: string | null;
}

export interface Agent {
  /** The platform management mission whose key the agent holds. */
  readonly missionId: string;
  readonly token: string;
  readonly user: UserRecord;
  /** The user's Vaubaan account. */
  readonly accountId: string;
  readonly client: Client;
  toolNames(): Promise<string[]>;
  /** Calls `vaubaan__<name>` (the prefix is added when missing). */
  call<T = Record<string, unknown>>(
    name: string,
    args?: Record<string, unknown>,
  ): Promise<ToolAnswer<T>>;
  close(): Promise<void>;
}

/** Every macro-action of the Vaubaan catalog at Autonomous: no call asks first. */
export const PLATFORM_AUTONOMOUS = {
  read: 'autonomous',
  prepare: 'autonomous',
  rotate: 'autonomous',
  stop: 'autonomous',
} as const;

export interface VaubaanRig extends Instance {
  readonly seeded: SeededInstance;
  /** A user with their current groups, as a page builds it. */
  actor(user: UserRecord): Promise<Actor>;
  /**
   * The user's Vaubaan account (connected through the connect service, one click),
   * a platform mission on it at `trustLevels`, and an MCP client on `/mcp` with its key.
   */
  agentOf(
    claims?: { readonly email: string },
    trustLevels?: Readonly<Record<string, string>>,
  ): Promise<Agent>;
  adminEntries(act: AdminAuditEntry['act']): Promise<AdminAuditEntry[]>;
}

export async function connectWithToken(instance: Instance, url: string, token: string) {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    fetch: instance.fetch,
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'scripted-agent', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

export async function openVaubaanRig(options: InstanceOptions = {}): Promise<VaubaanRig> {
  const instance = await openInstance(options);
  const seeded = await seedInstance(instance.root);
  const { root } = instance;

  const rig: VaubaanRig = {
    ...instance,
    seeded,
    async actor(user) {
      return { user, groups: await root.store.groups.groupsOf(user.id) };
    },
    async agentOf(claims = ADA, trustLevels = PLATFORM_AUTONOMOUS) {
      const user = claims.email === BOB.email ? seeded.bob : seeded.ada;
      const started = await root.connections.service.start(await rig.actor(user), 'vaubaan');
      if (started.kind !== 'connected') throw new Error('a Vaubaan account connects at once');
      const issued = await root.missions.service.issue(user, {
        name: 'Platform management',
        connections: [{ connection_id: started.connection.id, trust_levels: trustLevels }],
        period: { kind: 'recurring', length_seconds: 86_400 },
        expires_at: null,
      });
      if (!issued.ok) throw new Error(`platform mission refused: ${issued.reason}`);
      const token = issued.token.secret;
      const client = await connectWithToken(instance, EXECUTION_URL, token);
      return {
        missionId: issued.mission.id,
        token,
        user,
        accountId: started.connection.id,
        client,
        async toolNames() {
          return (await client.listTools()).tools.map((tool) => tool.name);
        },
        async call<T>(name: string, args: Record<string, unknown> = {}) {
          const tool = name.startsWith(TOOL_PREFIX) ? name : `${TOOL_PREFIX}${name}`;
          let result: Awaited<ReturnType<Client['callTool']>>;
          try {
            result = await client.callTool({ name: tool, arguments: args });
          } catch (err) {
            // A refusal of the door (risk not accepted, budget…) is a JSON-RPC error.
            if (!(err instanceof ProtocolError)) throw err;
            const data = (err as { data?: { code?: string } }).data;
            return {
              isError: true,
              protocolError: true,
              data: {} as T,
              text: err.message,
              code: data?.code ?? null,
            };
          }
          const content = (result.content ?? []) as { type: string; text?: string }[];
          return {
            isError: result.isError === true,
            protocolError: false,
            data: (result.structuredContent ?? {}) as T,
            text: content.map((part) => part.text ?? '').join(''),
            code: null,
          };
        },
        close: () => client.close(),
      };
    },
    async adminEntries(act) {
      const entries = await root.store.audit.list({ kind: 'admin' });
      return entries.filter(
        (e): e is typeof e & AdminAuditEntry => e.kind === 'admin' && e.act === act,
      );
    },
  };
  return rig;
}

/** A draft on one connection with explicit risks, each with its budget. */
export function draftOn(
  connectionId: string,
  riskIds: readonly string[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name: 'Fix the flaky test',
    connections: [
      {
        connection_id: connectionId,
        resources: { scope: 'all' },
        policy: riskIds.map((risk_id) => ({
          risk_id,
          quota: 20,
          rate_limit: { max: 5, window_seconds: 60 },
          gate: 'auto',
        })),
      },
    ],
    period: { kind: 'recurring', length_seconds: 86_400 },
    expires_at: null,
    ...overrides,
  };
}
