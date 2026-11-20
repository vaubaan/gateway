/**
 * The simulated services of the demo: one `fetch` double handed to the
 * composition root as `RootDeps.serviceFetch`, so every outbound request of
 * a connect flow, of a discovery or of a tool call is answered here, from
 * memory, with a plausible canned payload.
 *
 * Nothing in this file opens a socket. A request no route below answers is
 * refused loudly (`DemoServiceError`, also written on the demo's stderr): it
 * is never forwarded to the real service.
 *
 * Simulated:
 *   - GitHub — three fine-grained tokens, one per repository (one account is
 *     one repository): the check at paste (`GET /user`), the repository each
 *     account names (`GET /repos/{owner}/{repo}`) and the REST endpoints behind the common tools (branches, commits,
 *     files, pull requests, issues, …);
 *   - Stripe — `GET /v1/account` per key (test and live as two resources),
 *     the list endpoints and the writes of the plugin's tools;
 *   - Cloudflare DNS — the check at paste, two zones and their records;
 *   - Resend — two sending domains, one segment, emails;
 *   - Upstash Redis — the check at paste, two databases through the Management API, and a few
 *     Redis commands on their REST endpoints;
 *   - Axonaut — the check at paste and discovery (`GET /me`, one account),
 *     a few companies, contacts, opportunities, quotations and invoices, and
 *     the writes of the plugin's tools answered with the record they name;
 *   - Vercel — one team and two projects, each with a production and a
 *     preview deployment and two environment variables: discovery, the
 *     environment-variable tools of the REST API, the deployment lookup, and
 *     the rewrapped tools of the remote MCP server answered with canned text.
 *
 * Every service URL is read off the plugin that calls it (its credential
 * spec or its exported API base), never spelled a second time here.
 */
import { randomBytes } from 'node:crypto';

import { AXONAUT_API_BASE } from '@vaubaan/plugin-axonaut';
import { CLOUDFLARE_API_BASE } from '@vaubaan/plugin-cloudflare-dns';
import {
  GITHUB_REPOSITORY_FIELD,
  GITHUB_TOKEN_FIELD,
  githubCredential,
} from '@vaubaan/plugin-github';
import { RESEND_API_BASE } from '@vaubaan/plugin-resend';
import { mockFetch, type MockRoute, type RecordedCall } from '@vaubaan/plugin-sdk/testing';
import { STRIPE_API_BASE } from '@vaubaan/plugin-stripe';
import { UPSTASH_MANAGEMENT_API, UPSTASH_REST_HOST_SUFFIX } from '@vaubaan/plugin-upstash-redis';
import { VERCEL_API_BASE, VERCEL_MCP_URL } from '@vaubaan/plugin-vercel';

const random = (bytes = 20): string => randomBytes(bytes).toString('hex');
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export class DemoServiceError extends Error {
  constructor(method: string, url: string) {
    super(
      `demo mode: no simulated answer for ${method} ${url} — nothing was sent to the real service`,
    );
    this.name = 'DemoServiceError';
  }
}

/* ------------------------------------------------------------------------ */
/* GitHub                                                                    */
/* ------------------------------------------------------------------------ */

const GITHUB_API = 'https://api.github.com';

export interface DemoGithubToken {
  /** The fine-grained token, of the shape the plugin's field accepts. */
  readonly token: string;
  /** The account the token was made for, as `GET /user` names it. */
  readonly account: string;
  /** The one repository of the account, `owner/repo`. */
  readonly repository: string;
}

/** The demo GitHub's accounts: one fine-grained token per repository. */
export const DEMO_GITHUB_TOKENS: readonly DemoGithubToken[] = [
  {
    token: `github_pat_11DEMO0000000000000_${'a'.repeat(40)}`,
    account: 'acme-org',
    repository: 'acme-org/app',
  },
  {
    token: `github_pat_11DEMO0000000000000_${'c'.repeat(40)}`,
    account: 'acme-org',
    repository: 'acme-org/web',
  },
  {
    token: `github_pat_11DEMO0000000000000_${'b'.repeat(40)}`,
    account: 'acme-platform',
    repository: 'acme-platform/terraform',
  },
];

/** The form values that connect GitHub with one of the demo's tokens. */
export function githubTokenFields(token: DemoGithubToken): Record<string, string> {
  if (githubCredential.kind !== 'api-key') throw new Error('github connects with a token');
  return { [GITHUB_TOKEN_FIELD]: token.token, [GITHUB_REPOSITORY_FIELD]: token.repository };
}

const BRANCHES = [
  { name: 'main', protected: true },
  { name: 'feature/billing-page', protected: false },
  { name: 'fix/flaky-checkout-test', protected: false },
];

