/**
 * Accounts refresh themselves (spec §0 "Resource", §4.2 "Accounts"), over the real
 * composition root on the `:memory:` store, with a fake plugin whose discovery and key
 * check are scripted between two runs.
 *
 * What is proven here:
 *
 *   - an hourly refresh adds what the service now lists, keeps the owner's hidden or
 *     shown choice, marks stale what it no longer lists, and writes one
 *     `resources-discovered` entry (actor `discovery`, cause `scheduled`) per refresh
 *     that changed something — none for a refresh that changed nothing;
 *   - it asks the key's check again: what the key holds and until when are written,
 *     audited as a change of rights;
 *   - a key the service rejects turns the account `expired` (reconnect), audited once,
 *     and the next runs leave it alone;
 *   - a page's refresh (`POST /api/accounts/refresh`) takes the stale accounts the
 *     person may use, leaves the fresh ones and another person's, and says which
 *     changed.
 */
import { DISCOVERY_ACTOR_ID } from '@vaubaan/gateway-core';
import { createRegistry, type CredentialCheck, type Resource } from '@vaubaan/plugin-sdk';
import { apiKeyCredentialFixture } from '@vaubaan/plugin-sdk/testing';
import { UpstreamAuthError } from '@vaubaan/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SESSION_COOKIE } from '../../../src/server/auth';
import { AccountRefresher, type RefreshTimers } from '../../../src/server/accounts';
import type { Actor } from '../../../src/server/accounts';
import { buildRoot, type GatewayRoot } from '../../../src/server/compose/root';
import { loadInstanceConfig } from '../../../src/server/config';
import { silentLogger } from '../../../src/server/logging';
import { ManualClock } from '../../../src/server/store/clock';
import type { AccountRecord } from '../../../src/server/store/types';
import { fixturePlugin } from '../../support/accounts/testing';
import { memoryStoreDeps } from '../../support/compose/testing';
import { validEnv } from '../../support/config/testing';
import { agePastStaleGrace } from '../../support/store/testing';

const PUBLIC_URL = 'https://gateway.example.com';
const HOUR = 60 * 60 * 1000;
const SERVICE = 'keyco';

/** Timers that never fire by themselves: the test runs each tick. */
const idleTimers: RefreshTimers = { setTimeout: () => 0, clearTimeout: () => undefined };

const thing = (ref: string, extra: Partial<Resource> = {}): Resource => ({
  service: SERVICE,
  ref,
  displayName: ref,
  ...extra,
});

