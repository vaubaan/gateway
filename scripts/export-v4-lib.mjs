// The v4 exporter's logic (scripts/export-v4.mjs does the I/O): the one SQL
// read of the v4 database, the decryption of the v4 secrets with the exact v4
// scheme, and the bundle the importer reads (ADR
// import-from-v4-one-shot-importer D2; handbook docs/handbook/import-from-v4.md).
//
// The bundle's shape is the importer's schema
// (apps/gateway/src/server/import-v4/bundle.ts); an integration test runs the
// two together. Secrets exist here only in memory: nothing is written to disk.

import { createHash } from 'node:crypto';

import sodium from 'libsodium-wrappers-sumo';

export const BUNDLE_FORMAT = 'vaubaan-v4-export';
export const BUNDLE_VERSION = 1;

/**
 * v4 providers whose stored token is exported, decrypted. Every other v4
 * secret (GitHub App installation, Railway and Supabase OAuth grants) is never
 * read: the SQL selects no ciphertext for them. Mirrors PASTED_KEY_PROVIDERS of
 * the importer, which refuses a secret for any other provider.
 */
export const PASTED_KEY_PROVIDERS = Object.freeze(['cloudflare-dns', 'vercel']);

/** Keys the exporter reads from the repository's `.env`. */
export const ENV_KEYS = Object.freeze([
  'SUPABASE_CORE_PROJECT_REF',
  'VAUBAAN_CORE_DB_PASSWORD',
  'SUPABASE_CORE_POOLER_HOST',
  'ENCRYPTION_MASTER_KEY',
]);

const SLUG = /^[a-z0-9](-?[a-z0-9])*$/;
const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}=?$/;
const KDF_CONTEXT = 'vaubaan_';
const NONCE_BYTES = 24;
const KEY_BYTES = 32;

/** A problem the exporter reports by its message alone (never a secret, never a stack). */
export class ExportError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ExportError';
  }
}

/** A wrong command line (exit 64). */
export class UsageError extends ExportError {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

export const USAGE = `Usage: node scripts/export-v4.mjs --org <slug> [--ssh-host <slug> --ssh-host-key <slug>=SHA256:…]…

Reads one organization of the v4 database (read-only) and writes the import
bundle on stdout, nothing else; pipe it into the importer of the instance.

  --org <slug>                    the v4 organization (dalae, fidi, …)
  --ssh-host <slug>               an SSH host to carry, from whichever organization
                                  holds it (repeatable)
  --ssh-host-key <slug>=SHA256:…  its host key fingerprint; v4 pinned none, the
                                  v5 SSH plugin refuses a host without one
                                  (ssh-keyscan -t ed25519 <host> | ssh-keygen -lf -)

Reads SUPABASE_CORE_PROJECT_REF, VAUBAAN_CORE_DB_PASSWORD, SUPABASE_CORE_POOLER_HOST
and ENCRYPTION_MASTER_KEY from the repository's .env. Needs psql on the PATH.
Handbook: docs/handbook/import-from-v4.md
`;

/**
 * @typedef {{ org: string, sshHosts: string[], sshHostKeys: Map<string, string> }} ExportArgs
 * @param {readonly string[]} argv
 * @returns {{ kind: 'help' } | { kind: 'run', args: ExportArgs }}
 */
export function parseArgs(argv) {
  /** @type {string | null} */
  let org = null;
  /** @type {string[]} */
  const sshHosts = [];
  /** @type {Map<string, string>} */
  const sshHostKeys = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { kind: 'help' };
    const value = argv[i + 1];
    if (arg === '--org' || arg === '--ssh-host' || arg === '--ssh-host-key') {
      if (value === undefined || value.startsWith('--')) {
        throw new UsageError(`${arg} needs a value`);
      }
      i += 1;
      if (arg === '--org') org = slugOrThrow(value, '--org');
      else if (arg === '--ssh-host') sshHosts.push(slugOrThrow(value, '--ssh-host'));
      else {
        const at = value.indexOf('=');
        const fingerprint = value.slice(at + 1).trim();
        if (at <= 0 || !FINGERPRINT.test(fingerprint)) {
          throw new UsageError('--ssh-host-key takes <slug>=SHA256:<base64>');
        }
        const host = slugOrThrow(value.slice(0, at), '--ssh-host-key');
        sshHostKeys.set(host, fingerprint.replace(/=+$/, ''));
      }
      continue;
    }
    throw new UsageError(`unknown argument #${i + 1}`);
  }
  if (org === null) throw new UsageError('--org <slug> is required');
  for (const host of sshHosts) {
    if (!sshHostKeys.has(host)) {
      throw new UsageError(`--ssh-host ${host} needs --ssh-host-key ${host}=SHA256:…`);
    }
  }
  for (const host of sshHostKeys.keys()) {
    if (!sshHosts.includes(host))
      throw new UsageError(`--ssh-host-key ${host} names no --ssh-host`);
  }
  return { kind: 'run', args: { org, sshHosts: [...new Set(sshHosts)], sshHostKeys } };
}