function pullRequest(repo: string, number: number): Record<string, unknown> {
  return {
    number,
    state: 'open',
    title: number % 2 === 0 ? 'Add the billing page' : 'Fix the flaky checkout test',
    html_url: `https://github.com/${repo}/pull/${number}`,
    user: { login: 'vaubaan-demo[bot]' },
    head: { ref: number % 2 === 0 ? 'feature/billing-page' : 'fix/flaky-checkout-test' },
    base: { ref: 'main' },
    mergeable: true,
    draft: false,
  };
}

function issue(repo: string, number: number): Record<string, unknown> {
  return {
    number,
    state: 'open',
    title: 'Checkout test fails one run in five',
    html_url: `https://github.com/${repo}/issues/${number}`,
    user: { login: 'alice-demo' },
    labels: [{ name: 'flaky-test' }],
    comments: 2,
  };
}

function commit(sha: string, message: string): Record<string, unknown> {
  return {
    sha,
    commit: {
      message,
      author: { name: 'Alice (demo)', date: new Date(Date.now() - 3_600_000).toISOString() },
    },
    html_url: `https://github.com/acme-org/app/commit/${sha}`,
  };
}

const COMMITS = [
  commit('a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', 'Add invoice totals to the billing page'),
  commit('b2c3d4e5f60718293a4b5c6d7e8f90123456789a', 'Retry the checkout test on network errors'),
  commit('c3d4e5f60718293a4b5c6d7e8f90123456789ab2', 'Bump dependencies'),
];

const repoOf = (url: string): string => {
  const [, , owner = '', repo = ''] = new URL(url).pathname.split('/');
  return `${owner}/${repo}`;
};
const lastNumberOf = (url: string): number =>
  Number(/\/(\d+)(?:\/[a-z]+)?$/.exec(new URL(url).pathname)?.[1] ?? 1);
const jsonOf = (call: RecordedCall): Record<string, unknown> =>
  typeof call.json === 'object' && call.json !== null ? (call.json as Record<string, unknown>) : {};

