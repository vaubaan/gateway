/**
 * The ceilings of the instance (spec §4.3 bis) over the real composition root on the
 * `:memory:` store: each count refuses its next addition at the ceiling, allows it
 * below, never refuses what does not add (a known person signing in, a reconnection),
 * and never cuts what exists when the ceiling is under the count.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { completeLogin } from '../../../src/server/auth';
import { buildRoot, type GatewayRoot } from '../../../src/server/compose/root';
import { fakePlugin } from '../../support/compose/testing';
import { isConnectError } from '../../../src/server/accounts';
import type { MissionDraft } from '../../../src/server/missions';
import { silentLogger } from '../../../src/server/logging/logger';
import { openMemoryStore, type Store } from '../../../src/server/store';
import type { MissionRecord } from '../../../src/server/store/types';
import { UserAdminError } from '../../../src/server/users';
import { createRegistry } from '@vaubaan/plugin-sdk';
import {
  auditRigOn,
  githubDraft,
  OPERATOR_EMAIL,
  READ,
  seedCall,
  type AuditRig,
} from '../audit/support';
import {
  buildTestRoot,
  PUBLIC_URL,
  seedInstance,
  sessionHeaders,
  testRootDeps,
} from '../missions/support';

const roots: GatewayRoot[] = [];
afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await root.close();
});

async function rigWith(env: Record<string, string>): Promise<AuditRig> {
  const root = await buildTestRoot({ env: { VAUBAAN_ADMIN_EMAILS: OPERATOR_EMAIL, ...env } });
  roots.push(root);
  return auditRigOn(root, await seedInstance(root));
}

async function issue(rig: AuditRig, overrides: Partial<MissionDraft> = {}): Promise<MissionRecord> {
  const result = await rig.root.missions.service.issue(rig.seeded.ada, githubDraft(rig, overrides));
  if (!result.ok) throw new Error(`issue refused: ${JSON.stringify(result)}`);
  return result.mission;
}

async function expire(rig: AuditRig, missionId: string): Promise<void> {
  await rig.root.store.missions.setExpiresAt(missionId, new Date(Date.now() - 1000).toISOString());
  await rig.root.store.missions.setStatus(missionId, 'expired');
}

const activeCount = (rig: AuditRig) =>
  rig.root.store.missions.countActive(new Date().toISOString());

describe('limits.active_missions', () => {
  it('refuses the issuance at the ceiling, from the service and from the form, and allows it below', async () => {
    const rig = await rigWith({ VAUBAAN_LIMITS_ACTIVE_MISSIONS: '2' });
    const first = await issue(rig);
    await issue(rig);

    const refused = await rig.root.missions.service.issue(rig.seeded.ada, githubDraft(rig));
    expect(refused).toMatchObject({
      ok: false,
      reason: 'limit-reached',
      message: 'This gateway holds 2 active missions; its ceiling is 2.',
    });
    const res = await rig.root.missions.handlers.issue(
      new Request(`${PUBLIC_URL}/api/missions`, {
        method: 'POST',
        headers: await sessionHeaders(rig.root, rig.seeded.ada),
        body: JSON.stringify(githubDraft(rig)),
      }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'limit-reached',
      message: 'This gateway holds 2 active missions; its ceiling is 2.',
    });
    // A duplicate is an issuance like any other.
    expect(await rig.root.missions.service.duplicate(rig.seeded.ada, first.id)).toMatchObject({
      ok: false,
      reason: 'limit-reached',
    });
    expect(await activeCount(rig)).toBe(2);

    // A place freed by the people of the instance: the next issuance passes.
    await rig.root.missions.service.revoke(rig.seeded.ada, first.id);
    await issue(rig);
    expect(await activeCount(rig)).toBe(2);
  });

  it('an expired mission frees its place; giving it a new end is refused while the place is taken', async () => {
    const rig = await rigWith({ VAUBAAN_LIMITS_ACTIVE_MISSIONS: '2' });
    const later = new Date(Date.now() + 86_400_000).toISOString();
    const ended = await issue(rig, { expires_at: later });
    await issue(rig);
    await expire(rig, ended.id);
    const filler = await issue(rig);

    const view = await rig.root.missions.service.editView(rig.seeded.ada, ended.id);
    if (!view) throw new Error('no edit view');
    const revive = { draft: { ...view.draft, expires_at: later }, revision: view.revision };
    expect(await rig.root.missions.service.edit(rig.seeded.ada, ended.id, revive)).toMatchObject({
      ok: false,
      reason: 'limit-reached',
      message: 'This gateway holds 2 active missions; its ceiling is 2.',
    });
    const res = await rig.root.missions.handlers.edit(
      new Request(`${PUBLIC_URL}/api/missions/${ended.id}/edit`, {
        method: 'POST',
        headers: await sessionHeaders(rig.root, rig.seeded.ada),
        body: JSON.stringify(revive),
      }),
      ended.id,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'limit-reached' });
    expect((await rig.root.store.missions.getById(ended.id))?.status).toBe('expired');

    // An edit that leaves it ended adds nothing: it is not refused.
    const renamed = {
      draft: { ...view.draft, name: 'Renamed, still ended' },
      revision: view.revision,
    };
    expect(await rig.root.missions.service.edit(rig.seeded.ada, ended.id, renamed)).toMatchObject({
      ok: true,
    });

    await rig.root.missions.service.revoke(rig.seeded.ada, filler.id);
    const again = await rig.root.missions.service.editView(rig.seeded.ada, ended.id);
    if (!again) throw new Error('no edit view');
    expect(
      await rig.root.missions.service.edit(rig.seeded.ada, ended.id, {
        draft: { ...again.draft, expires_at: later },
        revision: again.revision,
      }),
    ).toMatchObject({ ok: true });
    expect((await rig.root.store.missions.getById(ended.id))?.status).toBe('active');
  });

  it('a granted extension of an ended mission is refused at the ceiling, and passes below it', async () => {
    const rig = await rigWith({ VAUBAAN_LIMITS_ACTIVE_MISSIONS: '2' });
    const soon = new Date(Date.now() + 3_600_000).toISOString();
    const later = new Date(Date.now() + 86_400_000).toISOString();
    const mission = await issue(rig, { expires_at: soon });
    // The read quota is five: the sixth read opens a claim.
    let claimId: string | null = null;
    for (let n = 1; n <= 6; n += 1) {
      const fresh = await rig.root.store.missions.getById(mission.id);
      if (!fresh) throw new Error('the mission vanished');
      const seeded = await seedCall(rig, fresh, { risks: [READ], args: { n } });
      if (seeded.result.outcome === 'refused') claimId = seeded.result.request_id ?? null;
    }
    if (!claimId) throw new Error('expected a claim');
    await expire(rig, mission.id);
    const filler = await issue(rig);
    await issue(rig);

    const extend = { resolution: 'extend-expiry', expires_at: later } as const;
    expect(
      await rig.root.requests.service.decideClaim(rig.seeded.ada, claimId, extend),
    ).toMatchObject({
      ok: false,
      reason: 'invalid',
      problem: {
        code: 'limit-reached',
        message: 'This gateway holds 2 active missions; its ceiling is 2.',
      },
    });
    expect((await rig.root.store.missions.getById(mission.id))?.status).toBe('expired');

    await rig.root.missions.service.revoke(rig.seeded.ada, filler.id);
    expect(
      await rig.root.requests.service.decideClaim(rig.seeded.ada, claimId, extend),
    ).toMatchObject({ ok: true });
    expect((await rig.root.store.missions.getById(mission.id))?.status).toBe('active');
  });

  it('a ceiling under the count is accepted at startup: nothing is cut, only additions are refused', async () => {
    let shared: Store | null = null;
    const deps = (env: Record<string, string>) =>
      testRootDeps({
        env: { VAUBAAN_ADMIN_EMAILS: OPERATOR_EMAIL, ...env },
        deps: {
          openStore: async ({ encryptor, catalog }) =>
            (shared ??= openMemoryStore({ encryptor, catalog })),
        },
      });
    const before = await buildRoot(deps({}));
    roots.push(before);
    const rigBefore = auditRigOn(before, await seedInstance(before));
    const missions = [await issue(rigBefore), await issue(rigBefore), await issue(rigBefore)];
    // One store under both roots: the second one starts with the ceiling under the count.
    const after = await buildRoot(deps({ VAUBAAN_LIMITS_ACTIVE_MISSIONS: '2' }));
    roots.push(after);
    const rig: AuditRig = { ...rigBefore, root: after, budget: after.budget };

    expect(await activeCount(rig)).toBe(3);
    for (const mission of missions) {
      const detail = await after.missions.service.get(rig.seeded.ada, mission.id);
      expect(detail?.state.kind).toBe('active');
    }
    const fresh = await after.store.missions.getById(missions[0]!.id);
    if (!fresh) throw new Error('the mission vanished');
    expect((await seedCall(rig, fresh, { risks: [READ] })).result.outcome).toBe('allowed');
    expect(await after.missions.service.issue(rig.seeded.ada, githubDraft(rig))).toMatchObject({
      ok: false,
      reason: 'limit-reached',
      message: 'This gateway holds 3 active missions; its ceiling is 2.',
    });
    expect(await after.limits.usage()).toContainEqual({
      ceiling: 'active-missions',
      count: 3,
      limit: 2,
    });
  });
});

describe('limits.accounts', () => {
  async function acmeRoot(ceiling: string): Promise<GatewayRoot> {
    const root = await buildTestRoot({
      env: { VAUBAAN_LIMITS_ACCOUNTS: ceiling },
      deps: { buildRegistry: async () => createRegistry([fakePlugin()]) },
    });
    roots.push(root);
    return root;
  }

  it('refuses a new account at the ceiling, never a reconnection, and allows one once a place is free', async () => {
    const root = await acmeRoot('1');
    const user = await root.store.users.upsertFromIdp({
      issuer: 'http://idp.test',
      subject: 'idp|ada',
      email: 'ada@example.com',
    });
    const actor = { user, groups: [] };
    const first = await root.accounts.service.start(actor, 'acme', {
      fields: { api_key: 'key-one' },
    });
    if (first.kind !== 'connected') throw new Error('expected an account');

    const refused = await root.accounts.service
      .start(actor, 'acme', { fields: { api_key: 'key-two' } })
      .then(
        () => null,
        (err: unknown) => err,
      );
    expect(isConnectError(refused, 'account-limit-reached')).toBe(true);
    expect(refused).toMatchObject({
      status: 409,
      detail: 'This gateway holds 1 connected account; its ceiling is 1.',
    });
    // The import stores without a start: refused when the account is stored.
    await expect(
      root.accounts.service.importPastedKey(actor, 'acme', {
        displayName: 'Imported',
        fields: { api_key: 'key-three' },
        importedFrom: { system: 'vaubaan-v4', org: 'acme', source: 'v4:acme:1' },
      }),
    ).rejects.toMatchObject({ code: 'account-limit-reached' });
    expect((await root.store.accounts.list()).length).toBe(1);

    // Reconnecting the account adds nothing: never refused.
    const reconnected = await root.accounts.service.start(actor, 'acme', {
      reconnectId: first.account.id,
      fields: { api_key: 'key-one-rotated' },
    });
    expect(reconnected).toMatchObject({ kind: 'connected', reconnected: true });

    await root.accounts.service.revoke(actor, first.account.id);
    expect(
      await root.accounts.service.start(actor, 'acme', { fields: { api_key: 'key-four' } }),
    ).toMatchObject({ kind: 'connected', reconnected: false });
  });
});

describe('limits.users', () => {
  const IDP = 'http://idp.test';
  const identity = (subject: string) => ({
    issuer: IDP,
    subject,
    email: `${subject}@example.com`,
    emailVerified: true as const,
    displayName: null,
    groups: [],
  });

  it('a first sign-in is refused at the ceiling; a known person always signs in', async () => {
    const root = await buildTestRoot({ env: { VAUBAAN_LIMITS_USERS: '2' } });
    roots.push(root);
    const deps = {
      store: root.store,
      bootstrap: root.auth.bootstrap,
      logger: silentLogger,
      ceilings: root.limits,
    };
    const context = { signInProviderId: 'idp', administrators: root.auth.administrators };
    await completeLogin(deps, identity('ada'), context);
    await completeLogin(deps, identity('bob'), context);

    await expect(completeLogin(deps, identity('carol'), context)).rejects.toMatchObject({
      name: 'LoginError',
      code: 'user-limit-reached',
    });
    expect(await root.store.users.getByIdentity(IDP, 'carol')).toBeNull();
    // Ada exists: at the ceiling she signs in as before.
    expect((await completeLogin(deps, identity('ada'), context)).user.subject).toBe('ada');
    expect(await root.store.users.countActive()).toBe(2);
  });

  it('an invitation for a new address and a reactivation are refused at the ceiling', async () => {
    const root = await buildTestRoot({
      env: { VAUBAAN_LIMITS_USERS: '2', VAUBAAN_ADMIN_EMAILS: OPERATOR_EMAIL },
    });
    roots.push(root);
    const seeded = await seedInstance(root);
    const operator = { actorId: 'bootstrap', userId: null };

    const refusal = await root.users.invitations.invite('bootstrap', 'carol@example.com').then(
      () => null,
      (err: unknown) => err,
    );
    expect(refusal).toBeInstanceOf(UserAdminError);
    expect(refusal).toMatchObject({ code: 'limit-reached', status: 409 });
    expect((refusal as UserAdminError).sentence).toContain(
      'This gateway holds 2 people; its ceiling is 2.',
    );
    // An address an active person already holds adds nobody.
    await expect(root.users.invitations.invite('bootstrap', seeded.bob.email)).resolves.toBe(
      seeded.bob.email,
    );

    await root.users.service.deactivate(operator, seeded.bob.id);
    await root.users.invitations.invite('bootstrap', 'carol@example.com');
    await root.store.users.upsertFromIdp({
      issuer: IDP,
      subject: 'carol',
      email: 'carol@example.com',
    });
    await expect(root.users.service.reactivate(operator, seeded.bob.id)).rejects.toMatchObject({
      code: 'limit-reached',
    });
    expect((await root.store.users.getById(seeded.bob.id))?.status).toBe('removed');
  });
});

describe('limits.users — an invitation link of a sign-in account', () => {
  function form(fields: Record<string, string>): Request {
    return new Request(`${PUBLIC_URL}/form`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: PUBLIC_URL },
      body: new URLSearchParams(fields).toString(),
    });
  }

  it('is refused at the ceiling before it is spent, and works once a place is free', async () => {
    const root = await buildTestRoot({ env: { VAUBAAN_LIMITS_USERS: '1' } });
    roots.push(root);
    await root.auth.signInProviders.save(
      {
        id: 'local',
        kind: 'local',
        name: '',
        issuer: '',
        clientId: '',
        clientSecret: null,
        allowedEmailDomains: [],
        invitationOnly: true,
      },
      'create',
    );
    await root.users.invitations.invite('bootstrap', 'ada@example.com');
    const link = await root.auth.signInAccounts.createLink({
      kind: 'invite',
      signInProviderId: 'local',
      email: 'ada@example.com',
      createdBy: 'bootstrap',
    });
    const present = await root.store.users.upsertFromIdp({
      issuer: 'http://idp.test',
      subject: 'idp|present',
      email: 'present@example.com',
    });
    const password = 'a sentence ada remembers';
    const fields = { token: link.token, password, password_again: password };

    const refused = await root.auth.handlers.createSignInAccount(form(fields));
    expect(refused.status).toBe(303);
    expect(refused.headers.get('location')).toBe('/login?error=user-limit-reached');
    expect(await root.store.signInAccounts.list('local')).toEqual([]);

    await root.users.service.deactivate({ actorId: 'bootstrap', userId: null }, present.id);
    const created = await root.auth.handlers.createSignInAccount(form(fields));
    expect(created.status).toBe(303);
    expect(created.headers.get('location')).not.toContain('error=');
    expect((await root.store.signInAccounts.list('local')).map((a) => a.email)).toEqual([
      'ada@example.com',
    ]);
  });
});
