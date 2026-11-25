/**
 * What the demo instance contains on first load, created the way its users
 * would have created it: through the real sign-in, the real connect flows
 * (against the simulated services), the mission, share and group services,
 * the OAuth authorization server, and tool calls through the execution door.
 * Nothing is written to the store directly, so every state shown is one the
 * application itself can reach:
 *
 *   Alice (operator)  five accounts — a GitHub organisation, a second one
 *                     transferred to the local group "GitHub admins", Upstash
 *                     Redis (databases labelled prod / staging), Resend (the
 *                     production domain left without a label, which the
 *                     mission form warns about), Cloudflare DNS; a share of
 *                     the first GitHub account to Bob; missions in every
 *                     state: active with a session of calls under two agent
 *                     labels, quota spent with an open claim, an open approval
 *                     request, expired, revoked, prepared by her platform agent
 *                     (her Vaubaan account and its platform management mission);
 *                     a fresh mission with a small limit for the tour.
 *   Bob               the share received and a mission issued within it.
 *   Carol             member of "GitHub admins"; a Stripe account of her own
 *                     (test and live), its test mode shared to Alice.
 *
 * Everything runs in the process, on the root's host-agnostic handlers
 * (`Request → Response`): no browser and no HTTP round trip to the pages.
 */
import { isSecondFactorStep, passSecondFactor } from '../support/auth/testing';

import type { MissionPolicyEntry, RiskId } from '@vaubaan/shared';

import { LOGIN_COOKIE, SESSION_COOKIE } from '../../src/server/auth';
import type { GatewayRoot } from '../../src/server/compose/root';
import type { Actor } from '../../src/server/accounts';
import type { MissionDraft } from '../../src/server/missions';
import type { AccountRecord, UserRecord } from '../../src/server/store/types';
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
  type DemoServices,
} from './services';

const DAY_SECONDS = 86_400;
/** Quota of the tour's "exhaust it yourself" mission, and of the seeded exhausted one. */
export const SMALL_QUOTA = 3;
/** The user agent of the seeded agents' calls. */
const AGENT_USER_AGENT = 'claude-code/2.1 (demo seed)';
/** The named token of the seeded team mission: a machine with no account. */
export const CI_TOKEN_NAME = 'CI runner';

