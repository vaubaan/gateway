/**
 * What the demo instance contains on first load, created the way its users
 * would have created it: through the real sign-in, the real connect flows
 * (against the simulated providers), the mission, share and group services,
 * the OAuth authorization server, and tool calls through the execution door.
 * Nothing is written to the store directly, so every state shown is one the
 * application itself can reach:
 *
 *   Alice (operator)  five connections — a GitHub organisation, a second one
 *                     transferred to the local group "GitHub admins", Upstash
 *                     Redis (databases labelled prod / staging), Resend (the
 *                     production domain left without a label, which the
 *                     mission form warns about), Cloudflare DNS; a share of
 *                     the first GitHub connection to Bob; missions in every
 *                     state: active with a session of calls under two agent
 *                     labels, quota spent with an open claim, an open approval
 *                     request, expired, revoked, issued by a delegated client;
 *                     a fresh mission with a small limit for the tour.
 *   Bob               the share received and a mission issued within it.
 *   Carol             member of "GitHub admins"; a Stripe account of her own
 *                     (test and live), its test mode shared to Alice.
 *
 * Everything runs in the process, on the root's host-agnostic handlers
 * (`Request → Response`): no browser and no HTTP round trip to the pages.
 */
import { isSecondFactorStep, passSecondFactor } from '../support/auth/testing';
import { randomBytes } from 'node:crypto';

import type { MissionPolicyEntry, RiskId } from '@vaubaan/shared';

import { LOGIN_COOKIE, SESSION_COOKIE } from '../../src/server/auth';
import type { GatewayRoot } from '../../src/server/compose/root';
import type { Actor } from '../../src/server/connections';
import type { MissionDraft } from '../../src/server/missions';
import {
  challengeOf,
  CONSENT_DECISION_PATH,
  CONSENT_FIELD,
  DECISION_FIELD,
  type TokenResponse,
} from '../../src/server/oauth-as';
import type { ConnectionRecord, UserRecord } from '../../src/server/store/types';
import type { DemoIdp } from './demo-idp';
import {
  ALICE,
  BOB,
  CAROL,
  CONTRACTORS_GROUP,
  GITHUB_ADMINS_GROUP,
  type DemoPerson,
} from './people';
import {
  DEMO_GITHUB_TOKENS,
  githubTokenFields,
  type DemoGithubToken,
  DEMO_REDIS_DATABASES,
  DEMO_RESEND_DOMAINS,
  type DemoProviders,
} from './providers';

const DAY_SECONDS = 86_400;
/** Quota of the tour's "exhaust it yourself" mission, and of the seeded exhausted one. */
export const SMALL_QUOTA = 3;
/** The loopback redirect of the seeded delegated client (an agent on the user's machine). */
const AGENT_REDIRECT = 'http://127.0.0.1:43210/callback';
const AGENT_USER_AGENT = 'claude-code/2.1 (demo seed)';
/** The named token of the seeded team mission: a machine with no account. */
export const CI_TOKEN_NAME = 'CI runner';

export interface SeedContext {
  readonly root: GatewayRoot;
  readonly idp: DemoIdp;
  readonly providers: DemoProviders;
}

export interface SeededMission {
  readonly id: string;
  readonly name: string;
  /** The mission token, shown once at issuance; the tour prints two of them. */
  readonly token: string;
}

export interface SeedSummary {
  /** Active mission of Alice with a session of calls: the tour's `tools/list` target. */
  readonly activeMission: SeededMission;
  /** Fresh mission of Alice with `SMALL_QUOTA` reads: the tour's quota loop. */
  readonly quotaMission: SeededMission;
  /** The repository the tour's commands read. */
  readonly repository: { readonly owner: string; readonly repo: string };
  /** `<public_url>/r/<id>` of the open claim and of the open approval request. */
  readonly openClaimUrl: string;
  readonly openApprovalUrl: string;
  /** The gated call waiting for Alice's approval, to replay once she approved it. */
  readonly approval: {
    readonly mission: SeededMission;
    readonly tool: string;
    readonly arguments: Record<string, unknown>;
  };
  /** The GitHub connection Alice shares to Bob, for the share steps of the tour. */
  readonly sharedConnection: { readonly id: string; readonly name: string };
  /**
   * The team on the active mission (spec §7.9 bis): Bob is a member and has
   * generated his own token; "CI runner" is a named token Alice created. Both
   * made calls, so the session and the audit attribute them.
   */
  readonly team: {
    readonly mission: { readonly id: string; readonly name: string };
    readonly member: { readonly email: string };
    /** The named token, shown once to Alice when she created it. */
    readonly named: { readonly name: string; readonly token: string };
  };
  readonly counts: { readonly connections: number; readonly missions: number };
}

