/**
 * The v4 importer end to end inside the process (see
 * docs/handbook/import-from-v4.md): the exporter's bundle builder on a fake
 * v4 database read (secrets sealed with the exact v4 scheme), the JSON piped
 * into the importer's command, the REAL composition root on a `:memory:`
 * store with the real encryptor and the real plugins. Providers are a fake
 * `fetch`, the SSH host a fake transport: no network.
 *
 *   dry run (nothing written, no provider contacted) → apply (accounts
 *   checked and sealed, labels carried, a mission issued, a deferred one, the
 *   key on stdout only, every entry marked) → GitHub connected by hand → rerun
 *   completes the deferred mission, duplicates nothing → a third run is a no-op.
 *   Refusals: unknown owner, rejected key, root, missing store, bad bundle.
 */
import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';

import cloudflareDnsPlugin from '@vaubaan/plugin-cloudflare-dns';
import githubPlugin from '@vaubaan/plugin-github';
import { createRegistry, type PluginRegistry } from '@vaubaan/plugin-sdk';
import { createSshPlugin, type ExecResult } from '@vaubaan/plugin-ssh';
import stripePlugin from '@vaubaan/plugin-stripe';
import supabasePlugin from '@vaubaan/plugin-supabase';
import vercelPlugin from '@vaubaan/plugin-vercel';
import sodium from 'libsodium-wrappers-sumo';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RegistryCatalogIndex } from '../../../src/server/compose/registry';
import { loadInstanceConfig, type LoadedConfig } from '../../../src/server/config';
import { validEnv } from '../../support/config/testing';
import { serializeSecret } from '../../../src/server/accounts';
import { createEncryptor } from '../../../src/server/crypto';
import { runImportCli, type CliDeps } from '../../../src/server/import-v4';
import { openMemoryStore, type Store } from '../../../src/server/store';
import { buildBundle, createV4Decryptor } from '../../../../../scripts/export-v4-lib.mjs';

const OWNER = 'owner@example.com';
const ORG_ID = '0b6a1a3e-0000-4000-8000-000000000001';
const PROJECT_WEB = '0b6a1a3e-0000-4000-8000-0000000000a1';
const PROJECT_OPS = '0b6a1a3e-0000-4000-8000-0000000000a2';
const V4_MASTER_KEY = randomBytes(32).toString('base64');
const CLOUDFLARE_TOKEN = `cf${randomBytes(20).toString('hex')}`;
const VERCEL_TOKEN = `vc${randomBytes(12).toString('hex')}`;
const STRIPE_KEY = ['sk', 'test', randomBytes(12).toString('hex')].join('_');
/** The parts of the bundle these tests edit. */
interface V4BundleLike {
  exported_at: string;
  missions: { accepted_risks: string[]; denied_risks: string[] }[];
  stripe_accounts: {
    live_key: string | null;
    projects: { project_id: string; mode: 'test' | 'live' }[];
  }[];
}

const OPS_TOKEN_ID = '0b6a1a3e-0000-4000-8000-0000000000c2';
const FINGERPRINT = `SHA256:${randomBytes(32).toString('base64').replace(/=+$/, '')}`;

/** The v4 sealing (provider-secrets.ts at v4-final), written again here on purpose. */
async function sealV4(orgId: string, plaintext: string): Promise<string> {
  await sodium.ready;
  const master = new Uint8Array(Buffer.from(V4_MASTER_KEY, 'base64'));
  const index = createHash('sha256').update(orgId).digest().readUInt32BE(0) & 0x7fffffff;
  const key = sodium.crypto_kdf_derive_from_key(32, index, 'vaubaan_', master);
  const nonce = sodium.randombytes_buf(24);
  const sealed = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    new TextEncoder().encode(plaintext),
    new TextEncoder().encode(orgId),
    null,
    nonce,
    key,
  );
  return Buffer.concat([Buffer.from(nonce), Buffer.from(sealed)]).toString('base64');
}