/**
 * @param {string} value
 * @param {string} flag
 */
function slugOrThrow(value, flag) {
  if (!SLUG.test(value))
    throw new UsageError(`${flag} takes a v4 slug (lower-case letters, digits, dashes)`);
  return value;
}

/**
 * `KEY=value` lines of a `.env` file (comments and blank lines ignored).
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseEnvFile(text) {
  /** @type {Record<string, string>} */
  const env = {};
  for (const line of text.split('\n')) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (!m) continue;
    let value = (m[2] ?? '').trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    env[m[1] ?? ''] = value;
  }
  return env;
}

/**
 * The exporter's settings, failing on the first missing key by its name.
 * @param {Record<string, string>} env
 * @returns {Record<(typeof ENV_KEYS)[number], string>}
 */
export function requireEnv(env) {
  for (const key of ENV_KEYS) {
    if (!env[key]) throw new ExportError(`${key} is missing from the repository's .env`);
  }
  return /** @type {Record<(typeof ENV_KEYS)[number], string>} */ (env);
}

/**
 * The v4 decryption (packages/web/src/lib/crypto/provider-secrets.ts on the
 * v4-final tag): XChaCha20-Poly1305 (IETF), a per-organization key derived
 * from the master key with `crypto_kdf_derive_from_key` (context `vaubaan_`,
 * subkey index = the first 31 bits of SHA-256(org id)), associated data = the
 * org id, nonce prepended to the ciphertext.
 * @param {string} masterKeyBase64
 */
export async function createV4Decryptor(masterKeyBase64) {
  await sodium.ready;
  const master = new Uint8Array(Buffer.from(masterKeyBase64, 'base64'));
  if (master.length !== KEY_BYTES) {
    throw new ExportError(`ENCRYPTION_MASTER_KEY must decode to ${KEY_BYTES} bytes`);
  }
  return {
    /**
     * @param {string} orgId
     * @param {Uint8Array} sealed
     * @returns {string}
     */
    decrypt(orgId, sealed) {
      if (sealed.length < NONCE_BYTES + 1) throw new ExportError('a v4 ciphertext is too short');
      const index = createHash('sha256').update(orgId).digest().readUInt32BE(0) & 0x7fffffff;
      const key = sodium.crypto_kdf_derive_from_key(KEY_BYTES, index, KDF_CONTEXT, master);
      try {
        const plain = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
          null,
          sealed.slice(NONCE_BYTES),
          new TextEncoder().encode(orgId),
          sealed.slice(0, NONCE_BYTES),
          key,
        );
        return new TextDecoder().decode(plain);
      } catch {
        throw new ExportError('a v4 secret does not decrypt with ENCRYPTION_MASTER_KEY');
      } finally {
        sodium.memzero(key);
      }
    },
  };
}

/** @param {string | null | undefined} base64 */
function bytesOf(base64) {
  return new Uint8Array(Buffer.from(String(base64 ?? '').replace(/\s+/g, ''), 'base64'));
}

/**
 * The one read of the v4 database: a single statement in a read-only session
 * that returns one JSON document. `:'org'` and `:'hosts'` are psql variables
 * (quoted by psql as literals); only the tokens of PASTED_KEY_PROVIDERS are
 * selected as ciphertext.
 */
