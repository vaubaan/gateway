// The v4 exporter: its command line, its .env reading, the v4 decryption (the
// exact v4 scheme, sealed here independently) and the bundle it builds from
// the database's JSON document. No database, no network: the psql read is
// replaced by the document it would return.
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';

import sodium from 'libsodium-wrappers-sumo';
import { describe, expect, it } from 'vitest';

import {
  buildBundle,
  createV4Decryptor,
  ENV_KEYS,
  ExportError,
  exportSql,
  parseArgs,
  parseEnvFile,
  PASTED_KEY_SERVICES,
  requireEnv,
  summaryOf,
  UsageError,
} from './export-v4-lib.mjs';

const ORG = '0b6a1a3e-0000-4000-8000-000000000001';
const OTHER_ORG = '0b6a1a3e-0000-4000-8000-0000000000ee';
const PROJECT = '0b6a1a3e-0000-4000-8000-0000000000a1';
const MASTER = randomBytes(32).toString('base64');
const FINGERPRINT = `SHA256:${randomBytes(32).toString('base64').replace(/=+$/, '')}`;

/**
 * The v4 sealing as service-secrets.ts wrote it.
 * @param {string} orgId
 * @param {string} plaintext
 * @param {string} [master]
 */
async function sealV4(orgId, plaintext, master = MASTER) {
  await sodium.ready;
  const key = sodium.crypto_kdf_derive_from_key(
    32,
    createHash('sha256').update(orgId).digest().readUInt32BE(0) & 0x7fffffff,
    'vaubaan_',
    new Uint8Array(Buffer.from(master, 'base64')),
  );
  const nonce = sodium.randombytes_buf(24);
  const sealed = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    new TextEncoder().encode(plaintext),
    new TextEncoder().encode(orgId),
    null,
    nonce,
    key,
  );
  // Postgres' base64 wraps lines at 76 characters.
  return Buffer.concat([Buffer.from(nonce), Buffer.from(sealed)])
    .toString('base64')
    .replace(/(.{76})/g, '$1\n');
}

const sshKey = () =>
  generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey;

/**
 * @param {Partial<import('./export-v4-lib.mjs').RawExport>} [overrides]
 * @returns {import('./export-v4-lib.mjs').RawExport}
 */
function raw(overrides = {}) {
  return {
    organization: { id: ORG, slug: 'acme', name: 'Acme' },
    projects: [{ id: PROJECT, slug: 'web', name: 'web' }],
    accounts: [],
    bindings: [],
    stripe: [],
    org_ssh: [],
    ssh: [],
    tokens: [],
    child_tokens: 0,
    project_env_vars: '0',
    bash_bindings: 0,
    ...overrides,
  };
}

const options = { org: 'acme', sshHosts: [], sshHostKeys: new Map() };
const NOW = new Date('2026-10-15T08:00:00.000Z');

describe('command line', () => {
  it('reads the organization and the SSH hosts with their fingerprints', () => {
    expect(
      parseArgs([
        '--org',
        'acme',
        '--ssh-host',
        'vps-acme',
        '--ssh-host-key',
        `vps-acme=${FINGERPRINT}=`,
      ]),
    ).toEqual({
      kind: 'run',
      args: {
        org: 'acme',
        sshHosts: ['vps-acme'],
        sshHostKeys: new Map([['vps-acme', FINGERPRINT]]),
      },
    });
  });

  it('refuses a host without its fingerprint, a fingerprint without its host, a bad slug', () => {
    expect(() => parseArgs(['--org', 'acme', '--ssh-host', 'vps-acme'])).toThrow(UsageError);
    expect(() => parseArgs(['--org', 'acme', '--ssh-host-key', `vps=${FINGERPRINT}`])).toThrow(
      'names no --ssh-host',
    );
    expect(() => parseArgs(['--org', 'Acme; drop table'])).toThrow(UsageError);
    expect(() =>
      parseArgs(['--org', 'acme', '--ssh-host', 'a', '--ssh-host-key', 'a=nope']),
    ).toThrow('SHA256');
    expect(() => parseArgs([])).toThrow('--org <slug> is required');
  });

  it('never echoes an unknown argument', () => {
    const secret = randomBytes(16).toString('hex');
    try {
      parseArgs(['--org', 'acme', secret]);
      throw new Error('accepted');
    } catch (error) {
      expect(error).toBeInstanceOf(UsageError);
      expect(String(error)).not.toContain(secret);
    }
  });
});

describe('.env', () => {
  it('reads KEY=value lines, quotes and trailing comments', () => {
    expect(parseEnvFile('# c\nA=1\nB="two words"\nC=x # note\n\nlower=no\n')).toEqual({
      A: '1',
      B: 'two words',
      C: 'x',
    });
  });

  it('names the first missing key', () => {
    const full = Object.fromEntries(ENV_KEYS.map((k) => [k, 'v']));
    expect(requireEnv(full)).toBe(full);
    const { SUPABASE_CORE_POOLER_HOST: _omitted, ...missing } = full;
    expect(() => requireEnv(missing)).toThrow('SUPABASE_CORE_POOLER_HOST is missing');
  });
});