/** What `psql` returns for `exportSql()` on a fake v4 database. */
async function fakeV4Read(sshKeyPem: string) {
  return {
    organization: { id: ORG_ID, slug: 'acme', name: 'Acme' },
    projects: [
      { id: PROJECT_OPS, slug: 'ops', name: 'ops' },
      { id: PROJECT_WEB, slug: 'web', name: 'web' },
    ],
    accounts: [
      {
        id: '0b6a1a3e-0000-4000-8000-0000000000b1',
        provider: 'github',
        status: 'connected',
        team_id: null,
        installation_id: '4242',
        access_token_sealed: null,
      },
      {
        id: '0b6a1a3e-0000-4000-8000-0000000000b2',
        provider: 'cloudflare-dns',
        status: 'connected',
        team_id: null,
        installation_id: null,
        access_token_sealed: await sealV4(ORG_ID, CLOUDFLARE_TOKEN),
      },
      {
        id: '0b6a1a3e-0000-4000-8000-0000000000b3',
        provider: 'vercel',
        status: 'connected',
        team_id: 'team_acme01',
        installation_id: null,
        access_token_sealed: await sealV4(ORG_ID, VERCEL_TOKEN),
      },
    ],
    bindings: [
      {
        project_id: PROJECT_WEB,
        provider: 'github',
        resource_ref: 'acme/web',
        display_name: 'web',
        environment: null,
      },
      {
        project_id: PROJECT_WEB,
        provider: 'vercel',
        resource_ref: 'prj_web',
        display_name: 'web',
        environment: 'prod',
      },
      {
        project_id: PROJECT_WEB,
        provider: 'vercel',
        resource_ref: 'prj_web',
        display_name: 'web',
        environment: 'prod',
      },
      {
        project_id: PROJECT_WEB,
        provider: 'cloudflare-dns',
        resource_ref: 'zone_web',
        display_name: 'acme.example',
        environment: 'web',
      },
    ],
    stripe: [
      {
        project_id: PROJECT_WEB,
        account_id: 'acct_1Acme',
        test_key_sealed: await sealV4(ORG_ID, STRIPE_KEY),
        live_key_sealed: null,
      },
    ],
    org_ssh: [{ project_id: PROJECT_OPS, host_slug: 'vps-ops' }],
    ssh: [
      {
        host_slug: 'vps-ops',
        host_address: 'vps-ops.example.com',
        port: 22,
        ssh_user: 'dev',
        // v4 kept the PEM as plain bytes; Postgres base64 wraps lines.
        private_key_bytes: Buffer.from(sshKeyPem)
          .toString('base64')
          .replace(/(.{76})/g, '$1\n'),
        org_id: '0b6a1a3e-0000-4000-8000-0000000000ee',
        org_slug: 'vaubaan',
      },
    ],
    tokens: [
      {
        id: '0b6a1a3e-0000-4000-8000-0000000000c1',
        project_id: PROJECT_WEB,
        name: 'web-agent',
        accepted_risks: [
          'github.read-code',
          'github.create-pr',
          'vercel.read-account',
          'cloudflare-dns.read-zone-metadata',
          'stripe.read-catalog',
          'stripe.teleport',
        ],
        expires_at: null,
      },
      {
        id: OPS_TOKEN_ID,
        project_id: PROJECT_OPS,
        name: 'ops-agent',
        accepted_risks: ['ssh.exec-read', 'ssh.uncategorized-write'],
        expires_at: null,
      },
    ],
    child_tokens: 1,
    project_env_vars: 2,
    bash_bindings: 0,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('import of a v4 organization', () => {
  let loaded: LoadedConfig;
  let registry: PluginRegistry;
  let store: Store;
  let bundleText: string;
  let calls: string[];
  let sshProbes: number;
  let cloudflareRejects: boolean;

  const fakeFetch: typeof fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push(`${url.hostname}${url.pathname}`);
    if (url.hostname === 'api.cloudflare.com' && url.pathname.endsWith('/user/tokens/verify')) {
      if (cloudflareRejects)
        return json({ success: false, errors: [{ message: 'Invalid API Token' }] }, 401);
      return json({ success: true, result: { id: 'tok_web', status: 'active' } });
    }
    if (url.hostname === 'api.cloudflare.com' && url.pathname.endsWith('/zones')) {
      if (cloudflareRejects)
        return json({ success: false, errors: [{ message: 'Invalid API Token' }] }, 403);
      return json({
        success: true,
        result: [{ id: 'zone_web', name: 'acme.example', account: { id: 'cfacc', name: 'Acme' } }],
        result_info: { total_pages: 1 },
      });
    }
    if (url.hostname === 'api.vercel.com' && url.pathname === '/v5/user/tokens/current') {
      return json({ token: { id: 'tk_web', name: 'v4 import' } });
    }
    if (url.hostname === 'api.vercel.com' && url.pathname === '/v2/teams/team_acme01') {
      return json({ id: 'team_acme01', slug: 'acme', name: 'Acme' });
    }
    if (url.hostname === 'api.vercel.com' && url.pathname === '/v10/projects') {
      return json({ projects: [{ id: 'prj_web', name: 'web' }], pagination: { next: null } });
    }
    if (url.hostname === 'api.stripe.com' && url.pathname === '/v1/account') {
      return json({ id: 'acct_1Acme', settings: { dashboard: { display_name: 'Acme' } } });
    }
    return json({ message: `unexpected ${url.href}` }, 404);
  };

  beforeEach(async () => {
    calls = [];
    sshProbes = 0;
    cloudflareRejects = false;
    loaded = loadInstanceConfig({ env: validEnv() });
    const sshBase = createSshPlugin({
      transport: {
        async exec(): Promise<ExecResult> {
          sshProbes += 1;
          return {
            stdout: 'vps-ops Linux 6.1 x86_64\n',
            stderr: '',
            exit_code: 0,
            duration_ms: 3,
            truncated: false,
          };
        },
      },
    });
    // v4 kept no environment for an SSH host, and SSH permissions depend on it: an
    // unlabelled host enters no mission (ADR
    // resource-set-is-one-environment-with-optional-future-resources). The host of these
    // tests is labelled `prod` by its discovery, as an owner would label it before a rerun.
    const sshPlugin: typeof sshBase = {
      ...sshBase,
      discoverResources: async (ctx) =>
        (await sshBase.discoverResources(ctx)).map((r) => ({ ...r, env: 'prod' })),
    };
    registry = createRegistry([
      githubPlugin,
      vercelPlugin,
      supabasePlugin,
      stripePlugin,
      cloudflareDnsPlugin,
      sshPlugin,
    ]);
    const encryptor = await createEncryptor(loaded.config.encryption);
    store = openMemoryStore({ encryptor, catalog: new RegistryCatalogIndex(registry) });
    const owner = await store.users.upsertFromIdp({
      issuer: 'http://idp.test',
      subject: 'owner',
      email: OWNER,
    });
    // The instance has booted once already: its administrators live in the store.
    await store.administrators.addUser(owner.id, {
      grantedBy: 'configuration',
      origin: 'configuration',
    });

    const { generateKeyPairSync } = await import('node:crypto');
    const sshKey = generateKeyPairSync('ed25519', {
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    }).privateKey;
    const decryptor = await createV4Decryptor(V4_MASTER_KEY);
    const bundle = buildBundle(
      await fakeV4Read(sshKey),
      decryptor,
      { org: 'acme', sshHosts: ['vps-ops'], sshHostKeys: new Map([['vps-ops', FINGERPRINT]]) },
      new Date(),
    );
    bundleText = JSON.stringify(bundle);
  });

  afterEach(async () => {
    await store.close();
  });

  function deps(overrides: Partial<CliDeps> = {}): CliDeps {
    // The command closes the root after each run; the shared memory store survives it.
    const shared: Store = { ...store, close: async () => undefined };
    return {
      loadConfig: () => loaded,
      storeExists: () => true,
      rootDeps: {
        buildRegistry: async () => registry,
        openStore: async () => shared,
        providerFetch: fakeFetch,
      },
      ...overrides,
    };
  }

  async function run(
    args: string[],
    options: { stdin?: string; uid?: number; deps?: CliDeps } = {},
  ) {
    let stdout = '';
    let stderr = '';
    const code = await runImportCli(
      args,
      {
        stdin: Readable.from([options.stdin ?? bundleText]),
        stdout: (t) => {
          stdout += t;
        },
        stderr: (t) => {
          stderr += t;
        },
        uid: options.uid ?? 1000,
      },
      options.deps ?? deps(),
    );
    return { code, stdout, stderr };
  }

  async function ownerId(): Promise<string> {
    const [user] = await store.users.findByEmail(OWNER);
    if (!user) throw new Error('owner');
    return user.id;
  }

  function databaseText(): string {
    const tables = store.db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .all();
    const parts: string[] = [];
    for (const { name } of tables) {
      for (const row of store.db
        .prepare<[], Record<string, unknown>>(`SELECT * FROM "${name}"`)
        .all()) {
        for (const value of Object.values(row)) {
          parts.push(Buffer.isBuffer(value) ? value.toString('latin1') : String(value));
        }
      }
    }
    return parts.join('\n');
  }

  function adminEntries(): number {
    return store.db
      .prepare<[], { n: number }>("SELECT count(*) AS n FROM audit WHERE kind = 'admin'")
      .get()!.n;
  }

  async function connectGithubByHand(): Promise<void> {
    const account = await store.accounts.create({
      provider: 'github',
      owner: { kind: 'user', id: await ownerId() },
      displayName: 'GitHub',
      credential: serializeSecret({
        kind: 'api-key',
        fields: { token: 'github_pat_fake' },
        metadata: {},
      }),
      metadata: { credential_kind: 'api-key', fields: {} },
    });
    await store.accounts.syncDiscoveredResources(account.id, [
      { ref: 'acme/web', displayName: 'acme/web', env: null, metadata: null },
    ]);
  }

  it('a dry run prints the plan, writes nothing and contacts no provider', async () => {
    const before = databaseText();
    const { code, stdout, stderr } = await run(['--owner', OWNER]);

    expect(code).toBe(0);
    expect(stdout).toBe('');
    expect(stderr).toContain('DRY RUN');
    expect(stderr).toMatch(/cloudflare-dns ".*": to create/);
    expect(stderr).toMatch(/vercel ".*": to create/);
    expect(stderr).toMatch(/stripe ".*": to create/);
    expect(stderr).toMatch(/ssh "vps-ops": to create/);
    expect(stderr).toMatch(/github: TO CONNECT/);
    expect(stderr).toContain('"web" (v4 token web-agent): deferred');
    expect(stderr).toContain('"ops" (v4 token ops-agent): issued at --apply once');
    expect(stderr).toContain('2 project variable(s)');
    expect(calls).toEqual([]);
    expect(sshProbes).toBe(0);
    expect(await store.accounts.list()).toEqual([]);
    expect(await store.missions.listForCreator(await ownerId())).toEqual([]);
    expect(adminEntries()).toBe(0);
    expect(databaseText()).toBe(before);
    for (const secret of [CLOUDFLARE_TOKEN, VERCEL_TOKEN, STRIPE_KEY]) {
      expect(stderr).not.toContain(secret);
    }
  });

  it('apply creates, labels, issues what it can and prints the key once on stdout', async () => {
    const { code, stdout, stderr } = await run(['--owner', OWNER, '--apply']);
    expect(code).toBe(0);

    const accounts = await store.accounts.list();
    expect(accounts.map((c) => c.provider).sort()).toEqual([
      'cloudflare-dns',
      'ssh',
      'stripe',
      'vercel',
    ]);
    const owner = await ownerId();
    expect(accounts.every((c) => c.owner.kind === 'user' && c.owner.id === owner)).toBe(true);
    expect(sshProbes).toBe(1);

    // The Vercel project carried its `prod` label; the Cloudflare zone's `web` is not a v5 label.
    const vercel = accounts.find((c) => c.provider === 'vercel')!;
    const [project] = await store.accounts.listResources(vercel.id);
    expect(project).toMatchObject({ ref: 'prj_web', env: 'prod', envSource: 'owner' });
    const cloudflare = accounts.find((c) => c.provider === 'cloudflare-dns')!;
    expect((await store.accounts.listResources(cloudflare.id))[0]?.env).toBeNull();
    expect(stderr).toContain('zone_web: left unlabelled');

    // `web` waits for GitHub; `ops` is issued with both SSH risks: the fallback
    // comes from "Anything else", at its base budget at Trusting.
    expect(stderr).toContain('"web" (v4 token web-agent): deferred');
    expect(stderr).toContain('GitHub: no account connected yet');
    const missions = await store.missions.listForCreator(owner);
    expect(missions.map((m) => m.name)).toEqual(['ops']);
    expect(missions[0]!.policy.map((p) => p.riskId)).toEqual([
      'ssh.exec-read',
      'ssh.uncategorized-write',
    ]);
    const fallback = missions[0]!.policy.find((p) => p.riskId === 'ssh.uncategorized-write')!;
    // The fallback is costly (row 3): Trusting asks first.
    expect([fallback.quota, fallback.gate]).toEqual([150, 'approval']);
    expect(missions[0]!.periodSeconds).toBe(86_400);
    expect(stderr).not.toContain('dropped ssh.uncategorized-write');

    const keys = stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, string>);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({
      project: 'ops',
      mission_id: missions[0]!.id,
      token_name: 'ops-agent',
    });
    expect(keys[0]!.key).toMatch(/^vbn_live_/);
    expect(stderr).not.toContain(keys[0]!.key);

    // Sealed at rest, never in the report; every entry is the owner's and marked.
    const text = databaseText();
    for (const secret of [CLOUDFLARE_TOKEN, VERCEL_TOKEN, STRIPE_KEY, keys[0]!.key]) {
      expect(text).not.toContain(secret);
      expect(stderr).not.toContain(secret);
    }
    const entries = store.db
      .prepare<[], { user_id: string; after_json: string | null; act: string }>(
        "SELECT user_id, after_json, act FROM audit WHERE kind = 'admin'",
      )
      .all();
    expect(entries.length).toBeGreaterThanOrEqual(6);
    for (const entry of entries) {
      expect(entry.user_id).toBe(owner);
      expect(JSON.parse(entry.after_json ?? '{}')).toMatchObject({
        marker: 'imported-from-v4',
        v4_org: 'acme',
      });
    }
    expect(entries.map((e) => e.act)).toEqual(
      expect.arrayContaining(['account-created', 'mission-issued']),
    );
  });

  it('a rerun completes the deferred mission once GitHub is connected, and duplicates nothing', async () => {
    await run(['--owner', OWNER, '--apply']);
    await connectGithubByHand();
    const callsBefore = calls.length;

    const second = await run(['--owner', OWNER, '--apply']);
    if (process.env.SHOW_IMPORT_REPORT) process.stderr.write(second.stderr);
    expect(second.code).toBe(0);
    expect(calls.length).toBe(callsBefore); // nothing created again: no provider asked
    expect(second.stderr).toContain('already imported by an earlier run');
    expect(second.stderr).toContain('"ops" (v4 token ops-agent): already exists');
    expect(second.stderr).toContain('"web" (v4 token web-agent): issued');
    expect(second.stderr).toContain('dropped stripe.teleport: unknown to the v5 catalog');
    expect(second.stderr).toContain('~ stripe.read-catalog → stripe[test].read-catalog');

    const owner = await ownerId();
    const missions = await store.missions.listForCreator(owner);
    expect(missions.map((m) => m.name).sort()).toEqual(['ops', 'web']);
    const web = missions.find((m) => m.name === 'web')!;
    const providers = await Promise.all(
      web.accounts.map(async (c) => (await store.accounts.getById(c.accountId))?.provider),
    );
    expect(providers.sort()).toEqual(['cloudflare-dns', 'github', 'stripe', 'vercel']);
    expect(web.policy.map((p) => p.riskId).sort()).toEqual(
      [
        'cloudflare-dns.read-zone-metadata',
        'github.create-pr',
        'github.read-code',
        'stripe[test].read-catalog',
        'vercel.read-account',
      ].sort(),
    );
    const keys = second.stdout
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, string>);
    expect(keys.map((k) => k.project)).toEqual(['web']);
    expect((await store.accounts.list()).length).toBe(5);

    const third = await run(['--owner', OWNER, '--apply']);
    expect(third.code).toBe(0);
    expect(third.stdout).toBe('');
    expect((await store.accounts.list()).length).toBe(5);
    expect((await store.missions.listForCreator(owner)).length).toBe(2);
  });

  it('a key the service rejects is reported, not stored; the rest goes on', async () => {
    cloudflareRejects = true;
    const { code, stderr } = await run(['--owner', OWNER, '--apply']);
    expect(code).toBe(1);
    expect(stderr).toMatch(/cloudflare-dns ".*": refused, nothing stored — credential-rejected/);
    expect(stderr).not.toContain(CLOUDFLARE_TOKEN);
    const providers = (await store.accounts.list()).map((c) => c.provider).sort();
    expect(providers).toEqual(['ssh', 'stripe', 'vercel']);
  });

  it('refuses an owner who never signed in, before writing anything', async () => {
    const { code, stderr, stdout } = await run(['--owner', 'stranger@example.com', '--apply']);
    expect(code).toBe(67);
    expect(stderr).toContain('signs in once');
    expect(stdout).toBe('');
    expect(await store.accounts.list()).toEqual([]);
  });

  /** The bundle of this suite, changed by `edit`. */
  function bundleWith(edit: (bundle: Record<string, unknown> & V4BundleLike) => void): string {
    const bundle = JSON.parse(bundleText) as Record<string, unknown> & V4BundleLike;
    edit(bundle);
    return JSON.stringify(bundle);
  }

  function missionPolicy(name: string) {
    return async () => {
      const missions = await store.missions.listForCreator(await ownerId());
      return missions.find((m) => m.name === name)?.policy.map((p) => p.riskId) ?? null;
    };
  }

  it('honours a v4 denial: an accepted and denied permission is not imported', async () => {
    await connectGithubByHand();
    const stdin = bundleWith((b) => {
      b.missions[0]!.denied_risks = ['github.create-pr'];
    });
    const { code, stderr } = await run(['--owner', OWNER, '--apply'], { stdin });
    expect(code).toBe(0);
    expect(stderr).toContain('dropped github.create-pr: denied in v4');
    const policy = await missionPolicy('web')();
    expect(policy).toContain('github.read-code');
    expect(policy).not.toContain('github.create-pr');
  });

  it('gives a Stripe project only the mode v4 gave it, never the other', async () => {
    await connectGithubByHand();
    const liveKey = ['sk', 'live', randomBytes(12).toString('hex')].join('_');
    const stdin = bundleWith((b) => {
      const account = b.stripe_accounts[0]!;
      account.live_key = liveKey;
      account.projects = [
        { project_id: PROJECT_WEB, mode: 'test' },
        { project_id: PROJECT_OPS, mode: 'live' },
      ];
      b.missions[0]!.accepted_risks.push('stripe.refund-create');
    });
    const { code, stderr } = await run(['--owner', OWNER, '--apply'], { stdin });
    expect(code).toBe(0);
    expect(stderr).not.toContain(liveKey);
    const stripe = (await store.accounts.list()).find((c) => c.provider === 'stripe')!;
    const refs = (await store.accounts.listResources(stripe.id)).map((r) => r.ref).sort();
    expect(refs).toEqual(['acct_1Acme/live', 'acct_1Acme/test']);
    const policy = (await missionPolicy('web')()) ?? [];
    expect(policy.filter((id) => id.startsWith('stripe'))).toEqual(
      expect.arrayContaining(['stripe[test].read-catalog']),
    );
    expect(policy.some((id) => id.startsWith('stripe[live]'))).toBe(false);
  });

  it('recognises an imported mission by its v4 token, not by its name', async () => {
    const owner = await ownerId();
    const first = await run(['--owner', OWNER, '--apply']);
    expect(first.stderr).toContain('"ops" (v4 token ops-agent): issued');
    const ops = (await store.missions.listForCreator(owner)).find((m) => m.name === 'ops')!;

    // The owner renames the imported mission, and makes one by hand named like
    // the v4 project still waiting for GitHub.
    store.db.prepare('UPDATE missions SET name = ? WHERE id = ?').run('ops (renamed)', ops.id);
    const vercel = (await store.accounts.list()).find((c) => c.provider === 'vercel')!;
    const handMade = await store.missions.create({
      name: 'web',
      creatorUserId: owner,
      periodSeconds: null,
      accounts: [{ accountId: vercel.id, resourceIds: [] }],
      policy: [],
    });
    await connectGithubByHand();

    const second = await run(['--owner', OWNER, '--apply']);
    // The renamed one is still the import's; the hand-made namesake is not.
    expect(second.stderr).toContain('"ops" (v4 token ops-agent): already exists');
    expect(second.stderr).toContain(ops.id);
    expect(second.stderr).toContain('"web" (v4 token web-agent): issued');
    const webs = (await store.missions.listForCreator(owner)).filter((m) => m.name === 'web');
    expect(webs).toHaveLength(2);
    expect((await store.missions.getById(handMade.id))?.policy).toEqual([]);
    const keys = second.stdout.trim().split('\n');
    expect(keys).toHaveLength(1);
    expect(JSON.parse(keys[0]!)).toMatchObject({ project: 'web' });
  });

  it('refuses a stale bundle unless asked, and one from the future', async () => {
    const stale = bundleWith((b) => {
      b.exported_at = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    });
    const refused = await run(['--owner', OWNER, '--apply'], { stdin: stale });
    expect(refused.code).toBe(65);
    expect(refused.stderr).toContain('--allow-stale');
    expect(await store.accounts.list()).toEqual([]);
    const allowed = await run(['--owner', OWNER, '--allow-stale'], { stdin: stale });
    expect(allowed.code).toBe(0);
    const future = bundleWith((b) => {
      b.exported_at = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    });
    expect((await run(['--owner', OWNER], { stdin: future })).code).toBe(65);
  });

  it('prints one fixed line for an unexpected failure, never its message', async () => {
    const secretish = CLOUDFLARE_TOKEN;
    const { code, stderr } = await run(['--owner', OWNER], {
      deps: deps({
        loadConfig: () => {
          throw new Error(`boom ${secretish}`);
        },
      }),
    });
    expect(code).toBe(1);
    expect(stderr).toContain('unexpected failure');
    expect(stderr).not.toContain(secretish);
  });

  it('refuses root, a missing store and an invalid bundle', async () => {
    expect((await run(['--owner', OWNER], { uid: 0 })).code).toBe(77);
    expect((await run(['--owner', OWNER], { deps: deps({ storeExists: () => false }) })).code).toBe(
      78,
    );
    const bad = await run(['--owner', OWNER], {
      stdin: bundleText.replace('"version":1', '"version":9'),
    });
    expect(bad.code).toBe(65);
    expect(bad.stderr).toContain('nothing was written');
    const garbage = await run(['--owner', OWNER], { stdin: `${CLOUDFLARE_TOKEN} {` });
    expect(garbage.code).toBe(65);
    expect(garbage.stderr).not.toContain(CLOUDFLARE_TOKEN);
  });

  it('--carry-unbudgeted carries nothing a macro-action budgets: the fallback keeps its base budget', async () => {
    // Every live risk of a shipped catalog is in a macro-action, the fallback in
    // "Anything else": the flag has nothing left to carry from them.
    const { code, stderr } = await run(['--owner', OWNER, '--apply', '--carry-unbudgeted', '5']);
    expect(code).toBe(0);
    expect(stderr).not.toContain('~ carried under approval');
    expect(stderr).not.toContain('dropped ssh.uncategorized-write');
    const [ops] = await store.missions.listForCreator(await ownerId());
    expect(ops!.policy.map((p) => [p.riskId, p.quota, p.gate]).sort()).toEqual([
      ['ssh.exec-read', expect.any(Number), expect.stringMatching(/^(auto|approval)$/)],
      ['ssh.uncategorized-write', 150, 'approval'],
    ]);

    // Every other reason stays a drop.
    await connectGithubByHand();
    const second = await run(['--owner', OWNER, '--apply', '--carry-unbudgeted', '5']);
    expect(second.stderr).toContain('dropped stripe.teleport: unknown to the v5 catalog');
  });

  it('--reissue issues a token again beside the earlier import, which it never revokes', async () => {
    const owner = await ownerId();
    await run(['--owner', OWNER, '--apply']);
    const [old] = await store.missions.listForCreator(owner);
    expect(old!.name).toBe('ops');

    // Dry run: shows the new issuance and names the earlier one; writes nothing.
    const entriesBefore = adminEntries();
    const dry = await run(['--owner', OWNER, '--reissue', OPS_TOKEN_ID, '--carry-unbudgeted', '3']);
    expect(dry.code).toBe(0);
    expect(dry.stdout).toBe('');
    expect(dry.stderr).toContain('"ops" (v4 token ops-agent): would be issued');
    expect(dry.stderr).toContain(
      `previous import [${old!.id.slice(-8)} · ${old!.id}] still active: revoke it once the new key is installed`,
    );
    expect(dry.stderr).not.toContain('~ carried under approval');
    expect(adminEntries()).toBe(entriesBefore);

    const applied = await run([
      '--owner',
      OWNER,
      '--apply',
      '--reissue',
      OPS_TOKEN_ID,
      '--carry-unbudgeted',
      '3',
    ]);
    expect(applied.code).toBe(0);
    const missions = await store.missions.listForCreator(owner);
    const opses = missions.filter((m) => m.name === 'ops');
    expect(opses).toHaveLength(2);
    const fresh = opses.find((m) => m.id !== old!.id)!;
    expect((await store.missions.getById(old!.id))?.status).toBe('active');
    expect(fresh.policy.map((p) => p.riskId).sort()).toEqual([
      'ssh.exec-read',
      'ssh.uncategorized-write',
    ]);
    expect(applied.stderr).toContain(
      `"ops" (v4 token ops-agent): issued [${fresh.id.slice(-8)} · ${fresh.id}]`,
    );
    expect(applied.stderr).toContain(
      `previous import [${old!.id.slice(-8)} · ${old!.id}] still active`,
    );
    const keys = applied.stdout
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, string>);
    expect(keys).toEqual([expect.objectContaining({ project: 'ops', mission_id: fresh.id })]);

    // A later run without --reissue recognises the newest one.
    const later = await run(['--owner', OWNER, '--apply']);
    const opsLine = later.stderr.split('\n').find((l) => l.includes('(v4 token ops-agent)'));
    expect(opsLine).toContain('already exists');
    expect(opsLine).toContain(fresh.id);
    expect(later.stdout).toBe('');
    expect(
      (await store.missions.listForCreator(owner)).filter((m) => m.name === 'ops'),
    ).toHaveLength(2);
  });

  it('a dry run checks the issuance with the labels it would set, and agrees with --apply', async () => {
    // The first apply creates the keyed accounts; GitHub and Supabase are then connected
    // by hand, the Supabase project without a label. v4 bound it to `web` as `prod`.
    await run(['--owner', OWNER, '--apply']);
    await connectGithubByHand();
    const supabase = await store.accounts.create({
      provider: 'supabase',
      owner: { kind: 'user', id: await ownerId() },
      displayName: 'Supabase',
      credential: serializeSecret({
        kind: 'api-key',
        fields: { token: 'sbp_fake' },
        metadata: {},
      }),
      metadata: { credential_kind: 'api-key', fields: {} },
    });
    await store.accounts.syncDiscoveredResources(supabase.id, [
      { ref: 'sbref01', displayName: 'web-db', env: null, metadata: null },
    ]);
    const bundle = JSON.parse(bundleText) as {
      bindings: Record<string, unknown>[];
      missions: { project_id: string; accepted_risks: string[] }[];
    };
    bundle.bindings.push({
      project_id: PROJECT_WEB,
      provider: 'supabase',
      resource_ref: 'sbref01',
      display_name: 'web-db',
      environment: 'prod',
    });
    // Account-scoped in v4, env-scoped in v5: reachable only once the project is labelled.
    bundle.missions
      .find((m) => m.project_id === PROJECT_WEB)!
      .accepted_risks.push('supabase.migration-write');
    const stdin = JSON.stringify(bundle);

    const entriesBefore = adminEntries();
    const dry = await run(['--owner', OWNER], { stdin });
    expect(dry.stderr).toContain('supabase sbref01: to label → prod');
    expect(dry.stderr).toContain('"web" (v4 token web-agent): would be issued');
    expect(dry.stderr).not.toContain('refused by the issuance check');
    expect(dry.code).toBe(0);
    // Read as set, never written.
    expect((await store.accounts.listResources(supabase.id))[0]?.env).toBeNull();
    expect(adminEntries()).toBe(entriesBefore);

    const applied = await run(['--owner', OWNER, '--apply'], { stdin });
    expect(applied.code).toBe(0);
    expect(applied.stderr).toContain('"web" (v4 token web-agent): issued');
    expect((await store.accounts.listResources(supabase.id))[0]?.env).toBe('prod');
    const web = (await store.missions.listForCreator(await ownerId())).find(
      (m) => m.name === 'web',
    )!;
    expect(web.policy.map((p) => p.riskId)).toContain('supabase[prod].migration-write');
  });

  it('refuses a --reissue id the bundle does not hold, before writing anything', async () => {
    const stranger = '83e35806-6201-47e5-8f03-c0ae2cd604a4';
    const { code, stderr, stdout } = await run([
      '--owner',
      OWNER,
      '--apply',
      '--reissue',
      stranger,
    ]);
    expect(code).toBe(64);
    expect(stderr).toContain(stranger);
    expect(stderr).toContain('Nothing was written');
    expect(stdout).toBe('');
    expect(await store.accounts.list()).toEqual([]);
    expect(adminEntries()).toBe(0);
  });
});