export function exportSql() {
  const pasted = PASTED_KEY_PROVIDERS.map((p) => `'${p}'`).join(', ');
  return `set default_transaction_read_only = on;
with org as (select id, slug, name from organizations where slug = :'org'),
     prj as (select p.id, p.slug, p.name from projects p join org on p.organization_id = org.id)
select json_build_object(
  'organization', (select row_to_json(org) from org),
  'projects', (select coalesce(json_agg(prj order by prj.slug), '[]'::json) from prj),
  'accounts', (select coalesce(json_agg(a order by a.provider), '[]'::json) from (
      select pa.id, pa.provider, pa.status, pa.team_id, pa.installation_id,
             case when pa.provider in (${pasted})
                  then encode(pa.access_token_encrypted, 'base64') end as access_token_sealed
      from provider_admins pa join org on pa.organization_id = org.id) a),
  'bindings', (select coalesce(json_agg(b), '[]'::json) from (
      select pb.project_id, pb.provider, pb.resource_ref, pb.display_name, pb.environment
      from provider_bindings pb join prj on pb.project_id = prj.id
      where pb.provider <> 'bash') b),
  'stripe', (select coalesce(json_agg(s), '[]'::json) from (
      select sb.project_id, sb.account_id,
             encode(sb.test_key_encrypted, 'base64') as test_key_sealed,
             encode(sb.live_key_encrypted, 'base64') as live_key_sealed
      from stripe_bindings sb join prj on sb.project_id = prj.id) s),
  'org_ssh', (select coalesce(json_agg(h), '[]'::json) from (
      select sb.project_id, sb.host_slug
      from ssh_bindings sb join prj on sb.project_id = prj.id) h),
  'ssh', (select coalesce(json_agg(h), '[]'::json) from (
      select sb.host_slug, sb.host_address, sb.port, sb.ssh_user,
             encode(sb.ssh_private_key, 'base64') as private_key_bytes,
             o.id as org_id, o.slug as org_slug
      from ssh_bindings sb
      join projects p on p.id = sb.project_id
      join organizations o on o.id = p.organization_id
      where sb.host_slug = any(string_to_array(nullif(:'hosts', ''), ','))) h),
  'tokens', (select coalesce(json_agg(t), '[]'::json) from (
      select t.id, t.project_id, t.name, t.accepted_risks, t.denied_risks, t.expires_at
      from tokens t join org on t.organization_id = org.id
      where t.parent_id is null and t.status = 'active' and t.single_use = false
        and t.consumed_at is null and t.project_id is not null
        and (t.expires_at is null or t.expires_at > now())) t),
  'child_tokens', (select count(*) from tokens t join org on t.organization_id = org.id
      where t.parent_id is not null and t.status = 'active'),
  'project_env_vars', (select count(*) from project_env_vars v join prj on v.project_id = prj.id),
  'bash_bindings', (select count(*) from bash_bindings bb join prj on bb.project_id = prj.id)
);
`;
}

/**
 * @typedef {{ decrypt(orgId: string, sealed: Uint8Array): string }} Decryptor
 * @typedef {{ org: string, sshHosts: string[], sshHostKeys: Map<string, string> }} BundleOptions
 * @typedef {{ id: string, slug: string, name: string }} RawNamed
 * @typedef {{ id: string, provider: string, status: string, team_id: string | null,
 *   installation_id: string | null, access_token_sealed: string | null }} RawAccount
 * @typedef {{ project_id: string, provider: string, resource_ref: string,
 *   display_name: string | null, environment: string | null }} RawBinding
 * @typedef {{ project_id: string, account_id: string, test_key_sealed: string | null,
 *   live_key_sealed: string | null }} RawStripe
 * @typedef {{ project_id: string, host_slug: string }} RawOrgSsh
 * @typedef {{ host_slug: string, host_address: string, port: number | string, ssh_user: string,
 *   private_key_bytes: string, org_id: string, org_slug: string }} RawSsh
 * @typedef {{ id: string, project_id: string, name: string, accepted_risks: unknown,
 *   denied_risks?: unknown,
 *   expires_at: string | null }} RawToken
 * @typedef {{ organization: RawNamed | null, projects: RawNamed[], accounts: RawAccount[],
 *   bindings: RawBinding[], stripe: RawStripe[], org_ssh: RawOrgSsh[], ssh: RawSsh[],
 *   tokens: RawToken[], child_tokens: number | string, project_env_vars: number | string,
 *   bash_bindings: number | string }} RawExport
 * @typedef {{ project_id: string, mode: 'test' | 'live' }} StripeProject
 * @typedef {{ account_id: string, projects: StripeProject[], test_key: string | null,
 *   live_key: string | null }} StripeAccount
 */

