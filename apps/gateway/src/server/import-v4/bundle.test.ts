import cloudflareDnsPlugin from '@vaubaan/plugin-cloudflare-dns';
import type { ProviderPlugin } from '@vaubaan/plugin-sdk';
import sshPlugin from '@vaubaan/plugin-ssh';
import stripePlugin from '@vaubaan/plugin-stripe';
import vercelPlugin from '@vaubaan/plugin-vercel';
import { describe, expect, it } from 'vitest';

import { readCredentialForm } from '../connections/input';
import { parseBundle, secretsOf } from './bundle';
import type { Store } from '../store';
import { createImportMarker, parseArgs } from './cli';
import { pastedKeyFields, sshHostFields, stripeKeyFields } from './credential-mapping';
import { missionNamesOf, normalizeBindings, sameVisibleFields } from './importer';
import {
  CLOUDFLARE_TOKEN,
  fixtureBundle,
  PROJECT_WEB,
  SSH_PRIVATE_KEY,
  STRIPE_TEST_KEY,
  VERCEL_TOKEN,
} from '../../../tests/support/import-v4/testing';

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
    const spec = plugin.credential;
    return (spec.kind === kind ? spec.fields : []).map((f) => f.name);
  }

  it('Cloudflare and Vercel keys fill the api-key forms', () => {
    const bundle = fixtureBundle();
    const cloudflare = pastedKeyFields(bundle.accounts[1]!);
    const vercel = pastedKeyFields(bundle.accounts[2]!);
    if (!cloudflare.ok || !vercel.ok) throw new Error('mapped');
    expect(Object.keys(cloudflare.fields)).toEqual(fieldNames(cloudflareDnsPlugin, 'api-key'));
    // Vercel's form has two alternatives: a v4 key (a team id) reads as the Team one.
    if (vercelPlugin.credential.kind !== 'api-key') throw new Error('api-key');
    const read = readCredentialForm(vercelPlugin.credential, vercel.fields, null);
    expect(read.problems).toEqual([]);
    expect(read.alternative).toBe('team');
    expect(Object.keys(read.values)).toEqual(Object.keys(vercel.fields));
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
      mode: 'test',
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
      args: {
        ownerEmail: 'a@example.com',
        apply: false,
        allowStale: false,
        carryUnbudgeted: null,
        reissue: [],
      },
    });
    expect(parseArgs(['--apply', '--owner=a@example.com'])).toEqual({
      kind: 'run',
      args: {
        ownerEmail: 'a@example.com',
        apply: true,
        allowStale: false,
        carryUnbudgeted: null,
        reissue: [],
      },
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

  it('marks every administrative audit entry, the issuing one with its v4 source', async () => {
    const written: unknown[] = [];
    const store = {
      auditWriter: {
        write: async (entry: unknown) => {
          written.push(entry);
        },
      },
    } as unknown as Store;
    const marker = createImportMarker('acme');
    const marked = marker.wrap(store);
    const admin = {
      kind: 'admin' as const,
      ts: '2026-10-15T08:00:00.000Z',
      user_id: 'u1',
      act: 'connection-created' as const,
      object: { type: 'connection' as const, id: 'c1' },
      before: null,
    };
    await marked.auditWriter.write({ ...admin, after: { provider: 'vercel' } });
    await marker
      .provenance({ audit: {} as Store['audit'] })
      .during('tokens/t1', () => marked.auditWriter.write({ ...admin, after: null }));
    await marked.auditWriter.write({ ...admin, after: null });
    expect(written).toEqual([
      { ...admin, after: { provider: 'vercel', marker: 'imported-from-v4', v4_org: 'acme' } },
      {
        ...admin,
        after: { value: null, marker: 'imported-from-v4', v4_org: 'acme', v4_source: 'tokens/t1' },
      },
      { ...admin, after: { value: null, marker: 'imported-from-v4', v4_org: 'acme' } },
    ]);
  });

  it('reads --carry-unbudgeted as a positive whole number only', () => {
    expect(parseArgs(['--owner', 'a@example.com', '--carry-unbudgeted', '5'])).toMatchObject({
      kind: 'run',
      args: { carryUnbudgeted: 5 },
    });
    expect(parseArgs(['--owner', 'a@example.com', '--carry-unbudgeted=12'])).toMatchObject({
      kind: 'run',
      args: { carryUnbudgeted: 12 },
    });
    for (const bad of ['0', '-1', '1.5', '1e3', '0x10', ' 5', 'many']) {
      expect(parseArgs(['--owner', 'a@example.com', '--carry-unbudgeted', bad]).kind).toBe('usage');
    }
    expect(parseArgs(['--owner', 'a@example.com', '--carry-unbudgeted']).kind).toBe('usage');
  });

  it('reads --reissue, repeatable, as v4 token ids without echoing anything else', () => {
    const a = '83e35806-6201-47e5-8f03-c0ae2cd604a4';
    const b = '0B6A1A3E-0000-4000-8000-0000000000C2';
    expect(
      parseArgs(['--owner', 'a@example.com', '--reissue', a, `--reissue=${b}`, '--reissue', a]),
    ).toMatchObject({ kind: 'run', args: { reissue: [a, b.toLowerCase()] } });
    const parsed = parseArgs(['--owner', 'a@example.com', '--reissue', CLOUDFLARE_TOKEN]);
    expect(parsed.kind).toBe('usage');
    if (parsed.kind === 'usage') expect(parsed.problem).not.toContain(CLOUDFLARE_TOKEN);
    expect(parseArgs(['--owner', 'a@example.com', '--reissue']).kind).toBe('usage');
  });

  it('recognises the newest issuance of a v4 token, the one a reissue made', async () => {
    const entry = (id: string, source: string, org = 'acme') => ({
      kind: 'admin' as const,
      ts: '2026-10-15T08:00:00.000Z',
      user_id: 'u1',
      act: 'mission-issued' as const,
      object: { type: 'mission' as const, id },
      before: null,
      after: { marker: 'imported-from-v4', v4_org: org, v4_source: source },
    });
    // `audit.list` returns the oldest first.
    const audit = {
      list: async () => [
        entry('m-old', 'tokens/t1'),
        entry('m-t2', 'tokens/t2'),
        entry('m-new', 'tokens/t1'),
        entry('m-other-org', 'tokens/t2', 'other'),
      ],
    } as unknown as Store['audit'];
    const issued = await createImportMarker('acme').provenance({ audit }).issued('u1');
    expect([...issued]).toEqual([
      ['tokens/t1', 'm-new'],
      ['tokens/t2', 'm-t2'],
    ]);
  });

  it('reads --allow-stale', () => {
    expect(parseArgs(['--owner', 'a@example.com', '--allow-stale'])).toEqual({
      kind: 'run',
      args: {
        ownerEmail: 'a@example.com',
        apply: false,
        allowStale: true,
        carryUnbudgeted: null,
        reissue: [],
      },
    });
  });
});