interface SignedIn {
  readonly person: DemoPerson;
  readonly user: UserRecord;
  /** `<SESSION_COOKIE>=<id>`, as the browser would send it. */
  readonly cookie: string;
}

function fail(what: string, detail: unknown): never {
  throw new Error(
    `demo seed: ${what}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`,
  );
}

function cookieOf(response: Response, name: string): string {
  for (const header of response.headers.getSetCookie()) {
    const [pair = ''] = header.split(';');
    const [key, value] = pair.split('=');
    if (key?.trim() === name && value) return `${name}=${value.trim()}`;
  }
  return fail(`no ${name} cookie`, `${response.status} ${response.headers.get('location') ?? ''}`);
}

const line = (
  risk_id: RiskId,
  quota: number,
  gate: MissionPolicyEntry['gate'] = 'auto',
): MissionPolicyEntry => ({ risk_id, quota, rate_limit: { max: 60, window_seconds: 60 }, gate });

class Seeder {
  private readonly origin: string;
  private rpcId = 0;

  constructor(private readonly ctx: SeedContext) {
    this.origin = ctx.root.config.publicUrl.href.replace(/\/$/, '');
  }

  /** The real sign-in: `/auth/login`, the IdP's consent for `person`, `/auth/callback/idp`. */
  async signIn(person: DemoPerson): Promise<SignedIn> {
    const { handlers, authenticator } = this.ctx.root.auth;
    const started = await handlers.loginStart(
      new Request(`${this.origin}/auth/login?return_to=/missions`),
    );
    const authorization = started.headers.get('location');
    if (!authorization) fail('sign-in did not start', started.status);
    const pending = cookieOf(started, LOGIN_COOKIE);
    const callback = this.ctx.idp.consent(new URL(authorization), person);
    let finished = await handlers.loginCallback(
      new Request(callback, { headers: { cookie: pending } }),
      'idp',
    );
    if (isSecondFactorStep(finished)) {
      // An administrator gives the gateway's own second factor, as their app would.
      const step = cookieOf(finished, LOGIN_COOKIE);
      finished = (await passSecondFactor(this.ctx.root, this.origin, step)) ?? finished;
    }
    const cookie = cookieOf(finished, SESSION_COOKIE);
    const principal = await authenticator.authenticate(new Headers({ cookie }));
    if (principal?.kind !== 'user') fail('sign-in produced no user session', person.email);
    return { person, user: principal.user, cookie };
  }

  /** The user with their current groups, as a page builds it. */
  async actor(user: UserRecord): Promise<Actor> {
    return { user, groups: await this.ctx.root.store.groups.groupsOf(user.id) };
  }

  /** Pastes one of the simulated GitHub's fine-grained tokens. */
  async connectGithub(user: UserRecord, token: DemoGithubToken, name: string) {
    return this.connectWithKey(user, 'github', name, githubTokenFields(token));
  }

  async connectWithKey(
    user: UserRecord,
    provider: string,
    name: string,
    fields: Record<string, string>,
  ): Promise<ConnectionRecord> {
    const actor = await this.actor(user);
    const result = await this.ctx.root.connections.service.start(actor, provider, {
      displayName: name,
      fields,
    });
    if (result.kind !== 'connected') fail(`${provider} connect did not complete`, result.kind);
    return result.connection;
  }

  /** Labels resources of a connection, by ref. */
  async label(user: UserRecord, connection: ConnectionRecord, envByRef: Record<string, string>) {
    const actor = await this.actor(user);
    const { service } = this.ctx.root.connections;
    const detail = await service.get(actor, connection.id);
    for (const resource of detail.resources) {
      const env = envByRef[resource.ref];
      if (env) await service.updateResource(actor, connection.id, resource.id, { env });
    }
  }