describe('accounts refresh themselves', () => {
  let root: GatewayRoot;
  let listed: () => Promise<readonly Resource[]>;
  let check: () => Promise<CredentialCheck>;
  let alice: Actor;
  let hoursOn: number;

  beforeEach(async () => {
    listed = async () => [thing('alpha'), thing('beta')];
    check = async () => ({ account: 'alice-bot', expiresAt: null, granted: ['Things: read'] });
    hoursOn = 0;
    root = await buildRoot({
      loadConfig: () => loadInstanceConfig({ env: validEnv({ VAUBAAN_PUBLIC_URL: PUBLIC_URL }) }),
      logWrite: () => undefined,
      buildRegistry: async () =>
        createRegistry([
          fixturePlugin({
            id: SERVICE,
            credential: apiKeyCredentialFixture([{ name: 'token', label: 'Token', secret: true }], {
              verify: () => check(),
            }),
            discoverResources: () => listed(),
          }),
        ]),
      refreshTimers: idleTimers,
      ...memoryStoreDeps,
    });
    const user = await root.store.users.upsertFromIdp({
      issuer: 'http://idp.test',
      subject: 'idp|alice',
      email: 'alice@example.com',
      displayName: 'Alice',
    });
    alice = { user, groups: [] };
  });
  afterEach(async () => {
    await root.close();
  });

  async function connect(name = 'Key account'): Promise<AccountRecord> {
    const started = await root.accounts.service.start(alice, SERVICE, {
      displayName: name,
      fields: { token: 'key-0123456789' },
    });
    if (started.kind !== 'connected') throw new Error('expected an immediate account');
    return started.account;
  }

  /** One hourly tick, `hours` after now: every account refreshed before is due. */
  async function tick(): Promise<readonly string[]> {
    hoursOn += 2;
    const refresher = new AccountRefresher({
      accounts: root.store.accounts,
      missions: root.store.missions,
      service: root.accounts.service,
      logger: silentLogger,
      clock: new ManualClock(new Date(Date.now() + hoursOn * HOUR)),
      intervalMs: HOUR,
      timers: idleTimers,
    });
    return (await refresher.runOnce()).accounts;
  }

  const refreshEntries = async () =>
    (await root.store.audit.list({ kind: 'admin' })).flatMap((e) =>
      e.kind === 'admin' && e.act === 'resources-discovered' ? [e] : [],
    );
  const resources = async (accountId: string) =>
    new Map((await root.store.accounts.listResources(accountId)).map((r) => [r.ref, r] as const));

  it('adds what the service lists now, keeps the owner’s choice, audits only a change', async () => {
    listed = async () => [thing('alpha'), thing('beta', { hiddenByDefault: true })];
    const account = await connect();
    const beta = (await resources(account.id)).get('beta');
    expect(beta?.hidden).toBe(true);
    // The owner shows it: no refresh hides it again.
    await root.accounts.service.updateResource(alice, account.id, beta!.id, { hidden: false });

    listed = async () => [
      thing('alpha'),
      thing('beta', { hiddenByDefault: true }),
      thing('gamma', { hiddenByDefault: true }),
    ];
    expect(await tick()).toEqual([account.id]);
    let now = await resources(account.id);
    expect(now.get('gamma')?.hidden).toBe(true);
    expect(now.get('beta')?.hidden).toBe(false);
    const [first] = await refreshEntries();
    expect(first).toMatchObject({
      user_id: DISCOVERY_ACTOR_ID,
      object: { type: 'account', id: account.id },
      after: { ok: true, cause: 'scheduled', added: 1, removed: 0, rights_changed: false },
    });

    // The same answer again: refreshed, nothing written to the record.
    expect(await tick()).toEqual([account.id]);
    expect(await refreshEntries()).toHaveLength(1);

    // Gone at the service: stale, audited.
    agePastStaleGrace(root.store, account.id);
    listed = async () => [thing('beta'), thing('gamma')];
    await tick();
    now = await resources(account.id);
    expect(now.get('alpha')?.staleSince).not.toBeNull();
    expect((await refreshEntries())[1]?.after).toMatchObject({ added: 0, removed: 1 });
  });

  it('asks the key’s check again and writes what it holds now', async () => {
    const account = await connect();
    expect((await root.store.accounts.getById(account.id))?.metadata?.granted).toEqual([
      'Things: read',
    ]);
    check = async () => ({
      account: 'alice-bot',
      expiresAt: '2027-03-01T00:00:00.000Z',
      granted: ['Things: read', 'Things: write'],
    });
    await tick();
    const after = await root.store.accounts.getById(account.id);
    expect(after?.metadata?.granted).toEqual(['Things: read', 'Things: write']);
    expect(after?.credentialExpiresAt).toBe('2027-03-01T00:00:00.000Z');
    expect((await refreshEntries())[0]?.after).toMatchObject({
      cause: 'scheduled',
      added: 0,
      removed: 0,
      rights_changed: true,
    });
    // A check that fails changes nothing: the discovery proved the key works.
    check = async () => {
      throw new Error('the check endpoint is down');
    };
    await tick();
    expect((await root.store.accounts.getById(account.id))?.metadata?.granted).toEqual([
      'Things: read',
      'Things: write',
    ]);
    expect(await refreshEntries()).toHaveLength(1);
  });

  it('a rejected key turns the account expired, once, as the owner’s Refresh does', async () => {
    const account = await connect();
    listed = async () => {
      throw new UpstreamAuthError('bad key', 401);
    };
    await tick();
    expect((await root.store.accounts.getById(account.id))?.status).toBe('expired');
    expect((await refreshEntries())[0]?.after).toMatchObject({ ok: false, expired: true });
    // Expired: no later run asks the service again.
    expect(await tick()).toEqual([]);
    expect(await refreshEntries()).toHaveLength(1);
  });

  it('a page refreshes the stale accounts its reader may use, and says which changed', async () => {
    const stale = await connect('Stale');
    const fresh = await connect('Fresh');
    const bob = await root.store.users.upsertFromIdp({
      issuer: 'http://idp.test',
      subject: 'idp|bob',
      email: 'bob@example.com',
      displayName: 'Bob',
    });
    const bobs = (await root.accounts.service.start({ user: bob, groups: [] }, SERVICE, {
      displayName: 'Bob’s',
      fields: { token: 'key-bob-0123456789' },
    })) as { account: AccountRecord };
    // Refreshed an hour ago, both Alice's stale one and Bob's.
    for (const id of [stale.id, bobs.account.id]) {
      const record = await root.store.accounts.getById(id);
      const discovery = {
        ...(record?.metadata?.discovery as object),
        at: new Date(Date.now() - HOUR).toISOString(),
      };
      await root.store.accounts.setMetadata(id, { ...record?.metadata, discovery });
    }
    listed = async () => [thing('alpha'), thing('beta'), thing('delta')];

    const session = await root.auth.sessions.create({
      kind: 'user',
      userId: alice.user.id,
      login: { email: alice.user.email, groups: [] },
    });
    const response = await root.accounts.handlers.refreshOnOpen(
      new Request(`${PUBLIC_URL}/api/accounts/refresh`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: PUBLIC_URL,
          cookie: `${SESSION_COOKIE}=${session.id}`,
        },
        body: JSON.stringify({ account_ids: [stale.id, fresh.id, bobs.account.id] }),
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ refreshed: [stale.id], changed: [stale.id] });
    expect((await resources(stale.id)).has('delta')).toBe(true);
    expect((await resources(bobs.account.id)).has('delta')).toBe(false);
    expect((await refreshEntries()).map((e) => e.after)).toEqual([
      expect.objectContaining({ cause: 'on-open', added: 1 }),
    ]);

    // Not a list of ids: refused.
    const malformed = await root.accounts.handlers.refreshOnOpen(
      new Request(`${PUBLIC_URL}/api/accounts/refresh`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: PUBLIC_URL,
          cookie: `${SESSION_COOKIE}=${session.id}`,
        },
        body: JSON.stringify({ account_ids: stale.id }),
      }),
    );
    expect(malformed.status).toBe(400);
  });
});
