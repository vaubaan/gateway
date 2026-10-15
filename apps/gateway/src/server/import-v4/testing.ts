/**
 * Test fixtures of the v4 importer: a small but complete bundle. Not for
 * production. Secrets are fake and assembled at run time.
 */
import { generateKeyPairSync, randomBytes } from 'node:crypto';

import { BUNDLE_FORMAT, BUNDLE_VERSION, type V4Bundle } from './bundle';

export const ORG_ID = '0b6a1a3e-0000-4000-8000-000000000001';
export const PROJECT_WEB = '0b6a1a3e-0000-4000-8000-0000000000a1';
export const PROJECT_OPS = '0b6a1a3e-0000-4000-8000-0000000000a2';
export const ACCOUNT_GITHUB = '0b6a1a3e-0000-4000-8000-0000000000b1';
export const ACCOUNT_CLOUDFLARE = '0b6a1a3e-0000-4000-8000-0000000000b2';
export const ACCOUNT_VERCEL = '0b6a1a3e-0000-4000-8000-0000000000b3';
export const ACCOUNT_SUPABASE = '0b6a1a3e-0000-4000-8000-0000000000b4';
export const TOKEN_WEB = '0b6a1a3e-0000-4000-8000-0000000000c1';
export const TOKEN_OPS = '0b6a1a3e-0000-4000-8000-0000000000c2';

export const CLOUDFLARE_TOKEN = `cf${randomBytes(20).toString('hex')}`;
export const VERCEL_TOKEN = `vc${randomBytes(12).toString('hex')}`;
export const VERCEL_TEAM = 'team_acme01';
export const STRIPE_TEST_KEY = ['sk', 'test', randomBytes(12).toString('hex')].join('_');
export const STRIPE_ACCOUNT = 'acct_1Acme';
export const SSH_FINGERPRINT = `SHA256:${randomBytes(32).toString('base64').replace(/=+$/, '')}`;
export const SSH_PRIVATE_KEY = generateKeyPairSync('ed25519', {
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey;

/**
 * Organization `acme` with two projects:
 * - `web`: GitHub `acme/web` (by hand), Vercel `prj_web` labelled `prod`
 *   twice (a duplicate row), Cloudflare zone `zone_web` labelled with junk,
 *   Stripe in test mode; token `web-agent`;
 * - `ops`: the SSH host `vps-ops`; token `ops-agent`.
 */
export function fixtureBundle(): V4Bundle {
  return {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    exported_at: '2026-10-15T08:00:00.000Z',
    organization: { id: ORG_ID, slug: 'acme', name: 'Acme' },
    projects: [
      { id: PROJECT_WEB, slug: 'web', name: 'web' },
      { id: PROJECT_OPS, slug: 'ops', name: 'ops' },
    ],
    accounts: [
      {
        id: ACCOUNT_GITHUB,
        provider: 'github',
        status: 'connected',
        team_id: null,
        installation_id: '4242',
        access_token: null,
      },
      {
        id: ACCOUNT_CLOUDFLARE,
        provider: 'cloudflare-dns',
        status: 'connected',
        team_id: null,
        installation_id: null,
        access_token: CLOUDFLARE_TOKEN,
      },
      {
        id: ACCOUNT_VERCEL,
        provider: 'vercel',
        status: 'connected',
        team_id: VERCEL_TEAM,
        installation_id: null,
        access_token: VERCEL_TOKEN,
      },
      {
        id: ACCOUNT_SUPABASE,
        provider: 'supabase',
        status: 'connected',
        team_id: null,
        installation_id: null,
        access_token: null,
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
    stripe_accounts: [
      {
        account_id: STRIPE_ACCOUNT,
        project_ids: [PROJECT_WEB],
        test_key: STRIPE_TEST_KEY,
        live_key: null,
      },
    ],
    ssh_hosts: [
      {
        host_slug: 'vps-ops',
        host_address: 'vps-ops.example.com',
        port: 22,
        user: 'dev',
        private_key: SSH_PRIVATE_KEY,
        host_key_fingerprint: SSH_FINGERPRINT,
        source_org: 'vaubaan',
        project_ids: [PROJECT_OPS],
      },
    ],
    missions: [
      {
        token_id: TOKEN_WEB,
        project_id: PROJECT_WEB,
        token_name: 'web-agent',
        accepted_risks: [
          'github.read-code',
          'github.create-pr',
          'vercel.read-account',
          'cloudflare-dns.read-zone-metadata',
          'stripe.read-catalog',
          'stripe.teleport',
          'supabase.read-data',
        ],
        expires_at: null,
      },
      {
        token_id: TOKEN_OPS,
        project_id: PROJECT_OPS,
        token_name: 'ops-agent',
        accepted_risks: ['ssh.exec-read', 'ssh.uncategorized-write'],
        expires_at: null,
      },
    ],
    skipped: {
      project_env_vars: 3,
      child_tokens: 1,
      bash_bindings: 0,
      ssh_hosts_not_exported: ['vps-other'],
    },
  };
}
