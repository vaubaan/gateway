/**
 * Every mutating handler goes through the one guard (spec §6 "every mutation
 * requires a valid session and an origin check"; `server/auth/guard.ts`).
 *
 * The table below names every handler of the human surfaces. Two
 * structural tests keep it complete: a handler added to a module must be
 * classified (a mutation with its role, or a read with the reason), and a
 * route file that exports a mutating HTTP method may only delegate to a
 * handler classified as a mutation. Each mutation is then driven over the
 * real composition root (`:memory:` store) with a request that a rightful
 * caller gets through, and refused for each way the guard refuses, with
 * every table of the store compared before and after.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SESSION_COOKIE } from '../../../../src/server/auth';
import type { GatewayRoot } from '../../../../src/server/compose/root';
import { TEST_BOOTSTRAP_TOKEN } from '../../../../src/server/config/testing';
import type { MissionRecord, UserRecord } from '../../../../src/server/store/types';
import {
  auditRigOn,
  githubDraft,
  issueMission,
  OPERATOR_EMAIL,
  PR,
  seedCall,
  type AuditRig,
} from '../../../integration/audit/support';
import { buildTestRoot, PUBLIC_URL, seedInstance } from '../../../integration/missions/support';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../src/app');
const FOREIGN_ORIGIN = 'https://evil.example';
const JSON_TYPE = 'application/json';
const FORM_TYPE = 'application/x-www-form-urlencoded';

interface Rig extends AuditRig {
  readonly operator: UserRecord;
  readonly mission: MissionRecord;
  /** An open claim on `mission`, addressed to Ada. */
  readonly claimId: string;
}

/** `user`: an identified user. `operator`: the admin rule. `origin-only`: no session is required. */
type Role = 'user' | 'operator' | 'origin-only';

interface Mutation {
  readonly role: Role;
  /** The status a rightful caller gets: the request reaches the handler's own work. */
  readonly passes: number;
  readonly contentType: typeof JSON_TYPE | typeof FORM_TYPE;
  run(rig: Rig, headers: Headers): Promise<Response>;
}

function post(path: string, headers: Headers, body: unknown): Request {
  const form = headers.get('content-type') === FORM_TYPE;
  return new Request(`${PUBLIC_URL}${path}`, {
    method: 'POST',
    headers,
    body: form
      ? new URLSearchParams(body as Record<string, string>).toString()
      : JSON.stringify(body),
  });
}

const json = (
  role: Role,
  passes: number,
  run: (rig: Rig, headers: Headers) => Promise<Response>,
): Mutation => ({ role, passes, contentType: JSON_TYPE, run });

const form = (
  role: Role,
  passes: number,
  run: (rig: Rig, headers: Headers) => Promise<Response>,
): Mutation => ({ role, passes, contentType: FORM_TYPE, run });

const MUTATIONS: Readonly<Record<string, Mutation>> = {
  'missions.handlers.preview': json('user', 200, (rig, headers) =>
    rig.root.missions.handlers.preview(post('/api/missions/preview', headers, githubDraft(rig))),
  ),
  'missions.handlers.issue': json('user', 201, (rig, headers) =>
    rig.root.missions.handlers.issue(post('/api/missions', headers, githubDraft(rig))),
  ),
  'missions.handlers.rotate': json('user', 200, (rig, headers) =>
    rig.root.missions.handlers.rotate(
      post(`/api/missions/${rig.mission.id}/rotate`, headers, {}),
      rig.mission.id,
    ),
  ),
  'missions.handlers.revoke': json('user', 200, (rig, headers) =>
    rig.root.missions.handlers.revoke(
      post(`/api/missions/${rig.mission.id}/revoke`, headers, {}),
      rig.mission.id,
    ),
  ),
  'missions.handlers.setGate': json('user', 200, (rig, headers) =>
    rig.root.missions.handlers.setGate(
      post(`/api/missions/${rig.mission.id}/gate`, headers, {
        risk_id: rig.mission.policy[0]?.riskId,
        gate: 'approval',
      }),
      rig.mission.id,
    ),
  ),
  'requests.handlers.decide': json('user', 200, (rig, headers) =>
    rig.root.requests.handlers.decide(
      post(`/api/requests/${rig.claimId}/decide`, headers, { resolution: 'reset-period' }),
      rig.claimId,
    ),
  ),
  'connections.handlers.connect': form('user', 303, (rig, headers) =>
    rig.root.connections.handlers.connect(
      post('/connections/connect/vercel', headers, { name: 'Another', 'field.token': 'k' }),
      'vercel',
    ),
  ),
  'connections.handlers.discover': form('user', 303, (rig, headers) =>
    rig.root.connections.handlers.discover(
      post(`/connections/${rig.seeded.github.connection.id}/discover`, headers, {}),
      rig.seeded.github.connection.id,
    ),
  ),
  'connections.handlers.revoke': form('user', 303, (rig, headers) =>
    rig.root.connections.handlers.revoke(
      post(`/connections/${rig.seeded.vercel.connection.id}/revoke`, headers, {}),
      rig.seeded.vercel.connection.id,
    ),
  ),
  'connections.handlers.updateResource': form('user', 303, (rig, headers) => {
    const connectionId = rig.seeded.github.connection.id;
    const resourceId = rig.seeded.github.resources[0]?.id ?? 'missing';
    return rig.root.connections.handlers.updateResource(
      post(`/connections/${connectionId}/resources/${resourceId}`, headers, {
        display_name: 'Renamed',
      }),
      connectionId,
      resourceId,
    );
  }),
  'connections.handlers.saveProviderApp': form('operator', 303, (rig, headers) =>
    rig.root.connections.handlers.saveProviderApp(
      post('/admin/provider-apps/github', headers, { action: 'clear' }),
      'github',
    ),
  ),
  'auth.handlers.saveIdpSettings': form('operator', 303, (rig, headers) =>
    rig.root.auth.handlers.saveIdpSettings(
      post('/api/admin/identity-provider', headers, {
        issuer: 'https://idp.example.com',
        client_id: 'gateway',
        client_secret: 'idp-client-secret',
        claim_sub: 'sub',
        claim_email: 'email',
        claim_groups: 'groups',
        allowed_email_domains: '',
      }),
    ),
  ),
  'telemetry.handlers.setEnabled': form('operator', 303, (rig, headers) =>
    rig.root.telemetry.handlers.setEnabled(
      post('/api/admin/telemetry', headers, { enabled: 'true' }),
    ),
  ),
  'auth.handlers.logout': form('origin-only', 303, (rig, headers) =>
    rig.root.auth.handlers.logout(post('/logout', headers, {})),
  ),
  'auth.handlers.bootstrapLogin': form('origin-only', 303, (rig, headers) =>
    rig.root.auth.handlers.bootstrapLogin(
      post('/api/auth/bootstrap', headers, { token: TEST_BOOTSTRAP_TOKEN }),
    ),
  ),
};