/**
 * The string ids of a v4 `accepted_risks` / `denied_risks` jsonb array.
 * @param {unknown} value
 * @returns {string[]}
 */
function riskIdsOf(value) {
  return Array.isArray(value) ? value.filter((id) => typeof id === 'string') : [];
}

/**
 * One entry per Stripe account, with the mode each project used in v4. The
 * v4 gateway gave a project ONE key: its row's live key, else its test key
 * (`live ?? test`, packages/web/src/lib/gateway/build.ts at v4-final). A
 * project keeps exactly that mode, never the other; the connection carries
 * the account's keys. Rows of one account holding two different keys of the
 * same mode stop the export: which one is right is the operator's call.
 * @param {RawStripe[]} rows
 * @param {Decryptor} decryptor
 * @param {string} orgId
 * @returns {StripeAccount[]}
 */
function stripeAccountsOf(rows, decryptor, orgId) {
  /** @type {Map<string, StripeAccount>} */
  const accounts = new Map();
  for (const row of rows) {
    const test = row.test_key_sealed
      ? decryptor.decrypt(orgId, bytesOf(row.test_key_sealed))
      : null;
    const live = row.live_key_sealed
      ? decryptor.decrypt(orgId, bytesOf(row.live_key_sealed))
      : null;
    if (test === null && live === null) continue;
    const account = accounts.get(row.account_id) ?? {
      account_id: row.account_id,
      projects: [],
      test_key: null,
      live_key: null,
    };
    for (const [mode, key] of /** @type {const} */ ([
      ['test', test],
      ['live', live],
    ])) {
      if (key === null) continue;
      const field = mode === 'test' ? 'test_key' : 'live_key';
      if (account[field] !== null && account[field] !== key) {
        throw new ExportError(
          `the v4 Stripe bindings of account '${row.account_id}' hold two different ${mode} keys: make them agree in v4, or unbind one`,
        );
      }
      account[field] = key;
    }
    const mode = live !== null ? 'live' : 'test';
    if (!account.projects.some((p) => p.project_id === row.project_id)) {
      account.projects.push({ project_id: row.project_id, mode });
    }
    accounts.set(row.account_id, account);
  }
  return [...accounts.values()];
}

/**
 * The bundle from the JSON document `exportSql()` returns.
 * @param {RawExport} raw
 * @param {Decryptor} decryptor
 * @param {BundleOptions} options
 * @param {Date} now
 */