  async issue(user: UserRecord, draft: MissionDraft): Promise<SeededMission> {
    const issued = await this.ctx.root.missions.service.issue(user, draft);
    if (!issued.ok) {
      fail(
        `mission "${draft.name}" refused`,
        issued.reason === 'refused' ? issued.preview.issues : issued.reason,
      );
    }
    return { id: issued.mission.id, name: draft.name, token: issued.token.secret };
  }

  /**
   * One `tools/call` through the execution door, as an agent holding the
   * mission token makes it. Returns the refusal (`error.data`) or `null`.
   */
  async call(
    mission: SeededMission,
    label: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    const response = await this.ctx.root.execution.handlers.mcp(
      this.rpc(
        `${this.origin}/mcp`,
        mission.token,
        'tools/call',
        { name: tool, arguments: args },
        {
          'x-vaubaan-agent': label,
        },
      ),
    );
    const body = (await response.json()) as {
      result?: { isError?: boolean; content?: unknown };
      error?: { message?: string; data?: Record<string, unknown> };
    };
    if (body.error) {
      if (body.error.data && typeof body.error.data.code === 'string') return body.error.data;
      fail(`${tool} on "${mission.name}"`, body.error);
    }
    if (body.result?.isError) fail(`${tool} on "${mission.name}" failed upstream`, body.result);
    return null;
  }

