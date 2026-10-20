/**
 * Every mutating handler goes through the one guard (spec §6 "every mutation
 * requires a valid session and an origin check"; `server/auth/guard.ts`).
 *
 * The table below names every handler of the human surfaces. Two
 * structural tests keep it complete: a handler added to a module must be
 * classified (a mutation with its role, a read with the reason, or an OAuth
 * protocol endpoint that reads no session at all), and a route file that
 * exports a mutating HTTP method may only delegate to a handler classified as
 * a mutation, to a protocol endpoint or to an MCP door. Each mutation is then driven over the
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
  /** A consent screen shown to Ada and not answered yet. */
  readonly consentId: string;
  /** A delegation Ada gave to the registered OAuth client. */
  readonly delegationId: string;
  /** `oauth_clients.id` of that client. */
  readonly oauthClientId: string;
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
  'missions.handlers.changePermissions': json('user', 200, (rig, headers) =>
    rig.root.missions.handlers.changePermissions(
      post(`/api/missions/${rig.mission.id}/permissions`, headers, {
        policy: [],
        expected_policy: rig.mission.policy.map((p) => ({
          risk_id: p.riskId,
          quota: p.quota,
          rate_limit: { max: p.rateLimit, window_seconds: p.rateWindowSeconds },
          gate: p.gate,
        })),
      }),
      rig.mission.id,
    ),
  ),
  'missions.handlers.setLimits': json('user', 200, (rig, headers) =>
    rig.root.missions.handlers.setLimits(
      post(`/api/missions/${rig.mission.id}/limits`, headers, {
        limits: [
          {
            risk_id: rig.mission.policy[0]?.riskId,
            quota: (rig.mission.policy[0]?.quota ?? 1) + 1,
            rate_limit: { max: 1 },
          },
        ],
      }),
      rig.mission.id,
    ),
  ),
  'missions.handlers.addMember': json('user', 201, (rig, headers) =>
    rig.root.missions.handlers.addMember(
      post(`/api/missions/${rig.mission.id}/members`, headers, { email: rig.seeded.bob.email }),
      rig.mission.id,
    ),
  ),
  // Nobody is a member yet: the rightful caller reaches the service, which finds none.
  'missions.handlers.removeMember': json('user', 404, (rig, headers) =>
    rig.root.missions.handlers.removeMember(
      post(`/api/missions/${rig.mission.id}/members/none/remove`, headers, {}),
      rig.mission.id,
      'none',
    ),
  ),
  'missions.handlers.generateToken': json('user', 200, (rig, headers) =>
    rig.root.missions.handlers.generateToken(
      post(`/api/missions/${rig.mission.id}/tokens/mine`, headers, {}),
      rig.mission.id,
    ),
  ),
  'missions.handlers.createNamedToken': json('user', 201, (rig, headers) =>
    rig.root.missions.handlers.createNamedToken(
      post(`/api/missions/${rig.mission.id}/tokens`, headers, { name: 'CI runner' }),
      rig.mission.id,
    ),
  ),
  // No such token: the rightful caller reaches the service, which finds none.
  'missions.handlers.revokeToken': json('user', 404, (rig, headers) =>
    rig.root.missions.handlers.revokeToken(
      post(`/api/missions/${rig.mission.id}/tokens/none/revoke`, headers, {}),
      rig.mission.id,
      'none',
    ),
  ),
  'missions.handlers.replaceNamedToken': json('user', 404, (rig, headers) =>
    rig.root.missions.handlers.replaceNamedToken(
      post(`/api/missions/${rig.mission.id}/tokens/none/replace`, headers, {}),
      rig.mission.id,
      'none',
    ),
  ),
  // The rightful caller is the creator, who cannot leave: the service answers 409.
  'missions.handlers.leave': json('user', 409, (rig, headers) =>
    rig.root.missions.handlers.leave(
      post(`/api/missions/${rig.mission.id}/leave`, headers, {}),
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
      post('/accounts/connect/vercel', headers, { name: 'Another', 'field.token': 'k' }),
      'vercel',
    ),
  ),
  'connections.handlers.discover': form('user', 303, (rig, headers) =>
    rig.root.connections.handlers.discover(
      post(`/accounts/${rig.seeded.github.connection.id}/discover`, headers, {}),
      rig.seeded.github.connection.id,
    ),
  ),
  'connections.handlers.revoke': form('user', 303, (rig, headers) =>
    rig.root.connections.handlers.revoke(
      post(`/accounts/${rig.seeded.vercel.connection.id}/revoke`, headers, {}),
      rig.seeded.vercel.connection.id,
    ),
  ),
  'connections.handlers.updateResource': form('user', 303, (rig, headers) => {
    const connectionId = rig.seeded.github.connection.id;
    const resourceId = rig.seeded.github.resources[0]?.id ?? 'missing';
    return rig.root.connections.handlers.updateResource(
      post(`/accounts/${connectionId}/resources/${resourceId}`, headers, {
        display_name: 'Renamed',
      }),
      connectionId,
      resourceId,
    );
  }),
  'connections.handlers.setDefaultEnv': form('user', 303, (rig, headers) =>
    rig.root.connections.handlers.setDefaultEnv(
      post(`/accounts/${rig.seeded.github.connection.id}/default-env`, headers, {
        default_env: '',
      }),
      rig.seeded.github.connection.id,
    ),
  ),
  'connections.handlers.transfer': form('user', 303, (rig, headers) =>
    rig.root.connections.handlers.transfer(
      post(`/accounts/${rig.seeded.github.connection.id}/transfer`, headers, {
        group_id: 'no-such-group',
      }),
      rig.seeded.github.connection.id,
    ),
  ),
  'connections.handlers.reassign': form('operator', 303, (rig, headers) =>
    rig.root.connections.handlers.reassign(
      post(`/admin/connections/${rig.seeded.github.connection.id}/reassign`, headers, {
        owner_kind: 'user',
        owner_email: OPERATOR_EMAIL,
      }),
      rig.seeded.github.connection.id,
    ),
  ),
  'shares.handlers.share': form('user', 303, (rig, headers) =>
    rig.root.shares.handlers.share(
      post(`/accounts/${rig.seeded.github.connection.id}/shares`, headers, {
        target_kind: 'user',
        target_email: OPERATOR_EMAIL,
        risk: PR,
      }),
      rig.seeded.github.connection.id,
    ),
  ),
  'shares.handlers.revoke': form('user', 303, (rig, headers) =>
    rig.root.shares.handlers.revoke(
      post(`/accounts/${rig.seeded.github.connection.id}/shares/none/revoke`, headers, {}),
      rig.seeded.github.connection.id,
      'none',
    ),
  ),
  'groups.handlers.create': form('operator', 303, (rig, headers) =>
    rig.root.groups.handlers.create(post('/admin/groups/create', headers, { name: 'platform' })),
  ),
  'groups.handlers.addMember': form('operator', 303, (rig, headers) =>
    rig.root.groups.handlers.addMember(
      post('/admin/groups/none/members', headers, { email: OPERATOR_EMAIL }),
      'none',
    ),
  ),
  'groups.handlers.removeMember': form('operator', 303, (rig, headers) =>
    rig.root.groups.handlers.removeMember(
      post(`/admin/groups/none/members/${rig.seeded.ada.id}/remove`, headers, {}),
      'none',
      rig.seeded.ada.id,
    ),
  ),
  'users.handlers.deactivate': form('operator', 303, (rig, headers) =>
    rig.root.users.handlers.deactivate(
      post(`/admin/users/${rig.seeded.bob.id}/deactivate`, headers, {}),
      rig.seeded.bob.id,
    ),
  ),
  'users.handlers.endSessions': form('operator', 303, (rig, headers) =>
    rig.root.users.handlers.endSessions(
      post(`/admin/users/${rig.seeded.bob.id}/end-sessions`, headers, {}),
      rig.seeded.bob.id,
    ),
  ),
  'users.handlers.signOutEverywhere': form('user', 303, (rig, headers) =>
    rig.root.users.handlers.signOutEverywhere(post('/logout/everywhere', headers, {})),
  ),
  'users.handlers.reactivate': form('operator', 303, (rig, headers) =>
    rig.root.users.handlers.reactivate(post('/admin/users/none/reactivate', headers, {}), 'none'),
  ),
  'users.handlers.invite': form('operator', 303, (rig, headers) =>
    rig.root.users.handlers.invite(
      post('/admin/users/invitations', headers, { email: 'guest@example.org' }),
    ),
  ),
  'users.handlers.createFirstAdministrator': form('operator', 303, (rig, headers) =>
    rig.root.users.handlers.createFirstAdministrator(
      post('/admin/users/first-administrator', headers, {
        email: 'ops@example.com',
        password: 'a sentence long enough',
        password_again: 'a sentence long enough',
      }),
    ),
  ),
  'users.handlers.makeAdministrator': form('operator', 303, (rig, headers) =>
    rig.root.users.handlers.makeAdministrator(
      post('/admin/users/none/make-administrator', headers, {}),
      'none',
    ),
  ),
  'users.handlers.unmakeAdministrator': form('operator', 303, (rig, headers) =>
    rig.root.users.handlers.unmakeAdministrator(
      post('/admin/users/none/unmake-administrator', headers, {}),
      'none',
    ),
  ),
  'users.handlers.addAdministratorGroup': form('operator', 303, (rig, headers) =>
    rig.root.users.handlers.addAdministratorGroup(
      post('/admin/users/administrators/group', headers, { provider: 'none', group: 'g' }),
    ),
  ),
  'users.handlers.removeAdministratorDesignation': form('operator', 303, (rig, headers) =>
    rig.root.users.handlers.removeAdministratorDesignation(
      post('/admin/users/administrators/remove', headers, { designation: 'none' }),
    ),
  ),
  'users.handlers.applyConfigurationRule': form('operator', 303, (rig, headers) =>
    rig.root.users.handlers.applyConfigurationRule(
      post('/admin/users/administrators/apply-configuration', headers, {}),
    ),
  ),
  'users.handlers.finishSetup': form('operator', 303, (rig, headers) =>
    rig.root.users.handlers.finishSetup(post('/api/admin/setup/finish', headers, {})),
  ),
  'users.handlers.resetSecondFactor': form('operator', 303, (rig, headers) =>
    rig.root.users.handlers.resetSecondFactor(
      post('/admin/users/none/reset-second-factor', headers, {}),
      'none',
    ),
  ),
  'users.handlers.accountLink': form('operator', 303, (rig, headers) =>
    rig.root.users.handlers.accountLink(
      post('/admin/users/local-link', headers, { kind: 'invite', email: 'guest@example.org' }),
    ),
  ),
  'users.handlers.removeInvitation': form('operator', 303, (rig, headers) =>
    rig.root.users.handlers.removeInvitation(
      post('/admin/users/invitations/remove', headers, { email: 'nobody@example.org' }),
    ),
  ),
  'auth.handlers.enableSignInProvider': form('operator', 303, (rig, headers) =>
    rig.root.auth.handlers.enableSignInProvider(
      post('/api/admin/sign-in-providers/none/enable', headers, {}),
      'none',
    ),
  ),
  'auth.handlers.disableSignInProvider': form('operator', 303, (rig, headers) =>
    rig.root.auth.handlers.disableSignInProvider(
      post('/api/admin/sign-in-providers/none/disable', headers, {}),
      'none',
    ),
  ),
  'auth.handlers.makeAdministratorFromTest': form('operator', 303, (rig, headers) =>
    rig.root.auth.handlers.makeAdministratorFromTest(
      post('/api/admin/sign-in-providers/none/test/administrator', headers, {}),
      'none',
    ),
  ),
  'auth.handlers.removeSignInProvider': form('operator', 303, (rig, headers) =>
    rig.root.auth.handlers.removeSignInProvider(
      post('/api/admin/sign-in-providers/none/remove', headers, {}),
      'none',
    ),
  ),
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
  'instance.handlers.setName': form('operator', 303, (rig, headers) =>
    rig.root.instance.handlers.setName(
      post('/api/admin/instance-name', headers, { name: 'Dalae prod' }),
    ),
  ),
  // The rightful caller's session was just created: fresh, so the file is handed over.
  'masterKey.handlers.download': form('operator', 200, (rig, headers) =>
    rig.root.masterKey.handlers.download(
      post('/api/admin/master-key/download', headers, { from: 'settings', confirmed: 'on' }),
    ),
  ),
  'masterKey.handlers.confirmHandover': form('operator', 303, (rig, headers) =>
    rig.root.masterKey.handlers.confirmHandover(
      post('/api/admin/master-key/handed-over', headers, { confirmed: 'on' }),
    ),
  ),
  'oauth.handlers.decide': form('user', 303, (rig, headers) =>
    rig.root.oauth.handlers.decide(
      post('/oauth/authorize/decision', headers, { consent: rig.consentId, decision: 'approve' }),
    ),
  ),
  'oauth.handlers.revokeDelegation': form('user', 303, (rig, headers) =>
    rig.root.oauth.handlers.revokeDelegation(
      post(`/settings/connected-apps/${rig.delegationId}/revoke`, headers, {}),
      rig.delegationId,
    ),
  ),
  'oauth.handlers.decideClient': form('operator', 303, (rig, headers) =>
    rig.root.oauth.handlers.decideClient(
      post(`/admin/oauth-clients/${rig.oauthClientId}`, headers, { action: 'disable' }),
      rig.oauthClientId,
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
  // The forms of the local accounts (ADR local-accounts-sign-in-provider): no session
  // to ride, an origin check and a window each; a refusal is a redirect with a code.
  'auth.handlers.passwordLogin': form('origin-only', 303, (rig, headers) =>
    rig.root.auth.handlers.passwordLogin(
      post('/auth/local/local', headers, { email: 'ada@example.com', password: 'x' }),
      'local',
    ),
  ),
  'auth.handlers.createAccount': form('origin-only', 303, (rig, headers) =>
    rig.root.auth.handlers.createAccount(
      post('/api/account/create', headers, {
        token: 'not-a-link',
        password: 'a sentence long enough',
        password_again: 'a sentence long enough',
      }),
    ),
  ),
  'auth.handlers.resetPassword': form('origin-only', 303, (rig, headers) =>
    rig.root.auth.handlers.resetPassword(
      post('/api/account/reset', headers, {
        token: 'not-a-link',
        password: 'a sentence long enough',
        password_again: 'a sentence long enough',
      }),
    ),
  ),
  'auth.handlers.forgotPassword': form('origin-only', 303, (rig, headers) =>
    rig.root.auth.handlers.forgotPassword(
      post('/api/account/forgot', headers, { email: 'ada@example.com' }),
    ),
  ),
  'auth.handlers.secondFactorLogin': form('origin-only', 303, (rig, headers) =>
    rig.root.auth.handlers.secondFactorLogin(
      post('/auth/local/local/code', headers, { code: '000000' }),
      'local',
    ),
  ),
  'auth.handlers.enrolAtSignIn': form('origin-only', 303, (rig, headers) =>
    rig.root.auth.handlers.enrolAtSignIn(
      post('/auth/local/local/enrol', headers, { code: '000000' }),
      'local',
    ),
  ),
  // Settings → Security: a signed-in user's own password and second factor. The rig's
  // users signed in through the directory, so each answers "not a local account" (303).
  'auth.handlers.beginSecondFactor': form('user', 303, (rig, headers) =>
    rig.root.auth.handlers.beginSecondFactor(
      post('/settings/security/second-factor/begin', headers, {}),
    ),
  ),
  'auth.handlers.confirmSecondFactor': form('user', 303, (rig, headers) =>
    rig.root.auth.handlers.confirmSecondFactor(
      post('/settings/security/second-factor/confirm', headers, { code: '000000' }),
    ),
  ),
  'auth.handlers.removeSecondFactor': form('user', 303, (rig, headers) =>
    rig.root.auth.handlers.removeSecondFactor(
      post('/settings/security/second-factor/remove', headers, {}),
    ),
  ),
  'auth.handlers.changePassword': form('user', 303, (rig, headers) =>
    rig.root.auth.handlers.changePassword(
      post('/settings/security/password', headers, {
        current_password: 'x',
        password: 'a sentence long enough',
        password_again: 'a sentence long enough',
      }),
    ),
  ),
};

/** Handlers that change nothing on behalf of a browser form or script: why they have no origin check. */
const READS: Readonly<Record<string, string>> = {
  'auth.handlers.loginStart': 'GET; starts a sign-in, the pending login is bound to a cookie',
  'auth.handlers.loginCallback': 'GET from the IdP; protected by the single-use state and PKCE',
  'auth.handlers.testStart':
    'GET; starts a test of a provider for an administrator (authorizeAdmin), bound to their session; its callback signs nobody in',
  'connections.handlers.callback':
    'GET from the provider; protected by the single-use state bound to the user (guardSession)',
  'requests.handlers.open': 'GET; redirects or refuses, rate-limited (guardSession)',
  'requests.handlers.inbox': 'GET; reads the caller’s inbox (guardSession)',
  'oauth.handlers.authorize':
    'GET; shows the consent screen and stores what it showed, bound to the signed-in user',
  'oauth.handlers.authorizationServerMetadata': 'GET; public discovery document (RFC 8414)',
  'oauth.handlers.protectedResourceMetadata': 'GET; public discovery document (RFC 9728)',
};

/**
 * Endpoints OAuth clients call, not browsers on behalf of a session: they read
 * no cookie, so there is no ambient authority for another origin to ride. What
 * authenticates each request is what it carries (handbook management-door);
 * `tests/integration/oauth-as` asserts that a session cookie changes nothing.
 */
const PROTOCOL_ENDPOINTS: Readonly<Record<string, string>> = {
  'oauth.handlers.register': 'RFC 7591; unauthenticated by design, policy and rate limit apply',
  'oauth.handlers.token': 'RFC 6749; authenticated by the code or refresh token and the client',
  'oauth.handlers.revoke': 'RFC 7009; authenticated by the client and the token itself',
};

const SURFACES = [
  'auth',
  'connections',
  'missions',
  'requests',
  'telemetry',
  'instance',
  'masterKey',
  'shares',
  'groups',
  'users',
  'oauth',
] as const;
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
/**
 * The MCP doors authenticate a bearer, not a web session: a mission token at
 * the execution door (handbook execution-door), a delegated token at the
 * management door (handbook management-door).
 */
const BEARER_DOORS = /^(?:execution|management)\.handlers\./;

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

/** The setup route is one of them, so its exemption below names a route that exists. */
const SETUP_ROUTE_PRESENT = MUTATING_ROUTES.some(
  (route) => route.name === 'api/setup/master-key/route.ts',
);

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
      issuer: 'http://idp.test',
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
    const oauthClient = await root.store.delegations.registerClient({
      clientId: 'vbn_client_guard',
      name: 'Guard test client',
      redirectUris: ['http://127.0.0.1/callback'],
    });
    const delegation = await root.store.delegations.create({
      userId: seeded.ada.id,
      clientId: oauthClient.id,
      scope: 'mgmt',
    });
    const consentId = await root.oauth.authorization.createPending(seeded.ada, {
      client: oauthClient,
      redirectUri: 'http://127.0.0.1/callback',
      state: 'guard-state',
      codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    });
    rig = {
      ...base,
      operator,
      mission,
      claimId: refused.result.request_id,
      consentId,
      delegationId: delegation.id,
      oauthClientId: oauthClient.id,
    };
  });
  afterEach(async () => {
    await rig.root.close();
  });

  it('classifies every handler of the human surfaces', () => {
    const handlers = SURFACES.flatMap((surface) =>
      Object.keys(rig.root[surface].handlers).map((name) => `${surface}.handlers.${name}`),
    );
    const classified = [
      ...Object.keys(MUTATIONS),
      ...Object.keys(READS),
      ...Object.keys(PROTOCOL_ENDPOINTS),
    ];
    expect(handlers.sort()).toEqual(classified.sort());
  });

  it('finds the mutating routes of the app, the setup route among them', () => {
    expect(MUTATING_ROUTES.length).toBeGreaterThanOrEqual(GUARDED.length);
    expect(SETUP_ROUTE_PRESENT).toBe(true);
  });

  /**
   * Setup mode has no store, so no session: the route is authenticated by the
   * bootstrap token of the configuration, origin-checked, throttled
   * (`server/setup/handlers.ts`; `tests/integration/compose/setup-mode-restore.test.ts`).
   */
  const SETUP_ROUTES = ['api/setup/master-key/route.ts'];

  it.each(MUTATING_ROUTES.filter((route) => !SETUP_ROUTES.includes(route.name)))(
    '$name delegates to a guarded mutation only',
    ({ source }) => {
      const delegations = [...source.matchAll(DELEGATION)]
        .map((match) => match[1] ?? '')
        .filter(
          (delegation) => !BEARER_DOORS.test(delegation) && !(delegation in PROTOCOL_ENDPOINTS),
        );
      for (const delegation of delegations) expect(Object.keys(MUTATIONS)).toContain(delegation);
      if (delegations.length === 0) {
        expect(source).toMatch(
          /\.(?:execution|management)\.handlers\.|\.oauth\.handlers\.(?:register|token|revoke)\(/,
        );
      }
    },
  );

  describe.each(Object.keys(PROTOCOL_ENDPOINTS))('%s', (name) => {
    const method = name.slice(name.lastIndexOf('.') + 1) as 'register' | 'token' | 'revoke';
    const request = (headers: Record<string, string>): Request =>
      new Request(`${PUBLIC_URL}/oauth/${method}`, {
        method: 'POST',
        headers:
          method === 'register'
            ? { 'content-type': JSON_TYPE, ...headers }
            : { 'content-type': FORM_TYPE, ...headers },
        // Well-formed, and naming nothing that exists: refused on its content alone.
        body: method === 'register' ? '{}' : 'client_id=vbn_client_unknown&token=x&grant_type=x',
      });

    it('reads no session: an operator’s cookie changes nothing, from any origin', async () => {
      const cookie = await userCookie(rig.root, rig.operator);
      const before = contentOf(rig.root);
      const bare = await rig.root.oauth.handlers[method](request({}));
      const withSession = await rig.root.oauth.handlers[method](
        request({ cookie, origin: FOREIGN_ORIGIN }),
      );
      expect(bare.status).toBeGreaterThanOrEqual(400);
      expect(withSession.status).toBe(bare.status);
      expect(await withSession.json()).toEqual(await bare.json());
      expect(contentOf(rig.root)).toBe(before);
    });
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