/** Handlers that change nothing on behalf of a browser form or script: why they have no origin check. */
const READS: Readonly<Record<string, string>> = {
  'auth.handlers.loginStart': 'GET; starts a sign-in, the pending login is bound to a cookie',
  'auth.handlers.loginCallback': 'GET from the IdP; protected by the single-use state and PKCE',
  'connections.handlers.callback':
    'GET from the provider; protected by the single-use state bound to the user (guardSession)',
  'requests.handlers.open': 'GET; redirects or refuses, rate-limited (guardSession)',
  'requests.handlers.inbox': 'GET; reads the caller’s inbox (guardSession)',
};

const SURFACES = ['auth', 'connections', 'missions', 'requests', 'telemetry'] as const;
const GUARDED = Object.entries(MUTATIONS);
const SESSION_GUARDED = GUARDED.filter(([, m]) => m.role !== 'origin-only');

// ── Requests of each caller ─────────────────────────────────────────────────

async function userCookie(root: GatewayRoot, user: UserRecord): Promise<string> {
  const session = await root.auth.sessions.create({
    kind: 'user',
    userId: user.id,
    login: { email: user.email, groups: [] },
  });
  return `${SESSION_COOKIE}=${session.id}`;
}

async function bootstrapCookie(root: GatewayRoot): Promise<string> {
  const session = await root.auth.sessions.create({ kind: 'bootstrap' });
  return `${SESSION_COOKIE}=${session.id}`;
}

/** The session of the caller the endpoint is for. */
async function rightfulCookie(rig: Rig, role: Role): Promise<string> {
  return userCookie(rig.root, role === 'operator' ? rig.operator : rig.seeded.ada);
}

function headersOf(mutation: Mutation, extra: Record<string, string>): Headers {
  return new Headers({ 'content-type': mutation.contentType, ...extra });
}

/** Every row of every table, as text. */
function contentOf(root: GatewayRoot, except: readonly string[] = []): string {
  const tables = root.store.db
    .prepare<[], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((table) => table.name)
    .filter((name) => !except.includes(name));
  return JSON.stringify(
    tables.map((name) => [name, root.store.db.prepare(`SELECT * FROM "${name}"`).all()]),
  );
}

async function refusalOf(response: Response): Promise<{ status: number; error: unknown }> {
  const body: unknown = await response.json();
  const error = typeof body === 'object' && body !== null && 'error' in body ? body.error : null;
  return { status: response.status, error };
}

// ── Completeness of the table ───────────────────────────────────────────────

const MUTATING_METHOD = /export (?:async function|const) (POST|PUT|PATCH|DELETE)\b/;
const DELEGATION = /\(await getRoot\(\)\)\.([a-zA-Z]+\.handlers\.[a-zA-Z]+)\(/g;
/** The execution door authenticates a mission token, not a web session (handbook execution-door). */
const BEARER_DOORS = /^execution\.handlers\./;

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return routeFiles(path);
    return entry.name === 'route.ts' ? [path] : [];
  });
}

const MUTATING_ROUTES = routeFiles(APP)
  .map((path) => ({ name: relative(APP, path), source: readFileSync(path, 'utf8') }))
  .filter((route) => MUTATING_METHOD.test(route.source));