export function buildBundle(raw, decryptor, options, now) {
  const org = raw.organization;
  if (!org || typeof org.id !== 'string') {
    throw new ExportError(`no v4 organization has the slug '${options.org}'`);
  }
  const projectIds = new Set(raw.projects.map((p) => p.id));

  const accounts = raw.accounts.map((a) => ({
    id: a.id,
    provider: a.provider,
    status: a.status,
    team_id: a.team_id ?? null,
    installation_id: a.installation_id ?? null,
    access_token:
      PASTED_KEY_PROVIDERS.includes(a.provider) && a.access_token_sealed
        ? decryptor.decrypt(org.id, bytesOf(a.access_token_sealed))
        : null,
  }));

  const stripe = stripeAccountsOf(raw.stripe, decryptor, org.id);

  const ssh = options.sshHosts.map((slug) => sshHostOf(slug, raw, decryptor, options, projectIds));
  const asked = new Set(options.sshHosts);
  const notExported = [
    ...new Set(raw.org_ssh.map((h) => h.host_slug).filter((slug) => !asked.has(slug))),
  ].sort();

  return {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    exported_at: now.toISOString(),
    organization: { id: org.id, slug: org.slug, name: org.name },
    projects: raw.projects.map((p) => ({ id: p.id, slug: p.slug, name: p.name })),
    accounts,
    bindings: raw.bindings.map((b) => ({
      project_id: b.project_id,
      provider: b.provider,
      resource_ref: b.resource_ref,
      display_name: b.display_name ?? null,
      environment: b.environment ?? null,
    })),
    stripe_accounts: stripe,
    ssh_hosts: ssh,
    missions: raw.tokens.map((t) => ({
      token_id: t.id,
      project_id: t.project_id,
      token_name: t.name,
      accepted_risks: riskIdsOf(t.accepted_risks),
      denied_risks: riskIdsOf(t.denied_risks),
      expires_at: t.expires_at ?? null,
    })),
    skipped: {
      project_env_vars: Number(raw.project_env_vars ?? 0),
      child_tokens: Number(raw.child_tokens ?? 0),
      bash_bindings: Number(raw.bash_bindings ?? 0),
      ssh_hosts_not_exported: notExported,
    },
  };
}

/**
 * One asked SSH host: every v4 row with that slug must describe the same host
 * and the same key. v4 stored the private key as plain text (`ssh_private_key`
 * holds the PEM's bytes); a key that is not PEM text is tried as a v4
 * ciphertext of the organization that holds it.
 * @param {string} slug
 * @param {RawExport} raw
 * @param {Decryptor} decryptor
 * @param {BundleOptions} options
 * @param {Set<string>} projectIds
 */
function sshHostOf(slug, raw, decryptor, options, projectIds) {
  const described = raw.ssh
    .filter((h) => h.host_slug === slug)
    .map((h) => ({
      host_address: h.host_address,
      port: Number(h.port),
      user: h.ssh_user,
      private_key: privateKeyOf(h, decryptor),
      source_org: h.org_slug,
    }));
  const first = described[0];
  if (!first) throw new ExportError(`no v4 SSH binding has the host slug '${slug}'`);
  const same = described.every(
    (d) =>
      d.host_address === first.host_address &&
      d.port === first.port &&
      d.user === first.user &&
      d.private_key === first.private_key,
  );
  if (!same) {
    throw new ExportError(
      `the v4 SSH bindings named '${slug}' disagree (address, port, user or key)`,
    );
  }
  return {
    host_slug: slug,
    ...first,
    host_key_fingerprint: options.sshHostKeys.get(slug) ?? '',
    project_ids: [
      ...new Set(
        raw.org_ssh
          .filter((h) => h.host_slug === slug && projectIds.has(h.project_id))
          .map((h) => h.project_id),
      ),
    ],
  };
}

/**
 * @param {RawSsh} row
 * @param {Decryptor} decryptor
 */
function privateKeyOf(row, decryptor) {
  const bytes = bytesOf(row.private_key_bytes);
  const text = new TextDecoder().decode(bytes);
  if (text.trimStart().startsWith('-----BEGIN ')) return text;
  return decryptor.decrypt(row.org_id, bytes);
}

/**
 * What the operator reads on stderr: counts and names, never a secret.
 * @param {ReturnType<typeof buildBundle>} bundle
 */
export function summaryOf(bundle) {
  const tokens = bundle.accounts.filter((a) => a.access_token !== null).map((a) => a.provider);
  return [
    `export-v4: organization '${bundle.organization.slug}': ${bundle.projects.length} project(s), ` +
      `${bundle.missions.length} working token(s), ${bundle.bindings.length} binding row(s)`,
    `export-v4: keys carried: ${[...tokens, ...bundle.stripe_accounts.map(() => 'stripe'), ...bundle.ssh_hosts.map((h) => `ssh ${h.host_slug}`)].join(', ') || 'none'}`,
    `export-v4: accounts left to connect by hand: ${
      bundle.accounts
        .filter((a) => a.access_token === null)
        .map((a) => a.provider)
        .join(', ') || 'none'
    }`,
  ].join('\n');
}