export interface SeedContext {
  readonly root: GatewayRoot;
  readonly idp: DemoIdp;
  readonly services: DemoServices;
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
  /** The GitHub account Alice shares to Bob, for the share steps of the tour. */
  readonly sharedAccount: { readonly id: string; readonly name: string };
  /**
   * The team on the active mission (spec §7.9 bis): Bob is a member and has
   * generated his own token; "CI runner" is a named token Alice created. Both
   * made calls, so the mission log and the audit attribute them.
   */
  readonly team: {
    readonly mission: { readonly id: string; readonly name: string };
    readonly member: { readonly email: string };
    /** The named token, shown once to Alice when she created it. */
    readonly named: { readonly name: string; readonly token: string };
  };
  readonly counts: { readonly accounts: number; readonly missions: number };
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
    service: string,
    name: string,
    fields: Record<string, string>,
  ): Promise<AccountRecord> {
    const actor = await this.actor(user);
    const result = await this.ctx.root.accounts.service.start(actor, service, {
      displayName: name,
      fields,
    });
    if (result.kind !== 'connected') fail(`${service} connect did not complete`, result.kind);
    return result.account;
  }

  /** Labels resources of an account, by ref. */
  async label(user: UserRecord, account: AccountRecord, envByRef: Record<string, string>) {
    const actor = await this.actor(user);
    const { service } = this.ctx.root.accounts;
    const detail = await service.get(actor, account.id);
    for (const resource of detail.resources) {
      const env = envByRef[resource.ref];
      if (env) await service.updateResource(actor, account.id, resource.id, { env });
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
   * The user connects their Vaubaan account (one click) and issues the platform
   * management mission on it; an agent holding its key then issues a mission
   * through `vaubaan__issue_mission` on the execution door (ADR
   * platform-management-is-a-plugin-on-the-execution-door). The new mission
   * names the platform mission as the one that prepared it.
   */
  async issueThroughPlatform(human: SignedIn, draft: MissionDraft) {
    const actor = await this.actor(human.user);
    const started = await this.ctx.root.accounts.service.start(actor, 'vaubaan');
    if (started.kind !== 'connected') fail('the Vaubaan account', started);
    const platform = await this.issue(human.user, {
      name: 'Platform management',
      accounts: [
        {
          account_id: started.account.id,
          trust_levels: {
            read: 'trusting',
            prepare: 'trusting',
            rotate: 'trusting',
            stop: 'careful',
          },
        },
      ],
      period: { kind: 'recurring', length_seconds: DAY_SECONDS },
      expires_at: null,
    });
    const answered = await this.ctx.root.execution.handlers.mcp(
      this.rpc(
        `${this.origin}/mcp`,
        platform.token,
        'tools/call',
        { name: 'vaubaan__issue_mission', arguments: draft },
        { 'x-vaubaan-agent': 'planner' },
      ),
    );
    const body = (await answered.json()) as {
      result?: { isError?: boolean; structuredContent?: unknown };
      error?: unknown;
    };
    if (body.error || body.result?.isError) fail('vaubaan__issue_mission', body);
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

  // ── Alice's accounts ────────────────────────────────────────────────────
  // One GitHub account per repository, each with its own token.
  const [product, webToken, platform] = DEMO_GITHUB_TOKENS;
  if (!product || !webToken || !platform) {
    fail('the simulated GitHub has fewer than three tokens', 0);
  }
  const github = await seeder.connectGithub(alice.user, product, 'Acme app');
  // A mission may carry both: one call runs with the account of the repository it names.
  await seeder.connectGithub(alice.user, webToken, 'Acme web');
  const platformGithub = await seeder.connectGithub(
    alice.user,
    platform,
    'Acme platform terraform',
  );
  await root.accounts.service.transfer(
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
  const [owner = '', repo = ''] = product.repository.split('/');
  const repository = { owner, repo };
  const onRepos = (refs: readonly string[]) =>
    ({ scope: 'selected', resource_refs: [...refs] }) as const;

  // Issued first: it is expired by the time the seed ends (see the wait below).
  const expiresAt = new Date(Date.now() + 2_000);
  await seeder.issue(alice.user, {
    name: 'Migration dry-run (finished)',
    accounts: [
      { account_id: github.id, resources: { scope: 'all' }, trust_levels: { read: 'careful' } },
    ],
    period: { kind: 'one-off' },
    expires_at: expiresAt.toISOString(),
  });

  const active = await seeder.issue(alice.user, {
    name: 'Ship the billing page',
    accounts: [
      {
        account_id: github.id,
        resources: onRepos([product.repository]),
        policy: [
          line('github.read-code', 500),
          line('github.read-meta', 500),
          line('github.feature-branch-write', 100),
          line('github.create-pr', 10),
          line('github.comment-write', 50),
        ],
      },

      {
        account_id: redis.id,
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
    accounts: [
      {
        account_id: github.id,
        resources: { scope: 'all' },
        policy: [line('github.read-code', SMALL_QUOTA), line('github.read-meta', 50)],
      },
    ],
    period: recurring,
    expires_at: null,
  });

  const gated = await seeder.issue(alice.user, {
    name: 'Release 2.4 hotfix',
    accounts: [
      {
        account_id: github.id,
        resources: onRepos([product.repository]),
        // Ship at Trusting: merges, tags and releases ask first; reads run freely.
        trust_levels: { read: 'trusting', propose: 'careful', ship: 'trusting' },
      },
    ],
    period: recurring,
    expires_at: null,
  });

  const revoked = await seeder.issue(alice.user, {
    name: 'Spike: move the status page DNS',
    accounts: [
      {
        account_id: cloudflare.id,
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
    accounts: [
      {
        account_id: github.id,
        resources: onRepos([product.repository]),
        policy: [line('github.read-code', SMALL_QUOTA), line('github.read-meta', 50)],
      },
    ],
    period: recurring,
    expires_at: null,
  });

  // ── A session of work on the active mission, by two labelled agents ───────
  const branch = 'feature/billing-page';
  const work: [string, string, Record<string, unknown>][] = [
    ['planner', 'github__list_branches', { ...repository }],
    ['planner', 'github__list_pull_requests', { ...repository, state: 'open' }],
    ['planner', 'github__list_issues', { ...repository, state: 'open' }],
    ['planner', 'github__get_file_contents', { ...repository, path: 'README.md' }],
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
  // A call outside the mission's risks, refused and audited: the mission log page shows it.
  await seeder.call(active, 'coder', 'github__create_release', {
    ...repository,
    tag_name: 'v2.0.0',
    name: 'Billing',
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

  // ── A mission prepared by Alice's platform agent, through her Vaubaan account ─
  await seeder.issueThroughPlatform(alice, {
    name: 'Fix the flaky checkout test',
    accounts: [
      {
        account_id: github.id,
        resources: onRepos([product.repository]),
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
    name: 'Review the app pull requests',
    accounts: [
      {
        account_id: github.id,
        resources: onRepos([product.repository]),
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
  await seeder.call(bobMission, 'reviewer', 'github__list_pull_requests', { ...repository });
  await seeder.call(bobMission, 'reviewer', 'github__get_pull_request', {
    ...repository,
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
    sharedAccount: { id: github.id, name: github.displayName },
    team: {
      mission: { id: active.id, name: active.name },
      member: { email: bob.user.email },
      named: { name: CI_TOKEN_NAME, token: ci.token.secret },
    },
    counts: {
      accounts: (await root.accounts.service.listFor(aliceActor)).length,
      missions: (await root.missions.service.list(alice.user)).length,
    },
  };
}