describe('the mutation guard covers every mutating handler', () => {
  let rig: Rig;

  beforeEach(async () => {
    const root = await buildTestRoot({
      env: { VAUBAAN_ADMIN_EMAILS: OPERATOR_EMAIL },
      deps: {
        providerFetch: async () => {
          throw new Error('no provider is reachable from a test');
        },
      },
    });
    const seeded = await seedInstance(root);
    const operator = await root.store.users.upsertFromIdp({
      subject: 'idp|ops',
      email: OPERATOR_EMAIL,
      displayName: 'Ops',
    });
    const base = auditRigOn(root, seeded);
    const mission = await issueMission(base);
    // The pull-request quota is two: the third call is refused and opens a claim.
    const pr = { tool: 'github__create_pull_request', risks: [PR] } as const;
    await seedCall(base, mission, pr);
    await seedCall(base, mission, pr);
    const refused = await seedCall(base, mission, pr);
    if (refused.result.outcome !== 'refused' || !refused.result.request_id) {
      throw new Error('expected the third pull request to open a claim');
    }
    rig = { ...base, operator, mission, claimId: refused.result.request_id };
  });
  afterEach(async () => {
    await rig.root.close();
  });

  it('classifies every handler of the human surfaces', () => {
    const handlers = SURFACES.flatMap((surface) =>
      Object.keys(rig.root[surface].handlers).map((name) => `${surface}.handlers.${name}`),
    );
    const classified = [...Object.keys(MUTATIONS), ...Object.keys(READS)];
    expect(handlers.sort()).toEqual(classified.sort());
  });

  it('finds the mutating routes of the app', () => {
    expect(MUTATING_ROUTES.length).toBeGreaterThanOrEqual(GUARDED.length);
  });

  it.each(MUTATING_ROUTES)('$name delegates to a guarded mutation only', ({ source }) => {
    const delegations = [...source.matchAll(DELEGATION)]
      .map((match) => match[1] ?? '')
      .filter((delegation) => !BEARER_DOORS.test(delegation));
    for (const delegation of delegations) expect(Object.keys(MUTATIONS)).toContain(delegation);
    if (delegations.length === 0) expect(source).toMatch(/\.execution\.handlers\./);
  });

  describe.each(GUARDED)('%s', (_name, mutation) => {
    it('lets the rightful caller through', async () => {
      const cookie = await rightfulCookie(rig, mutation.role);
      const response = await mutation.run(rig, headersOf(mutation, { origin: PUBLIC_URL, cookie }));
      expect(response.status).toBe(mutation.passes);
    });

    it.each([
      ['another origin', { origin: FOREIGN_ORIGIN }],
      ['no Origin and no Referer', {}],
      ['the Referer of another site and no Origin', { referer: `${FOREIGN_ORIGIN}/page` }],
      ['an opaque Origin', { origin: 'null' }],
    ])('refuses %s, and writes nothing', async (_case, origin) => {
      const cookie = await rightfulCookie(rig, mutation.role);
      const before = contentOf(rig.root);
      const response = await mutation.run(rig, headersOf(mutation, { ...origin, cookie }));
      expect(await refusalOf(response)).toEqual({ status: 403, error: 'origin-mismatch' });
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(contentOf(rig.root)).toBe(before);
    });
  });

  describe.each(SESSION_GUARDED)('%s', (_name, mutation) => {
    it('refuses a caller with no session, and writes nothing', async () => {
      const before = contentOf(rig.root);
      const response = await mutation.run(rig, headersOf(mutation, { origin: PUBLIC_URL }));
      expect(await refusalOf(response)).toEqual({ status: 401, error: 'unauthenticated' });
      expect(contentOf(rig.root)).toBe(before);
    });

    it('refuses a session of the wrong role, and writes nothing', async () => {
      // An operator endpoint: a plain user. A user endpoint: the bootstrap operator.
      const cookie =
        mutation.role === 'operator'
          ? await userCookie(rig.root, rig.seeded.ada)
          : await bootstrapCookie(rig.root);
      const before = contentOf(rig.root);
      const response = await mutation.run(rig, headersOf(mutation, { origin: PUBLIC_URL, cookie }));
      expect(await refusalOf(response)).toEqual({ status: 403, error: 'forbidden' });
      expect(contentOf(rig.root)).toBe(before);
    });

    it('refuses a bootstrap session once the token is revoked, and writes nothing', async () => {
      const cookie = await bootstrapCookie(rig.root);
      await rig.root.auth.bootstrap.revoke();
      // The revoked session itself is destroyed; nothing else changes.
      const before = contentOf(rig.root, ['web_sessions']);
      const response = await mutation.run(rig, headersOf(mutation, { origin: PUBLIC_URL, cookie }));
      expect(await refusalOf(response)).toEqual({ status: 401, error: 'unauthenticated' });
      expect(contentOf(rig.root, ['web_sessions'])).toBe(before);
      expect(await rig.root.auth.authenticator.authenticate(new Headers({ cookie }))).toBeNull();
    });
  });
});