describe('the review’s hardening', () => {
  it('a Stripe project gets only the mode v4 gave it; a mode without its key is refused', () => {
    const bundle = fixtureBundle();
    const account = bundle.stripe_accounts[0]!;
    const live = { ...account, projects: [{ project_id: PROJECT_WEB, mode: 'live' as const }] };
    const refused = parse({ ...bundle, stripe_accounts: [live] });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.problems.join('\n')).toContain('no key for');
  });

  it('carries the v4 denials and refuses a bundle without them', () => {
    const bundle = fixtureBundle();
    const { denied_risks: _dropped, ...withoutDenials } = bundle.missions[0]!;
    expect(parse({ ...bundle, missions: [withoutDenials] }).ok).toBe(false);
  });

  it('refuses a secret too short to be one', () => {
    const bundle = fixtureBundle();
    const cloudflare = { ...bundle.accounts[1]!, access_token: 'a' };
    expect(parse({ ...bundle, accounts: [bundle.accounts[0]!, cloudflare] }).ok).toBe(false);
  });

  it('names missions on one line, apart when projects share a name, within the limit', () => {
    const bundle = fixtureBundle();
    const [web, ops] = bundle.projects;
    const projects = [
      { ...web!, name: 'shared\nname  ' },
      { ...ops!, name: 'shared name' },
    ];
    const names = missionNamesOf({ projects, missions: bundle.missions });
    expect([...names.values()].sort()).toEqual([
      'shared name — ops/ops-agent',
      'shared name — web/web-agent',
    ]);
    const long = missionNamesOf({
      projects: [{ ...web!, name: 'x'.repeat(400) }],
      missions: [bundle.missions[0]!],
    });
    expect([...long.values()][0]!.length).toBeLessThanOrEqual(120);
  });
});
