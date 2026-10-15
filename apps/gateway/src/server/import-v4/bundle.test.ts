import cloudflareDnsPlugin from '@vaubaan/plugin-cloudflare-dns';
import { credentialSpecFor, type ProviderPlugin } from '@vaubaan/plugin-sdk';
import sshPlugin from '@vaubaan/plugin-ssh';
import stripePlugin from '@vaubaan/plugin-stripe';
import vercelPlugin from '@vaubaan/plugin-vercel';
import { describe, expect, it } from 'vitest';

import { parseBundle, secretsOf } from './bundle';
import { markImported, parseArgs } from './cli';
import { pastedKeyFields, sshHostFields, stripeKeyFields } from './credential-mapping';
import { normalizeBindings, sameVisibleFields } from './importer';
import {
  CLOUDFLARE_TOKEN,
  fixtureBundle,
  PROJECT_WEB,
  SSH_PRIVATE_KEY,
  STRIPE_TEST_KEY,
  VERCEL_TOKEN,
} from './testing';

const parse = (value: unknown) => parseBundle(JSON.stringify(value));

describe('bundle validation', () => {
  it('accepts the exporter’s shape', () => {
    const result = parse(fixtureBundle());
    expect(result.ok).toBe(true);
  });

  it('refuses an unknown key anywhere, naming it', () => {
    const bundle = { ...fixtureBundle(), extra: 1 };
    const result = parse(bundle);
    expect(result).toEqual({ ok: false, problems: ['(root): unknown key(s) extra'] });

    const nested = fixtureBundle();
    const account = { ...nested.accounts[0]!, refresh_token: 'x' };
    const refused = parse({ ...nested, accounts: [account] });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.problems[0]).toContain('refresh_token');
  });

  it('refuses a secret for a provider whose secret is never imported', () => {
    const bundle = fixtureBundle();
    const github = { ...bundle.accounts[0]!, access_token: 'ghs_never_imported_value' };
    const result = parse({ ...bundle, accounts: [github, ...bundle.accounts.slice(1)] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems.join('\n')).toContain('never imported');
      expect(result.problems.join('\n')).not.toContain('ghs_never_imported_value');
    }
  });

  it('refuses a binding or a mission of a project the bundle does not list', () => {
    const bundle = fixtureBundle();
    const stray = { ...bundle.bindings[0]!, project_id: '0b6a1a3e-0000-4000-8000-0000000000ff' };
    const result = parse({ ...bundle, bindings: [stray] });
    expect(result.ok).toBe(false);
  });

  it('refuses a v4 risk id that is not one, a wrong format or version', () => {
    const bundle = fixtureBundle();
    const mission = { ...bundle.missions[0]!, accepted_risks: ['github.*'] };
    expect(parse({ ...bundle, missions: [mission] }).ok).toBe(false);
    expect(parse({ ...bundle, version: 2 }).ok).toBe(false);
    expect(parse({ ...bundle, format: 'other' }).ok).toBe(false);
  });

  it('reports a JSON syntax error without quoting the input', () => {
    const secretish = `{"token": "${CLOUDFLARE_TOKEN}" oops`;
    const result = parseBundle(secretish);
    expect(result).toEqual({ ok: false, problems: ['the bundle is not valid JSON'] });
  });

  it('never quotes a value in its problems', () => {
    const bundle = fixtureBundle();
    const vercel = { ...bundle.accounts[2]!, status: VERCEL_TOKEN };
    const result = parse({ ...bundle, accounts: [vercel] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.join('\n')).not.toContain(VERCEL_TOKEN);
  });

  it('lists every secret it carries, for the redactor', () => {
    expect(new Set(secretsOf(fixtureBundle()))).toEqual(
      new Set([CLOUDFLARE_TOKEN, VERCEL_TOKEN, STRIPE_TEST_KEY, SSH_PRIVATE_KEY]),
    );
  });
});