  private rpc(
    url: string,
    bearer: string,
    method: string,
    params: Record<string, unknown>,
    headers: Record<string, string> = {},
  ): Request {
    this.rpcId += 1;
    return new Request(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'user-agent': AGENT_USER_AGENT,
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: this.rpcId, method, params }),
    });
  }

  /**
   * An MCP client on the user's machine obtains a delegation through the real
   * OAuth flow (dynamic registration, the consent screen answered with the
   * user's session, the code exchange), then issues a mission on the
   * management door.
   */
  async issueByDelegation(human: SignedIn, clientName: string, draft: MissionDraft) {
    const { handlers } = this.ctx.root.oauth;
    const registered = await handlers.register(
      new Request(`${this.origin}/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_name: clientName,
          redirect_uris: [AGENT_REDIRECT],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
        }),
      }),
    );
    if (registered.status !== 201) fail('client registration', await registered.text());
    const { client_id: clientId } = (await registered.json()) as { client_id: string };

    const verifier = randomBytes(32).toString('base64url');
    const authorization = new URL(`${this.origin}/oauth/authorize`);
    for (const [name, value] of Object.entries({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: AGENT_REDIRECT,
      code_challenge: challengeOf(verifier),
      code_challenge_method: 'S256',
      state: randomBytes(8).toString('hex'),
      scope: 'mgmt',
      resource: `${this.origin}/mcp/manage`,
    })) {
      authorization.searchParams.set(name, value);
    }
    const consentScreen = await handlers.authorize(
      new Request(authorization, { headers: { cookie: human.cookie } }),
    );
    const html = await consentScreen.text();
    const consentId = new RegExp(`name="${CONSENT_FIELD}" value="([^"]+)"`).exec(html)?.[1];
    if (consentScreen.status !== 200 || !consentId) fail('no consent screen', consentScreen.status);
    const decided = await handlers.decide(
      new Request(`${this.origin}${CONSENT_DECISION_PATH}`, {
        method: 'POST',
        headers: {
          cookie: human.cookie,
          origin: this.ctx.root.config.publicUrl.origin,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ [CONSENT_FIELD]: consentId, [DECISION_FIELD]: 'approve' }),
      }),
    );
    const code = new URL(decided.headers.get('location') ?? AGENT_REDIRECT).searchParams.get(
      'code',
    );
    if (!code) fail('consent not approved', decided.status);
    const exchanged = await handlers.token(
      new Request(`${this.origin}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: clientId,
          code,
          code_verifier: verifier,
          redirect_uri: AGENT_REDIRECT,
        }),
      }),
    );
    if (exchanged.status !== 200) fail('code exchange', await exchanged.text());
    const tokens = (await exchanged.json()) as TokenResponse;

    const answered = await this.ctx.root.management.handlers.mcp(
      this.rpc(`${this.origin}/mcp/manage`, tokens.access_token, 'tools/call', {
        name: 'issue_mission',
        arguments: draft,
      }),
    );
    const body = (await answered.json()) as {
      result?: { isError?: boolean; structuredContent?: unknown };
      error?: unknown;
    };
    if (body.error || body.result?.isError) fail('issue_mission by delegation', body);
  }
}

export async function seedDemo(ctx: SeedContext): Promise<SeedSummary> {
  const { root } = ctx;
  const seeder = new Seeder(ctx);
  const recurring = { kind: 'recurring', length_seconds: DAY_SECONDS } as const;

  // ── People: the first sign-in of each is what creates the account ──────────
  const alice = await seeder.signIn(ALICE);
  const bob = await seeder.signIn(BOB);
  const carol = await seeder.signIn(CAROL);

  // ── Local groups, kept by the operator (Administration → Groups) ───────────
  const admins = await root.groups.service.create(alice.user.id, GITHUB_ADMINS_GROUP);
  await root.groups.service.addMember(alice.user.id, admins.id, alice.user.email);
  await root.groups.service.addMember(alice.user.id, admins.id, carol.user.email);
  const contractors = await root.groups.service.create(alice.user.id, CONTRACTORS_GROUP);
  await root.groups.service.addMember(alice.user.id, contractors.id, bob.user.email);

  // ── Alice's connections ────────────────────────────────────────────────────
  const [product, platform] = DEMO_GITHUB_TOKENS;
  if (!product || !platform) fail('the simulated GitHub has fewer than two tokens', 0);
  const github = await seeder.connectGithub(alice.user, product, 'Acme product repositories');
  const platformGithub = await seeder.connectGithub(
    alice.user,
    platform,
    'Acme platform repositories',
  );
  await root.connections.service.transfer(
    await seeder.actor(alice.user),
    platformGithub.id,
    admins.id,
  );

  const redis = await seeder.connectWithKey(alice.user, 'upstash-redis', 'Acme cache', {
    email: ALICE.email,
    api_key: 'demo-upstash-management-key',
  });
  const [prodCache, stagingCache] = DEMO_REDIS_DATABASES;
  await seeder.label(alice.user, redis, {
    [prodCache.database_id]: 'prod',
    [stagingCache.database_id]: 'staging',
  });

  // The production sending domain keeps no label: the mission form and the
  // share dialog warn that environment-scoped risks are refused on it.
  const resend = await seeder.connectWithKey(alice.user, 'resend', 'Acme transactional mail', {
    api_key: 're_demo_AcmeTransactionalMail',
  });
  await seeder.label(alice.user, resend, { [DEMO_RESEND_DOMAINS[1].name]: 'staging' });

  const cloudflare = await seeder.connectWithKey(alice.user, 'cloudflare-dns', 'Acme DNS', {
    api_token: 'demo-cloudflare-token-0123456789',
  });

  // ── Carol: a Stripe account of her own, its test mode shared to Alice ──────
  const stripe = await seeder.connectWithKey(carol.user, 'stripe', 'Acme billing', {
    test_key: 'sk_test_demoAcmeBilling',
    live_key: 'sk_live_demoAcmeBilling',
  });
  await root.shares.service.share(await seeder.actor(carol.user), stripe.id, {
    target: { kind: 'user', email: alice.user.email },
    riskIds: [
      'stripe[test].read-catalog',
      'stripe[test].read-billing-history',
      'stripe[test].catalog-write',
    ],
  });

  // ── A share to Bob, restricted to five risks of the GitHub catalog ─────────
  await root.shares.service.share(await seeder.actor(alice.user), github.id, {
    target: { kind: 'user', email: bob.user.email },
    riskIds: [
      'github.read-code',
      'github.read-meta',
      'github.feature-branch-write',
      'github.create-pr',
      'github.comment-write',
    ],
  });

  // ── Alice's missions ───────────────────────────────────────────────────────
  const [owner = '', repo = ''] = (product.repositories[0] ?? '').split('/');
  const repository = { owner, repo };
  const onRepos = (refs: readonly string[]) =>
    ({ scope: 'selected', resource_refs: [...refs] }) as const;

  // Issued first: it is expired by the time the seed ends (see the wait below).
  const expiresAt = new Date(Date.now() + 2_000);
  await seeder.issue(alice.user, {
    name: 'Migration dry-run (finished)',
    connections: [
      { connection_id: github.id, resources: { scope: 'all' }, trust_levels: { read: 'careful' } },
    ],
    period: { kind: 'one-off' },
    expires_at: expiresAt.toISOString(),
  });

  const active = await seeder.issue(alice.user, {
    name: 'Ship the billing page',
    connections: [
      {
        connection_id: github.id,
        resources: onRepos(product.repositories.slice(0, 2)),
        policy: [
          line('github.read-code', 500),
          line('github.read-meta', 500),
          line('github.feature-branch-write', 100),
          line('github.create-pr', 10),
          line('github.comment-write', 50),
        ],
      },
      {
        connection_id: redis.id,
        resources: onRepos([stagingCache.database_id]),
        policy: [
          line('upstash-redis.read-database-metadata', 50),
          line('upstash-redis.read-data', 500),
          line('upstash-redis[staging].write-data', 100),
        ],
      },
    ],
    period: recurring,
    expires_at: null,
  });

  const exhausted = await seeder.issue(alice.user, {
    name: 'Nightly dependency audit',
    connections: [
      {
        connection_id: github.id,
        resources: { scope: 'all' },
        policy: [line('github.read-code', SMALL_QUOTA), line('github.read-meta', 50)],
      },
    ],
    period: recurring,
    expires_at: null,
  });

  const gated = await seeder.issue(alice.user, {
    name: 'Release 2.4 hotfix',
    connections: [
      {
        connection_id: github.id,
        resources: onRepos([product.repositories[0] ?? '']),
        // Ship at Trusting: merges, tags and releases ask first; reads run freely.
        trust_levels: { read: 'trusting', propose: 'careful', ship: 'trusting' },
      },
    ],
    period: recurring,
    expires_at: null,
  });

  const revoked = await seeder.issue(alice.user, {
    name: 'Spike: move the status page DNS',
    connections: [
      {
        connection_id: cloudflare.id,
        resources: { scope: 'all' },
        trust_levels: { 'look-up': 'trusting', point: 'trusting' },
      },
    ],
    period: { kind: 'one-off' },
    expires_at: null,
  });
  await root.missions.service.revoke(alice.user, revoked.id);

  const quota = await seeder.issue(alice.user, {
    name: 'Tour: a small limit to reach',
    connections: [
      {
        connection_id: github.id,
        resources: onRepos([product.repositories[0] ?? '']),
        policy: [line('github.read-code', SMALL_QUOTA), line('github.read-meta', 50)],
      },
    ],
    period: recurring,
    expires_at: null,
  });

  // ── A session of work on the active mission, by two labelled agents ───────
  const web = product.repositories[1]?.split('/')[1] ?? repo;
  const branch = 'feature/billing-page';
  const work: [string, string, Record<string, unknown>][] = [
    ['planner', 'github__list_branches', { ...repository }],
    ['planner', 'github__list_pull_requests', { ...repository, state: 'open' }],
    ['planner', 'github__list_issues', { ...repository, state: 'open' }],
    ['planner', 'github__get_file_contents', { ...repository, path: 'README.md' }],
    ['planner', 'github__get_file_contents', { owner, repo: web, path: 'package.json' }],
    ['coder', 'github__get_file_contents', { ...repository, path: 'src/billing/page.tsx' }],
    ['coder', 'github__list_commits', { ...repository, sha: branch }],
    [
      'coder',
      'github__create_or_update_file',
      {
        ...repository,
        branch,
        path: 'src/billing/totals.ts',
        message: 'Add invoice totals',
        content: 'export const total = (lines: number[]) => lines.reduce((a, b) => a + b, 0);\n',
      },
    ],
    [
      'coder',
      'github__create_pull_request',
      { ...repository, head: branch, base: 'main', title: 'Add the billing page' },
    ],
    [
      'coder',
      'github__add_issue_comment',
      { ...repository, issue_number: 77, body: 'Fixed by #132.' },
    ],
    ['coder', 'upstash_redis__get', { key: 'feature:billing-page' }],
    ['coder', 'upstash_redis__set', { key: 'feature:billing-page', value: 'on' }],
  ];
  for (const [label, tool, args] of work) {
    const refusal = await seeder.call(active, label, tool, args);
    if (refusal) fail(`${tool} was refused on the active mission`, refusal);
  }
  // A call outside the mission, refused and audited: the session page shows it.
  await seeder.call(active, 'coder', 'github__list_branches', {
    owner,
    repo: product.repositories[2]?.split('/')[1] ?? repo,
  });

  // ── A team on that mission: Bob as a member, and a named token ────────────
  // Alice adds Bob; Bob generates his own token (Alice never sees it); Alice creates a
  // named token for the CI. All three draw from the mission's one budget, and each
  // call below is attributed to its holder.
  const { team } = root.missions;
  const added = await team.addMember(alice.user, active.id, { email: bob.user.email });
  if (!added.ok) fail('adding Bob to the active mission', added.reason);
  const bobs = await team.generateToken(bob.user, active.id);
  if (!bobs.ok) fail('Bob generating his token', bobs.reason);
  const ci = await team.createNamedToken(alice.user, active.id, CI_TOKEN_NAME);
  if (!ci.ok) fail('creating the named token', ci.reason);
  const asBob = { ...active, token: bobs.token.secret };
  const asCi = { ...active, token: ci.token.secret };
  await seeder.call(asBob, 'reviewer', 'github__list_branches', repository);
  await seeder.call(asBob, 'reviewer', 'github__get_file_contents', {
    ...repository,
    path: 'README.md',
  });
  await seeder.call(asCi, 'pipeline', 'github__list_branches', repository);

  // ── The quota spent, then one call too many: an open claim ────────────────
  let claim: Record<string, unknown> | null = null;
  for (let read = 0; read <= SMALL_QUOTA; read += 1) {
    claim = await seeder.call(exhausted, 'auditor', 'github__get_file_contents', {
      ...repository,
      path: 'package.json',
    });
  }
  if (claim?.code !== 'budget-exhausted' || typeof claim.claim_url !== 'string') {
    fail('the exhausted mission did not open a claim', claim);
  }

  // ── A gated action: an open approval request showing its arguments ────────
  await seeder.call(gated, 'release-bot', 'github__list_pull_requests', { ...repository });
  const merge = {
    tool: 'github__merge_pull_request',
    arguments: { ...repository, pull_number: 128, base: 'main', merge_method: 'squash' },
  };
  const approval = await seeder.call(gated, 'release-bot', merge.tool, merge.arguments);
  if (approval?.code !== 'approval-required' || typeof approval.approval_url !== 'string') {
    fail('the gated merge did not ask for approval', approval);
  }

  // ── A mission issued by an MCP client holding a delegation of Alice ───────
  await seeder.issueByDelegation(alice, 'Claude Code (demo)', {
    name: 'Fix the flaky checkout test',
    connections: [
      {
        connection_id: github.id,
        resources: onRepos([product.repositories[0] ?? '']),
        policy: [
          line('github.read-code', 300),
          line('github.read-meta', 300),
          line('github.feature-branch-write', 50),
          line('github.create-pr', 5),
        ],
      },
    ],
    period: recurring,
    expires_at: null,
  });

  // ── Bob: a mission within the share he received ───────────────────────────
  const bobMission = await seeder.issue(bob.user, {
    name: 'Review the docs pull requests',
    connections: [
      {
        connection_id: github.id,
        resources: onRepos([product.repositories[3] ?? product.repositories[0] ?? '']),
        policy: [
          line('github.read-code', 200),
          line('github.read-meta', 200),
          line('github.comment-write', 20),
        ],
      },
    ],
    period: recurring,
    expires_at: null,
  });
  const docs = product.repositories[3]?.split('/')[1] ?? repo;
  await seeder.call(bobMission, 'reviewer', 'github__list_pull_requests', { owner, repo: docs });
  await seeder.call(bobMission, 'reviewer', 'github__get_pull_request', {
    owner,
    repo: docs,
    pull_number: 131,
  });

  // The expiry of the first mission is a real instant: wait until it has passed.
  const remaining = expiresAt.getTime() - Date.now();
  if (remaining >= 0) await new Promise((resolve) => setTimeout(resolve, remaining + 50));

  const aliceActor = await seeder.actor(alice.user);
  return {
    activeMission: active,
    quotaMission: quota,
    repository,
    openClaimUrl: claim.claim_url,
    openApprovalUrl: approval.approval_url,
    approval: { mission: gated, ...merge },
    sharedConnection: { id: github.id, name: github.displayName },
    team: {
      mission: { id: active.id, name: active.name },
      member: { email: bob.user.email },
      named: { name: CI_TOKEN_NAME, token: ci.token.secret },
    },
    counts: {
      connections: (await root.connections.service.listFor(aliceActor)).length,
      missions: (await root.missions.service.list(alice.user)).length,
    },
  };
}