describe('v4 decryption', () => {
  it('opens what v4 sealed, with the organization as associated data', async () => {
    const decryptor = await createV4Decryptor(MASTER);
    const sealed = await sealV4(ORG, 'cloudflare-token-value');
    expect(
      decryptor.decrypt(ORG, new Uint8Array(Buffer.from(sealed.replace(/\s/g, ''), 'base64'))),
    ).toBe('cloudflare-token-value');
  });

  it('refuses another organization, another master key, a cut ciphertext — without quoting it', async () => {
    const decryptor = await createV4Decryptor(MASTER);
    const bytes = new Uint8Array(
      Buffer.from((await sealV4(ORG, 'secret-value')).replace(/\s/g, ''), 'base64'),
    );
    expect(() => decryptor.decrypt(OTHER_ORG, bytes)).toThrow(ExportError);
    const other = await createV4Decryptor(randomBytes(32).toString('base64'));
    expect(() => other.decrypt(ORG, bytes)).toThrow('does not decrypt');
    expect(() => decryptor.decrypt(ORG, bytes.slice(0, 10))).toThrow('too short');
    await expect(createV4Decryptor(randomBytes(16).toString('base64'))).rejects.toThrow('32 bytes');
  });
});

describe('the bundle', () => {
  it('decrypts the keys of the imported services only', async () => {
    const decryptor = await createV4Decryptor(MASTER);
    const bundle = buildBundle(
      raw({
        accounts: [
          {
            id: '0b6a1a3e-0000-4000-8000-0000000000b2',
            service: 'cloudflare-dns',
            status: 'connected',
            team_id: null,
            installation_id: null,
            access_token_sealed: await sealV4(ORG, 'cf-token'),
          },
          {
            id: '0b6a1a3e-0000-4000-8000-0000000000b4',
            service: 'supabase',
            status: 'connected',
            team_id: null,
            installation_id: null,
            // Even if a ciphertext slipped through, a service outside the list is never decrypted.
            access_token_sealed: await sealV4(ORG, 'supabase-oauth-token'),
          },
        ],
      }),
      decryptor,
      options,
      NOW,
    );
    expect(bundle.accounts.map((a) => [a.service, a.access_token])).toEqual([
      ['cloudflare-dns', 'cf-token'],
      ['supabase', null],
    ]);
    expect(bundle.exported_at).toBe(NOW.toISOString());
    expect(bundle.skipped.project_env_vars).toBe(0);
  });

  it('selects no ciphertext for a service whose secret is never imported', () => {
    const sql = exportSql();
    expect(sql).toContain('set default_transaction_read_only = on');
    expect(sql).toContain(`in (${PASTED_KEY_SERVICES.map((p) => `'${p}'`).join(', ')})`);
    expect(sql).not.toMatch(/refresh_token_encrypted/);
    expect(sql).toContain(":'org'");
    expect(sql).toContain('t.denied_risks');
  });

  it('keeps the one Stripe mode each v4 project used, the account holding both keys', async () => {
    const decryptor = await createV4Decryptor(MASTER);
    const second = '0b6a1a3e-0000-4000-8000-0000000000a2';
    const testKey = await sealV4(ORG, 'test-key-value');
    const bundle = buildBundle(
      raw({
        projects: [
          { id: PROJECT, slug: 'web', name: 'web' },
          { id: second, slug: 'api', name: 'api' },
        ],
        stripe: [
          // Test key only: v4 gave this project test mode, never live.
          {
            project_id: second,
            account_id: 'acct_1',
            test_key_sealed: testKey,
            live_key_sealed: null,
          },
          // Both keys: v4 used `live ?? test`, live mode.
          {
            project_id: PROJECT,
            account_id: 'acct_1',
            test_key_sealed: await sealV4(ORG, 'test-key-value'),
            live_key_sealed: await sealV4(ORG, 'live-key-value'),
          },
        ],
      }),
      decryptor,
      options,
      NOW,
    );
    expect(bundle.stripe_accounts).toEqual([
      {
        account_id: 'acct_1',
        projects: [
          { project_id: second, mode: 'test' },
          { project_id: PROJECT, mode: 'live' },
        ],
        test_key: 'test-key-value',
        live_key: 'live-key-value',
      },
    ]);
  });

  it('refuses two different keys of one mode for one Stripe account, without quoting them', async () => {
    const decryptor = await createV4Decryptor(MASTER);
    const second = '0b6a1a3e-0000-4000-8000-0000000000a2';
    const read = raw({
      projects: [
        { id: PROJECT, slug: 'web', name: 'web' },
        { id: second, slug: 'api', name: 'api' },
      ],
      stripe: [
        {
          project_id: second,
          account_id: 'acct_1',
          test_key_sealed: await sealV4(ORG, 'first-test-key'),
          live_key_sealed: null,
        },
        {
          project_id: PROJECT,
          account_id: 'acct_1',
          test_key_sealed: await sealV4(ORG, 'other-test-key'),
          live_key_sealed: null,
        },
      ],
    });
    expect(() => buildBundle(read, decryptor, options, NOW)).toThrow('two different test keys');
    try {
      buildBundle(read, decryptor, options, NOW);
    } catch (error) {
      expect(String(error)).not.toContain('first-test-key');
    }
  });

  it('carries an asked SSH host from another organization, plain-text key as v4 kept it', async () => {
    const decryptor = await createV4Decryptor(MASTER);
    const key = sshKey();
    const row = {
      host_slug: 'vps-ops',
      host_address: 'vps-ops.example.com',
      port: '22',
      ssh_user: 'dev',
      private_key_bytes: Buffer.from(key).toString('base64'),
      org_id: OTHER_ORG,
      org_slug: 'vaubaan',
    };
    const bundle = buildBundle(
      raw({
        org_ssh: [
          { project_id: PROJECT, host_slug: 'vps-ops' },
          { project_id: PROJECT, host_slug: 'vps-other' },
        ],
        ssh: [row, { ...row }],
      }),
      decryptor,
      { org: 'acme', sshHosts: ['vps-ops'], sshHostKeys: new Map([['vps-ops', FINGERPRINT]]) },
      NOW,
    );
    expect(bundle.ssh_hosts).toEqual([
      {
        host_slug: 'vps-ops',
        host_address: 'vps-ops.example.com',
        port: 22,
        user: 'dev',
        private_key: key,
        source_org: 'vaubaan',
        host_key_fingerprint: FINGERPRINT,
        project_ids: [PROJECT],
      },
    ]);
    expect(bundle.skipped.ssh_hosts_not_exported).toEqual(['vps-other']);
  });

  it('reads an SSH key that was sealed, with the key of the organization holding it', async () => {
    const decryptor = await createV4Decryptor(MASTER);
    const key = sshKey();
    const bundle = buildBundle(
      raw({
        ssh: [
          {
            host_slug: 'vps-ops',
            host_address: '10.0.0.4',
            port: 2222,
            ssh_user: 'dev',
            private_key_bytes: await sealV4(OTHER_ORG, key),
            org_id: OTHER_ORG,
            org_slug: 'vaubaan',
          },
        ],
      }),
      decryptor,
      { org: 'acme', sshHosts: ['vps-ops'], sshHostKeys: new Map([['vps-ops', FINGERPRINT]]) },
      NOW,
    );
    expect(bundle.ssh_hosts[0]?.private_key).toBe(key);
  });

  it('refuses SSH rows of one slug that disagree, and a slug nobody holds', async () => {
    const decryptor = await createV4Decryptor(MASTER);
    const row = {
      host_slug: 'vps-ops',
      host_address: 'a.example.com',
      port: 22,
      ssh_user: 'dev',
      private_key_bytes: Buffer.from(sshKey()).toString('base64'),
      org_id: OTHER_ORG,
      org_slug: 'vaubaan',
    };
    const ask = {
      org: 'acme',
      sshHosts: ['vps-ops'],
      sshHostKeys: new Map([['vps-ops', FINGERPRINT]]),
    };
    expect(() =>
      buildBundle(
        raw({ ssh: [row, { ...row, host_address: 'b.example.com' }] }),
        decryptor,
        ask,
        NOW,
      ),
    ).toThrow('disagree');
    expect(() => buildBundle(raw(), decryptor, ask, NOW)).toThrow(
      "no v4 SSH binding has the host slug 'vps-ops'",
    );
  });

  it('refuses an organization that does not exist', async () => {
    const decryptor = await createV4Decryptor(MASTER);
    expect(() => buildBundle(raw({ organization: null }), decryptor, options, NOW)).toThrow(
      "no v4 organization has the slug 'acme'",
    );
  });

  it('keeps the working tokens with their v4 risk ids, and a summary without secrets', async () => {
    const decryptor = await createV4Decryptor(MASTER);
    const bundle = buildBundle(
      raw({
        tokens: [
          {
            id: '0b6a1a3e-0000-4000-8000-0000000000c1',
            project_id: PROJECT,
            name: 'web-agent',
            accepted_risks: ['github.read-code', 42],
            denied_risks: ['github.create-pr'],
            expires_at: null,
          },
        ],
        accounts: [
          {
            id: '0b6a1a3e-0000-4000-8000-0000000000b3',
            service: 'vercel',
            status: 'connected',
            team_id: 'team_a',
            installation_id: null,
            access_token_sealed: await sealV4(ORG, 'vercel-secret-token'),
          },
        ],
      }),
      decryptor,
      options,
      NOW,
    );
    expect(bundle.missions).toEqual([
      {
        token_id: '0b6a1a3e-0000-4000-8000-0000000000c1',
        project_id: PROJECT,
        token_name: 'web-agent',
        accepted_risks: ['github.read-code'],
        denied_risks: ['github.create-pr'],
        expires_at: null,
      },
    ]);
    const summary = summaryOf(bundle);
    expect(summary).toContain('1 working token(s)');
    expect(summary).not.toContain('vercel-secret-token');
  });
});