describe('credential mapping holds to the plugins’ forms', () => {
  function fieldNames(plugin: ProviderPlugin, kind: 'api-key' | 'ssh-key'): string[] {
    return (credentialSpecFor(plugin, kind)?.fields ?? []).map((f) => f.name);
  }

  it('Cloudflare and Vercel keys fill the api-key forms', () => {
    const bundle = fixtureBundle();
    const cloudflare = pastedKeyFields(bundle.accounts[1]!);
    const vercel = pastedKeyFields(bundle.accounts[2]!);
    if (!cloudflare.ok || !vercel.ok) throw new Error('mapped');
    expect(Object.keys(cloudflare.fields)).toEqual(fieldNames(cloudflareDnsPlugin, 'api-key'));
    expect(Object.keys(vercel.fields)).toEqual(fieldNames(vercelPlugin, 'api-key'));
  });

  it('Stripe keys and SSH hosts fill theirs', () => {
    const bundle = fixtureBundle();
    const stripe = Object.keys(stripeKeyFields(bundle.stripe_accounts[0]!));
    expect(stripe.every((f) => fieldNames(stripePlugin, 'api-key').includes(f))).toBe(true);
    expect(Object.keys(sshHostFields(bundle.ssh_hosts[0]!))).toEqual(
      fieldNames(sshPlugin, 'ssh-key'),
    );
  });

  it('a GitHub installation or an OAuth grant is never mapped', () => {
    const bundle = fixtureBundle();
    expect(pastedKeyFields(bundle.accounts[0]!).ok).toBe(false);
    expect(pastedKeyFields(bundle.accounts[3]!).ok).toBe(false);
  });

  it('a Vercel account without its team id is not mapped', () => {
    const vercel = { ...fixtureBundle().accounts[2]!, team_id: null };
    expect(pastedKeyFields(vercel)).toEqual({ ok: false, reason: 'v4 recorded no team id for it' });
  });
});

describe('bindings', () => {
  it('collapses the duplicated v4 rows and keeps every label they carried', () => {
    const bindings = normalizeBindings(fixtureBundle());
    const vercel = bindings.filter((b) => b.provider === 'vercel');
    expect(vercel).toHaveLength(1);
    expect(vercel[0]).toMatchObject({
      projectId: PROJECT_WEB,
      label: 'prj_web',
      v4Labels: ['prod'],
    });
    expect(bindings.find((b) => b.provider === 'stripe')?.matcher).toEqual({
      kind: 'stripe-account',
      accountId: 'acct_1Acme',
    });
    expect(bindings.find((b) => b.provider === 'ssh')?.label).toBe('vps-ops.example.com');
  });

  it('recognises a hand-made connection by its non-secret values only', () => {
    expect(sameVisibleFields({ team_id: 'team_a' }, { team_id: 'team_a' })).toBe(true);
    expect(sameVisibleFields({ team_id: 'team_a' }, { team_id: 'team_b' })).toBe(false);
    expect(sameVisibleFields({}, {})).toBe(false);
    expect(sameVisibleFields({ host: 'h', user: 'u', port: '22' }, { host: 'h', user: 'u' })).toBe(
      true,
    );
  });
});

describe('command line', () => {
  it('reads --owner and --apply', () => {
    expect(parseArgs(['--owner', 'a@example.com'])).toEqual({
      kind: 'run',
      args: { ownerEmail: 'a@example.com', apply: false },
    });
    expect(parseArgs(['--apply', '--owner=a@example.com'])).toEqual({
      kind: 'run',
      args: { ownerEmail: 'a@example.com', apply: true },
    });
  });

  it('refuses an unknown argument without echoing it', () => {
    const parsed = parseArgs(['--owner', 'a@example.com', CLOUDFLARE_TOKEN]);
    expect(parsed.kind).toBe('usage');
    if (parsed.kind === 'usage') expect(parsed.problem).not.toContain(CLOUDFLARE_TOKEN);
  });

  it('requires an owner email', () => {
    expect(parseArgs([]).kind).toBe('usage');
    expect(parseArgs(['--owner']).kind).toBe('usage');
    expect(parseArgs(['--owner', 'nobody']).kind).toBe('usage');
  });

  it('marks every administrative audit entry, and only those', async () => {
    const written: unknown[] = [];
    const store = {
      auditWriter: {
        write: async (entry: unknown) => {
          written.push(entry);
        },
      },
    } as unknown as Parameters<typeof markImported>[0];
    const marked = markImported(store, 'acme');
    const admin = {
      kind: 'admin' as const,
      ts: '2026-10-15T08:00:00.000Z',
      user_id: 'u1',
      act: 'connection-created' as const,
      object: { type: 'connection' as const, id: 'c1' },
      before: null,
      delegated_client_id: null,
    };
    await marked.auditWriter.write({ ...admin, after: { provider: 'vercel' } });
    await marked.auditWriter.write({ ...admin, after: null });
    expect(written).toEqual([
      { ...admin, after: { provider: 'vercel', marker: 'imported-from-v4', v4_org: 'acme' } },
      { ...admin, after: { value: null, marker: 'imported-from-v4', v4_org: 'acme' } },
    ]);
  });
});