function githubRoutes(): MockRoute[] {
  const api = escapeRegExp(GITHUB_API);
  const repo = `^${api}/repos/[^/]+/[^/]+`;
  const tokenOf = (call: RecordedCall): DemoGithubToken | undefined => {
    const bearer = (call.headers.authorization ?? '').replace(/^(token|Bearer)\s+/i, '');
    return DEMO_GITHUB_TOKENS.find((known) => known.token === bearer);
  };

  return [
    // ── The connect flow: the check at paste, then the account's repository ──
    {
      method: 'GET',
      url: `${GITHUB_API}/user`,
      // A token the demo does not know names nobody: the plugin's check refuses it.
      respond: (call) => ({ login: tokenOf(call)?.account ?? null }),
    },
    {
      method: 'GET',
      url: new RegExp(`${repo}$`),
      respond: (call) => ({
        full_name: repoOf(call.url),
        default_branch: 'main',
        private: true,
        archived: false,
      }),
    },
    // ── Reads ───────────────────────────────────────────────────────────────
    { method: 'GET', url: new RegExp(`${repo}/branches(\\?|$)`), body: BRANCHES },
    { method: 'GET', url: new RegExp(`${repo}/commits(\\?|$)`), body: COMMITS },
    { method: 'GET', url: new RegExp(`${repo}/commits/[^/]+$`), body: COMMITS[0] },
    {
      method: 'GET',
      url: new RegExp(`${repo}/pulls(\\?|$)`),
      respond: (call) => [pullRequest(repoOf(call.url), 128), pullRequest(repoOf(call.url), 131)],
    },
    {
      method: 'GET',
      url: new RegExp(`${repo}/pulls/\\d+$`),
      respond: (call) => pullRequest(repoOf(call.url), lastNumberOf(call.url)),
    },
    {
      method: 'GET',
      url: new RegExp(`${repo}/issues(\\?|$)`),
      respond: (call) => [issue(repoOf(call.url), 77)],
    },
    {
      method: 'GET',
      url: new RegExp(`${repo}/issues/\\d+$`),
      respond: (call) => issue(repoOf(call.url), lastNumberOf(call.url)),
    },
    {
      method: 'GET',
      url: new RegExp(`${repo}/contents/`),
      respond: (call) => {
        const path = decodeURIComponent(new URL(call.url).pathname.split('/contents/')[1] ?? '');
        return {
          type: 'file',
          name: path.split('/').pop(),
          path,
          sha: 'f00dfacef00dfacef00dfacef00dfacef00dface',
          encoding: 'base64',
          content: Buffer.from(
            `# ${path}\n\nSimulated file content served by the Vaubaan demo.\n`,
          ).toString('base64'),
        };
      },
    },
    {
      method: 'GET',
      url: new RegExp(`${repo}/git/ref/`),
      body: { ref: 'refs/heads/main', object: { type: 'commit', sha: COMMITS[0]!.sha } },
    },
    {
      method: 'GET',
      url: new RegExp(`${repo}/actions/workflows(\\?|$)`),
      body: {
        total_count: 1,
        workflows: [{ id: 1, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' }],
      },
    },
    {
      method: 'GET',
      url: new RegExp(`${repo}/actions/(workflows/[^/]+/)?runs(\\?|$)`),
      body: {
        total_count: 1,
        workflow_runs: [{ id: 9001, name: 'CI', status: 'completed', conclusion: 'success' }],
      },
    },
    {
      method: 'GET',
      url: new RegExp(`${repo}/releases(\\?|$)`),
      body: [{ id: 24, tag_name: 'v2.3.0', name: '2.3.0', draft: false, prerelease: false }],
    },
    {
      method: 'GET',
      url: new RegExp(`${repo}/tags(\\?|$)`),
      body: [{ name: 'v2.3.0', commit: { sha: COMMITS[2]!.sha } }],
    },
    {
      method: 'GET',
      url: new RegExp(`^${api}/search/(code|issues)\\?`),
      body: { total_count: 0, incomplete_results: false, items: [] },
    },
    {
      // The repository itself (`create_branch` reads its default branch).
      method: 'GET',
      url: new RegExp(`${repo}$`),
      respond: (call) => ({ full_name: repoOf(call.url), default_branch: 'main', private: true }),
    },
    // ── Writes ──────────────────────────────────────────────────────────────
    {
      method: 'PUT',
      url: new RegExp(`${repo}/contents/`),
      status: 201,
      respond: (call) => ({
        content: {
          path: decodeURIComponent(new URL(call.url).pathname.split('/contents/')[1] ?? ''),
        },
        commit: { sha: 'c0ffee0000000000000000000000000000000000' },
      }),
    },
    {
      method: 'POST',
      url: new RegExp(`${repo}/git/refs$`),
      status: 201,
      respond: (call) => ({ ref: jsonOf(call).ref, object: { sha: jsonOf(call).sha } }),
    },
    {
      method: 'POST',
      url: new RegExp(`${repo}/pulls$`),
      status: 201,
      respond: (call) => ({
        ...pullRequest(repoOf(call.url), 132),
        title: jsonOf(call).title,
        head: { ref: jsonOf(call).head },
        base: { ref: jsonOf(call).base },
      }),
    },
    {
      method: 'PUT',
      url: new RegExp(`${repo}/pulls/\\d+/merge$`),
      body: { merged: true, message: 'Pull Request successfully merged', sha: COMMITS[0]!.sha },
    },
    {
      method: 'POST',
      url: new RegExp(`${repo}/issues/\\d+/comments$`),
      status: 201,
      respond: (call) => ({ id: 5551, body: jsonOf(call).body }),
    },
  ];
}

/* ------------------------------------------------------------------------ */
/* Stripe                                                                    */
/* ------------------------------------------------------------------------ */

const STRIPE_ACCOUNT = 'acct_1DemoAcmeBilling';
const STRIPE_LISTS: Readonly<Record<string, readonly Record<string, unknown>[]>> = {
  products: [{ id: 'prod_DemoTeam', object: 'product', name: 'Team plan', active: true }],
  prices: [
    { id: 'price_DemoTeamMonthly', object: 'price', unit_amount: 4900, currency: 'eur' },
    { id: 'price_DemoTeamYearly', object: 'price', unit_amount: 49000, currency: 'eur' },
  ],
  customers: [
    { id: 'cus_DemoGlobex', object: 'customer', name: 'Globex', email: 'billing@globex.example' },
    { id: 'cus_DemoInitech', object: 'customer', name: 'Initech', email: 'ap@initech.example' },
  ],
  subscriptions: [{ id: 'sub_DemoGlobex', object: 'subscription', status: 'active' }],
  invoices: [{ id: 'in_Demo0042', object: 'invoice', status: 'paid', amount_due: 4900 }],
  charges: [{ id: 'ch_Demo0042', object: 'charge', amount: 4900, status: 'succeeded' }],
  payment_intents: [{ id: 'pi_Demo0042', object: 'payment_intent', status: 'succeeded' }],
  events: [{ id: 'evt_Demo0042', object: 'event', type: 'invoice.paid' }],
};

const stripeLive = (call: RecordedCall): boolean =>
  /^Bearer (sk|rk)_live_/.test(call.headers.authorization ?? '');

function stripeRoutes(): MockRoute[] {
  const api = escapeRegExp(STRIPE_API_BASE);
  return [
    {
      method: 'GET',
      url: `${STRIPE_API_BASE}/account`,
      respond: () => ({
        id: STRIPE_ACCOUNT,
        object: 'account',
        business_profile: { name: 'Acme (demo)' },
        settings: { dashboard: { display_name: 'Acme billing' } },
      }),
    },
    {
      method: 'GET',
      url: `${STRIPE_API_BASE}/balance`,
      respond: (call) => ({
        object: 'balance',
        livemode: stripeLive(call),
        available: [{ amount: 1_254_300, currency: 'eur' }],
        pending: [{ amount: 98_000, currency: 'eur' }],
      }),
    },
    {
      method: 'GET',
      url: new RegExp(`^${api}/customers/[^/?]+$`),
      respond: (call) => ({ ...STRIPE_LISTS.customers![0], livemode: stripeLive(call) }),
    },
    {
      method: 'GET',
      url: new RegExp(`^${api}/(${Object.keys(STRIPE_LISTS).join('|')})(\\?|$)`),
      respond: (call) => {
        const collection = new URL(call.url).pathname.split('/').pop() ?? '';
        const livemode = stripeLive(call);
        return {
          object: 'list',
          url: `/v1/${collection}`,
          has_more: false,
          data: (STRIPE_LISTS[collection] ?? []).map((item) => ({ ...item, livemode })),
        };
      },
    },
    {
      // Every write of the plugin: the object as Stripe would return it, marked as simulated.
      method: 'POST',
      url: new RegExp(`^${api}/[a-z_]+(/[^/?]+)?(/[a-z]+)?$`),
      respond: (call) => {
        const [collection = 'object', id] = new URL(call.url).pathname.split('/').slice(2);
        return {
          id: id ?? `${collection.slice(0, 4)}_Demo${random(4)}`,
          object: collection.replace(/s$/, ''),
          livemode: stripeLive(call),
          status: 'succeeded',
          simulated_by: 'vaubaan-demo',
        };
      },
    },
    {
      method: 'DELETE',
      url: new RegExp(`^${api}/[a-z_]+/[^/?]+$`),
      respond: (call) => ({ id: new URL(call.url).pathname.split('/').pop(), deleted: true }),
    },
  ];
}

/* ------------------------------------------------------------------------ */
/* Cloudflare DNS                                                            */
/* ------------------------------------------------------------------------ */

const CLOUDFLARE_ACCOUNT = { id: 'd41d8cd98f00b204e9800998ecf8427e', name: 'Acme (demo)' };
export const DEMO_ZONES = [
  { id: '023e105f4ecef8ad9ca31a8372d0c353', name: 'acme-demo.example' },
  { id: '9a7806061c88ada191ed06f989cc3dac', name: 'acme-status.example' },
] as const;

const cloudflareEnvelope = (result: unknown, extra: Record<string, unknown> = {}) => ({
  success: true,
  errors: [],
  messages: [],
  result,
  ...extra,
});

function zoneDto(zone: (typeof DEMO_ZONES)[number]): Record<string, unknown> {
  return { ...zone, status: 'active', account: CLOUDFLARE_ACCOUNT, name_servers: ['ns1', 'ns2'] };
}

function dnsRecords(zoneName: string): Record<string, unknown>[] {
  return [
    { id: '372e67954025e0ba6aaa6d586b9e0b59', type: 'A', name: zoneName, content: '203.0.113.10' },
    {
      id: '5a7805061c76ada191ed06f989cc3dab',
      type: 'CNAME',
      name: `www.${zoneName}`,
      content: zoneName,
    },
    {
      id: '6b8916172d87beb2a2fe17fa9add4ebc',
      type: 'MX',
      name: zoneName,
      content: 'mail.acme-demo.example',
      priority: 10,
    },
  ];
}

function cloudflareRoutes(): MockRoute[] {
  const api = escapeRegExp(CLOUDFLARE_API_BASE);
  const zone = `^${api}/zones/[A-Za-z0-9]+`;
  const zoneNameOf = (url: string): string => {
    const id = new URL(url).pathname.split('/zones/')[1]?.split('/')[0];
    return DEMO_ZONES.find((z) => z.id === id)?.name ?? DEMO_ZONES[0].name;
  };
  return [
    // The check at paste: the token is active and has no TTL.
    {
      method: 'GET',
      url: `${CLOUDFLARE_API_BASE}/user/tokens/verify`,
      body: cloudflareEnvelope({ id: 'demo-token', status: 'active' }),
    },
    {
      method: 'GET',
      url: new RegExp(`^${api}/zones(\\?|$)`),
      respond: () =>
        cloudflareEnvelope(DEMO_ZONES.map(zoneDto), {
          result_info: { page: 1, per_page: 50, total_pages: 1, count: DEMO_ZONES.length },
        }),
    },
    {
      method: 'GET',
      url: new RegExp(`${zone}$`),
      respond: (call) => {
        const id = new URL(call.url).pathname.split('/').pop();
        return cloudflareEnvelope(zoneDto(DEMO_ZONES.find((z) => z.id === id) ?? DEMO_ZONES[0]));
      },
    },
    {
      method: 'GET',
      url: new RegExp(`${zone}/dns_records(\\?|$)`),
      respond: (call) => cloudflareEnvelope(dnsRecords(zoneNameOf(call.url))),
    },
    {
      method: 'GET',
      url: new RegExp(`${zone}/dns_records/export$`),
      respond: (call) => `;; simulated zone file\n${zoneNameOf(call.url)}. 300 IN A 203.0.113.10\n`,
    },
    {
      method: 'GET',
      url: new RegExp(`${zone}/dns_records/[A-Za-z0-9]+$`),
      respond: (call) => cloudflareEnvelope(dnsRecords(zoneNameOf(call.url))[1]),
    },
    {
      method: 'GET',
      url: new RegExp(`${zone}/settings$`),
      body: cloudflareEnvelope([
        { id: 'ssl', value: 'strict' },
        { id: 'always_use_https', value: 'on' },
      ]),
    },
    {
      method: 'GET',
      url: new RegExp(`${zone}/dnssec$`),
      body: cloudflareEnvelope({ status: 'active' }),
    },
    {
      method: 'POST',
      url: new RegExp(`${zone}/dns_records$`),
      respond: (call) =>
        cloudflareEnvelope({ id: random(16), ...jsonOf(call), simulated_by: 'vaubaan-demo' }),
    },
    {
      method: 'PATCH',
      url: new RegExp(`${zone}/dns_records/[A-Za-z0-9]+$`),
      respond: (call) =>
        cloudflareEnvelope({ ...dnsRecords(zoneNameOf(call.url))[1], ...jsonOf(call) }),
    },
    {
      method: 'DELETE',
      url: new RegExp(`${zone}/dns_records/[A-Za-z0-9]+$`),
      respond: (call) => cloudflareEnvelope({ id: new URL(call.url).pathname.split('/').pop() }),
    },
  ];
}

/* ------------------------------------------------------------------------ */
/* Resend                                                                    */
/* ------------------------------------------------------------------------ */

export const DEMO_RESEND_DOMAINS = [
  { id: 'd91cd9bd-1176-453e-8fc1-35364d380206', name: 'mail.acme-demo.example' },
  { id: 'e02de0ce-2287-564f-9fd2-46475e491317', name: 'staging-mail.acme-demo.example' },
] as const;
const RESEND_SEGMENT = { id: '78261eea-8f8b-4381-83c6-79fa7120f1cf', name: 'Newsletter' };

function resendRoutes(): MockRoute[] {
  const api = escapeRegExp(RESEND_API_BASE);
  const list = (data: readonly unknown[]) => ({ object: 'list', has_more: false, data });
  const domains = DEMO_RESEND_DOMAINS.map((d) => ({
    ...d,
    status: 'verified',
    region: 'eu-west-1',
  }));
  return [
    { method: 'GET', url: new RegExp(`^${api}/domains(\\?|$)`), body: list(domains) },
    { method: 'GET', url: new RegExp(`^${api}/domains/[^/?]+$`), body: domains[0] },
    { method: 'GET', url: new RegExp(`^${api}/segments(\\?|$)`), body: list([RESEND_SEGMENT]) },
    { method: 'GET', url: new RegExp(`^${api}/segments/[^/?]+$`), body: RESEND_SEGMENT },
    {
      method: 'GET',
      url: new RegExp(`^${api}/contacts(\\?|$)`),
      body: list([{ id: 'c0ffee00-0000-4000-8000-000000000001', email: 'reader@globex.example' }]),
    },
    { method: 'GET', url: new RegExp(`^${api}/broadcasts(\\?|$)`), body: list([]) },
    {
      method: 'GET',
      url: new RegExp(`^${api}/emails/[^/?]+$`),
      respond: (call) => ({
        id: new URL(call.url).pathname.split('/').pop(),
        object: 'email',
        last_event: 'delivered',
      }),
    },
    {
      method: 'POST',
      url: `${RESEND_API_BASE}/emails`,
      respond: () => ({ id: `49a3999c-0ce1-4ea6-ab68-${random(6)}` }),
    },
  ];
}

/* ------------------------------------------------------------------------ */
/* Upstash Redis                                                             */
/* ------------------------------------------------------------------------ */

export const DEMO_REDIS_DATABASES = [
  { database_id: '6fceaafd-9627-4fa5-8f43-d4f0e1f4c3a1', database_name: 'acme-cache-prod' },
  { database_id: '7ad1bb0e-a738-4eb6-9f54-e5f1f2a5d4b2', database_name: 'acme-cache-staging' },
] as const;

/**
 * REST endpoint of a simulated database. The plugin posts a database token to a host
 * of Upstash's REST domain and to no other, so the simulated one is named there too;
 * like every service URL here it is answered from memory and never dialled.
 */
const redisRestHost = (name: string): string => `${name}${UPSTASH_REST_HOST_SUFFIX}`;
const redisRestUrl = (name: string): string => `https://${redisRestHost(name)}`;

function redisDatabase(database: (typeof DEMO_REDIS_DATABASES)[number]): Record<string, unknown> {
  return {
    ...database,
    database_type: 'Pay as You Go',
    region: 'global',
    primary_region: 'eu-west-1',
    read_regions: [],
    endpoint: redisRestHost(database.database_name),
    rest_url: redisRestUrl(database.database_name),
    rest_token: `demo-rest-${random(12)}`,
    state: 'active',
    tls: true,
  };
}

/** What a simulated database answers to one Redis command. */
function redisResult(command: readonly unknown[]): unknown {
  switch (String(command[0] ?? '').toUpperCase()) {
    case 'GET':
      return '{"plan":"team","seats":12}';
    case 'KEYS':
      return ['session:globex', 'session:initech', 'feature:billing-page'];
    case 'SCAN':
      return ['0', ['session:globex', 'session:initech']];
    case 'DBSIZE':
      return 1284;
    case 'TTL':
      return 3600;
    case 'HGETALL':
      return ['plan', 'team', 'seats', '12'];
    case 'LRANGE':
    case 'SMEMBERS':
      return ['globex', 'initech'];
    case 'SET':
      return 'OK';
    default:
      // DEL, EXPIRE, HSET, LPUSH, SADD…: the number of elements affected.
      return 1;
  }
}

function upstashRoutes(): MockRoute[] {
  const api = escapeRegExp(UPSTASH_MANAGEMENT_API);
  const databaseOf = (url: string) =>
    DEMO_REDIS_DATABASES.find((d) => d.database_id === new URL(url).pathname.split('/').pop()) ??
    DEMO_REDIS_DATABASES[0];
  return [
    // The check at paste.
    { method: 'GET', url: `${UPSTASH_MANAGEMENT_API}/teams`, body: [] },
    {
      method: 'GET',
      url: `${UPSTASH_MANAGEMENT_API}/redis/databases`,
      respond: () => DEMO_REDIS_DATABASES.map(redisDatabase),
    },
    {
      method: 'GET',
      url: new RegExp(`^${api}/redis/database/[^/?]+$`),
      respond: (call) => redisDatabase(databaseOf(call.url)),
    },
    {
      method: 'GET',
      url: new RegExp(`^${api}/redis/stats/[^/?]+$`),
      body: {
        daily_net_commands: 18_240,
        total_monthly_storage: 4_194_304,
        current_storage: 1_048_576,
      },
    },
    ...DEMO_REDIS_DATABASES.map((database): MockRoute => ({
      method: 'POST',
      url: (url) => url.replace(/\/$/, '') === redisRestUrl(database.database_name),
      respond: (call) => ({ result: redisResult(Array.isArray(call.json) ? call.json : []) }),
    })),
  ];
}

/* ------------------------------------------------------------------------ */
/* Vercel                                                                    */
/* ------------------------------------------------------------------------ */

export const DEMO_VERCEL_TEAM = { slug: 'acme', name: 'Acme' } as const;

export const DEMO_VERCEL_PROJECTS = [
  { id: 'prj_acmeWebStorefront0001', name: 'acme-storefront', framework: 'nextjs' },
  { id: 'prj_acmeDocsSite00000002', name: 'acme-docs', framework: 'astro' },
] as const;

type DemoVercelProject = (typeof DEMO_VERCEL_PROJECTS)[number];

/** The two deployments of a project: what is live, and the latest preview. */
function vercelDeployments(project: DemoVercelProject): Record<string, unknown>[] {
  const short = project.id.slice(-4);
  return [
    {
      id: `dpl_${short}Production`,
      name: project.name,
      url: `${project.name}.vercel.app`,
      target: 'production',
      state: 'READY',
      projectId: project.id,
      meta: { githubCommitRef: 'main' },
    },
    {
      id: `dpl_${short}Preview`,
      name: project.name,
      url: `${project.name}-git-feature-billing-page.vercel.app`,
      target: 'preview',
      state: 'READY',
      projectId: project.id,
      meta: { githubCommitRef: 'feature/billing-page' },
    },
  ];
}

function vercelEnvVars(project: DemoVercelProject): Record<string, unknown>[] {
  return [
    {
      id: `env_${project.id.slice(-4)}Api`,
      key: 'API_BASE_URL',
      type: 'plain',
      target: ['production'],
      value: 'https://api.acme.example',
    },
    {
      id: `env_${project.id.slice(-4)}Flag`,
      key: 'NEXT_PUBLIC_FEATURE_BILLING',
      type: 'plain',
      target: ['preview', 'development'],
      value: 'on',
    },
  ];
}

/** What the remote MCP server answers to one rewrapped tool, as text content. */
function vercelToolAnswer(name: string, args: Record<string, unknown>): unknown {
  switch (name) {
    case 'list_teams':
      return { teams: [{ id: args.teamId ?? 'team_demo', ...DEMO_VERCEL_TEAM }] };
    // `list_projects`, `get_project`, `list_deployments`, `get_deployment` and the build logs
    // never reach the MCP server (the plugin's `rest-reads.ts`): see the REST routes.
    case 'get_runtime_logs':
      return { logs: ['Build completed in 41s', 'Ready'] };
    default:
      return { simulated: true, tool: name };
  }
}

function vercelRoutes(): MockRoute[] {
  const api = escapeRegExp(VERCEL_API_BASE);
  const projectOf = (url: string): DemoVercelProject =>
    DEMO_VERCEL_PROJECTS.find((p) => new URL(url).pathname.includes(`/${p.id}`)) ??
    DEMO_VERCEL_PROJECTS[0];
  const deployments = DEMO_VERCEL_PROJECTS.flatMap(vercelDeployments);
  return [
    // The check at paste: the token, without an expiration.
    {
      method: 'GET',
      url: `${VERCEL_API_BASE}/v5/user/tokens/current`,
      body: { token: { id: 'demo-token', name: 'demo' } },
    },
    {
      method: 'GET',
      url: new RegExp(`^${api}/v2/teams/[^/?]+$`),
      // Whatever team id the account carries: the demo has one team.
      respond: (call) => ({
        id: decodeURIComponent(new URL(call.url).pathname.split('/').pop() ?? ''),
        ...DEMO_VERCEL_TEAM,
      }),
    },
    {
      method: 'GET',
      url: new RegExp(`^${api}/v10/projects\\?`),
      body: { projects: DEMO_VERCEL_PROJECTS, pagination: { next: null } },
    },
    {
      method: 'GET',
      url: new RegExp(`^${api}/v9/projects/[^/?]+(\\?|$)`),
      respond: (call) => {
        const project = projectOf(call.url);
        return { ...project, latestDeployments: vercelDeployments(project) };
      },
    },
    {
      method: 'GET',
      url: new RegExp(`^${api}/v6/deployments\\?`),
      respond: (call) => {
        const id = new URL(call.url).searchParams.get('projectId');
        const project = DEMO_VERCEL_PROJECTS.find((p) => p.id === id) ?? DEMO_VERCEL_PROJECTS[0];
        return { deployments: vercelDeployments(project), pagination: { next: null } };
      },
    },
    {
      method: 'GET',
      url: new RegExp(`^${api}/v3/deployments/[^/?]+/events\\?`),
      body: [
        { created: 2, type: 'stdout', text: 'Ready' },
        { created: 1, type: 'stdout', text: 'Build completed in 41s' },
      ],
    },
    {
      method: 'GET',
      url: new RegExp(`^${api}/v10/projects/[^/?]+/env(\\?|$)`),
      respond: (call) => ({ envs: vercelEnvVars(projectOf(call.url)) }),
    },
    {
      method: 'POST',
      url: new RegExp(`^${api}/v10/projects/[^/?]+/env(\\?|$)`),
      respond: (call) => ({ created: call.json, failed: [] }),
    },
    {
      method: 'DELETE',
      url: new RegExp(`^${api}/v9/projects/[^/?]+/env/[^/?]+(\\?|$)`),
      body: {},
    },
    {
      // The lookup that binds a deployment to its project before a tool reads it.
      method: 'GET',
      url: new RegExp(`^${api}/v13/deployments/[^/?]+(\\?|$)`),
      respond: (call) => {
        const key = decodeURIComponent(new URL(call.url).pathname.split('/').pop() ?? '');
        return deployments.find((d) => d.id === key || d.url === key) ?? deployments[0];
      },
    },
    {
      // The remote MCP server: one JSON-RPC exchange, answered as one SSE frame.
      method: 'POST',
      url: VERCEL_MCP_URL,
      headers: { 'Content-Type': 'text/event-stream' },
      respond: (call) => {
        const request = call.json as {
          id?: number;
          params?: { name?: string; arguments?: Record<string, unknown> };
        };
        const answer = vercelToolAnswer(
          request.params?.name ?? '',
          request.params?.arguments ?? {},
        );
        const frame = {
          jsonrpc: '2.0',
          id: request.id ?? null,
          result: { content: [{ type: 'text', text: JSON.stringify(answer, null, 2) }] },
        };
        return `event: message\ndata: ${JSON.stringify(frame)}\n\n`;
      },
    },
  ];
}

/* ------------------------------------------------------------------------ */
/* Axonaut                                                                   */
/* ------------------------------------------------------------------------ */

/** The one account every demo Axonaut key opens. */
export const DEMO_AXONAUT_ACCOUNT = { id: 51200, company_name: 'Acme Conseil SAS' } as const;

const DEMO_AXONAUT_COMPANIES = [
  { id: 33, name: 'Globex SARL', is_customer: true, is_prospect: false, address_city: 'Toulouse' },
  { id: 34, name: 'Initech', is_customer: false, is_prospect: true, address_city: 'Lyon' },
] as const;

function axonautRoutes(): MockRoute[] {
  const api = escapeRegExp(AXONAUT_API_BASE);
  const lastSegment = (url: string): string => new URL(url).pathname.split('/').pop() ?? '';
  const record = (kind: string) => (call: RecordedCall) => ({
    id: Number(lastSegment(call.url)),
    kind,
  });
  return [
    {
      method: 'GET',
      url: `${AXONAUT_API_BASE}/me`,
      body: {
        id: 58962,
        email: 'alice@acme-conseil.example',
        fullname: 'Alice Martin',
        roles: 'ROLE_ADMIN',
        api_time_consumed: 0,
        account: [DEMO_AXONAUT_ACCOUNT],
      },
    },
    { method: 'GET', url: new RegExp(`^${api}/companies(\\?|$)`), body: DEMO_AXONAUT_COMPANIES },
    { method: 'GET', url: new RegExp(`^${api}/companies/\\d+$`), body: DEMO_AXONAUT_COMPANIES[0] },
    {
      method: 'GET',
      url: new RegExp(`^${api}/companies/\\d+/employees$`),
      body: [{ id: 81, firstname: 'Claire', lastname: 'Rousseau', email: 'claire@globex.example' }],
    },
    {
      method: 'GET',
      url: new RegExp(
        `^${api}/(companies/\\d+/)?(opportunities|quotations|invoices|events)(\\?|$)`,
      ),
      body: [],
    },
    {
      method: 'GET',
      url: new RegExp(`^${api}/(payments|projects|tasks|tickets|products)(\\?|$)`),
      body: [],
    },
    {
      method: 'GET',
      url: new RegExp(`^${api}/[a-z]+/\\d+$`),
      respond: (call) => ({ id: Number(lastSegment(call.url)) }),
    },
    {
      method: 'POST',
      url: new RegExp(`^${api}/[a-z]+(/\\d+/comments)?$`),
      respond: (call) => ({ id: Number.parseInt(random(3), 16), ...(call.json as object) }),
    },
    {
      method: 'PATCH',
      url: new RegExp(`^${api}/[a-z]+/\\d+(/[a-z]+)?$`),
      respond: record('updated'),
    },
    { method: 'DELETE', url: new RegExp(`^${api}/[a-z]+/\\d+$`), status: 200 },
  ];
}

/* ------------------------------------------------------------------------ */
/* The one `fetch`                                                           */
/* ------------------------------------------------------------------------ */

export interface DemoServices {
  /** `RootDeps.serviceFetch`. */
  readonly fetch: typeof fetch;
  /** Every outbound request the instance made, in order (the smoke test reads it). */
  readonly calls: readonly RecordedCall[];
}

export interface DemoServicesOptions {
  /** Told about every request no route answers, before it is refused. */
  readonly onUnmatched?: (error: DemoServiceError) => void;
}

export function createDemoServices(options: DemoServicesOptions = {}): DemoServices {
  const mock = mockFetch([
    ...githubRoutes(),
    ...stripeRoutes(),
    ...cloudflareRoutes(),
    ...resendRoutes(),
    ...upstashRoutes(),
    ...vercelRoutes(),
    ...axonautRoutes(),
  ]);

  const demoFetch: typeof fetch = async (input, init) => {
    try {
      return await mock(input, init);
    } catch {
      // `mockFetch` rejects a request no route matches; say what it means here.
      const last = mock.calls[mock.calls.length - 1];
      const error = new DemoServiceError(last?.method ?? 'GET', last?.url ?? String(input));
      options.onUnmatched?.(error);
      throw error;
    }
  };

  return {
    fetch: demoFetch,
    calls: mock.calls,
  };
}
