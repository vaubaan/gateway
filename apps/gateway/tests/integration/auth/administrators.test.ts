/**
 * The administrators live in the instance (ADR administrators-live-in-the-instance):
 * the configuration's rule is a seed applied while the store names nobody — the
 * upgrade of an instance that ran on `admin.emails` / `admin.group` keeps every
 * administrator —, a changed rule grants nothing by itself, a pending address becomes
 * its person at the first sign-in, and no act leaves the instance without an
 * administrator who has a way in.
 */
import { switchOnForTests } from '../../support/auth/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { CONFIGURATION_ACTOR_ID } from '@vaubaan/gateway-core';

import { SESSION_COOKIE } from '../../../src/server/auth';
import { completeLogin } from '../../../src/server/auth/login';
import { buildRoot, type GatewayRoot } from '../../../src/server/compose/root';
import { loadInstanceConfig } from '../../../src/server/config';
import { validEnv } from '../../support/config/testing';
import { silentLogger } from '../../../src/server/logging';
import { openMemoryStore, type Store } from '../../../src/server/store';
import { saveTestOidcSignInProvider } from '../../support/auth/testing';

const PUBLIC_URL = 'https://gateway.example.com';
const IDP = 'https://idp.example.com';

/** One store shared by several boots, as a volume is by two versions of the image. */
interface Volume {
  store: Store | null;
}

async function boot(
  volume: Volume,
  env: Record<string, string | undefined>,
  prepare?: (store: Store) => Promise<void>,
): Promise<GatewayRoot> {
  return buildRoot({
    loadConfig: () =>
      loadInstanceConfig({ env: validEnv({ VAUBAAN_PUBLIC_URL: PUBLIC_URL, ...env }) }),
    logWrite: () => undefined,
    openStore: async ({ encryptor, catalog }) => {
      if (!volume.store) {
        const opened = openMemoryStore({ encryptor, catalog });
        await prepare?.(opened);
        volume.store = opened;
      }
      // The root closes its store on shutdown; the volume outlives it.
      return { ...volume.store, close: async () => undefined };
    },
  });
}

async function sessionOf(root: GatewayRoot, userId: string, email: string): Promise<Headers> {
  const session = await root.auth.sessions.create({
    kind: 'user',
    userId,
    login: { email, groups: [] },
  });
  return new Headers({ cookie: `${SESSION_COOKIE}=${session.id}` });
}

function post(path: string, headers: Headers, fields: Record<string, string> = {}): Request {
  const h = new Headers(headers);
  h.set('origin', PUBLIC_URL);
  h.set('content-type', 'application/x-www-form-urlencoded');
  return new Request(`${PUBLIC_URL}${path}`, {
    method: 'POST',
    headers: h,
    body: new URLSearchParams(fields).toString(),
  });
}

async function isAdmin(root: GatewayRoot, headers: Headers): Promise<boolean> {
  const principal = await root.auth.authenticator.authenticate(headers);
  return (await root.auth.authenticator.authorizeAdmin(principal)).ok;
}

describe('administrators live in the instance', () => {
  const roots: GatewayRoot[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((r) => r.close()));
  });

  it('an upgraded instance on admin.emails keeps its administrators: the rule lands in the store once', async () => {
    const volume: Volume = { store: null };
    let opsId = '';
    const root = await boot(
      volume,
      { VAUBAAN_ADMIN_EMAILS: 'ops@example.com,later@example.com' },
      async (store) => {
        // Signed in before the upgrade: a row of `users`, administrator by the rule.
        opsId = (
          await store.users.upsertFromIdp({ issuer: IDP, subject: 'ops', email: 'ops@example.com' })
        ).id;
      },
    );
    roots.push(root);
    const designations = await root.store.administrators.list();
    expect(designations).toEqual([
      expect.objectContaining({ kind: 'user', userId: opsId, origin: 'configuration' }),
      expect.objectContaining({ kind: 'email', email: 'later@example.com', signInProvider: null }),
    ]);
    expect(await isAdmin(root, await sessionOf(root, opsId, 'ops@example.com'))).toBe(true);
    const [seeded] = (await root.store.audit.list({ kind: 'admin' })).filter(
      (e) => e.kind === 'admin' && e.act === 'administrators-seeded',
    );
    expect(seeded).toMatchObject({ user_id: CONFIGURATION_ACTOR_ID });
  });

  it('an upgraded instance on admin.group keeps every member of the group administrator (the shape of an instance upgraded from the group-only rule)', async () => {
    const volume: Volume = { store: null };
    let memberId = '';
    const root = await boot(
      volume,
      { VAUBAAN_ADMIN_EMAILS: undefined, VAUBAAN_ADMIN_GROUP: 'idp:5f0c-admins' },
      async (store) => {
        const member = await store.users.upsertFromIdp({
          issuer: IDP,
          subject: 'm',
          email: 'm@corp.example',
        });
        memberId = member.id;
        await store.groups.syncIdpMemberships(member.id, ['5f0c-admins'], 'idp');
      },
    );
    roots.push(root);
    await saveTestOidcSignInProvider(root.store.config, {
      issuer: IDP,
      clientId: 'c',
      clientSecret: 's',
      claims: { sub: 'sub', email: 'email', groups: 'groups' },
      allowedEmailDomains: [],
      invitationOnly: true,
    });
    expect(await root.store.administrators.list()).toEqual([
      expect.objectContaining({
        kind: 'group',
        groupName: 'idp:5f0c-admins',
        signInProvider: null,
      }),
    ]);
    expect(await isAdmin(root, await sessionOf(root, memberId, 'm@corp.example'))).toBe(true);
    // A member of the group who never signed in is admitted by the invitation-only provider.
    expect(
      await root.auth.administrators.admits(
        { issuer: IDP, subject: 'new', email: 'new@corp.example', groups: ['5f0c-admins'] },
        'idp',
      ),
    ).toBe(true);
  });

  it('a rule changed after the first boot grants nothing by itself; an administrator applies it', async () => {
    const volume: Volume = { store: null };
    let opsId = '';
    const first = await boot(volume, {}, async (store) => {
      opsId = (
        await store.users.upsertFromIdp({ issuer: IDP, subject: 'ops', email: 'ops@example.com' })
      ).id;
    });
    await first.close();
    // The environment of the host changes: somebody names a new administrator from outside.
    const lines: string[] = [];
    const second = await buildRoot({
      loadConfig: () =>
        loadInstanceConfig({
          env: validEnv({
            VAUBAAN_PUBLIC_URL: PUBLIC_URL,
            VAUBAAN_ADMIN_EMAILS: 'intruder@example.com',
          }),
        }),
      logWrite: (_level, line) => lines.push(line),
      openStore: async () => ({ ...volume.store!, close: async () => undefined }),
    });
    roots.push(second);
    const intruder = await second.store.users.upsertFromIdp({
      issuer: IDP,
      subject: 'intruder',
      email: 'intruder@example.com',
    });
    expect(await isAdmin(second, await sessionOf(second, intruder.id, intruder.email))).toBe(false);
    expect(lines.some((l) => l.includes('differs from the one applied'))).toBe(true);
    expect(await second.auth.administrators.configurationDrift()).toMatchObject({
      configured: { emails: ['intruder@example.com'] },
    });
    // An administrator, inside, decides.
    const ops = await sessionOf(second, opsId, 'ops@example.com');
    await second.users.handlers.applyConfigurationRule(
      post('/admin/users/administrators/apply-configuration', ops),
    );
    expect(await isAdmin(second, await sessionOf(second, intruder.id, intruder.email))).toBe(true);
    expect(await second.auth.administrators.configurationDrift()).toBeNull();
  });

  it('a store that names nobody, with no rule and no bootstrap token, does not boot', async () => {
    await expect(
      boot(
        { store: null },
        {
          VAUBAAN_ADMIN_EMAILS: undefined,
          VAUBAAN_BOOTSTRAP_TOKEN: undefined,
          VAUBAAN_SIGN_IN_IDP_KIND: 'oidc',
          VAUBAAN_SIGN_IN_IDP_ISSUER: IDP,
          VAUBAAN_SIGN_IN_IDP_CLIENT_ID: 'c',
          VAUBAAN_SIGN_IN_IDP_CLIENT_SECRET: 's',
          VAUBAAN_SIGN_IN_IDP_ALLOWED_EMAIL_DOMAINS: 'example.com',
        },
      ),
    ).rejects.toThrow(/no administrator yet and no admin rule/);
    // With a token, the setup names the first administrator.
    const root = await boot({ store: null }, { VAUBAAN_ADMIN_EMAILS: undefined });
    roots.push(root);
    expect(await root.store.administrators.count()).toBe(0);
  });

  it('a pending address becomes its person at the first sign-in through that sign-in provider', async () => {
    const root = await boot({ store: null }, { VAUBAAN_ADMIN_EMAILS: undefined });
    roots.push(root);
    await root.auth.administrators.grantEmail('ada@example.com', 'idp', 'bootstrap');
    const identity = {
      issuer: IDP,
      subject: 'ada',
      email: 'ada@example.com',
      emailVerified: true as const,
      displayName: null,
      groups: [],
    };
    // Through another sign-in provider, the address names nobody.
    expect(await root.auth.administrators.admits(identity, 'github')).toBe(false);
    expect(await root.auth.administrators.admits(identity, 'idp')).toBe(true);
    const outcome = await completeLogin(
      { store: root.store, bootstrap: root.auth.bootstrap, logger: silentLogger },
      identity,
      { signInProviderId: 'idp', administrators: root.auth.administrators },
    );
    expect(outcome.isOperator).toBe(true);
    expect(await root.store.administrators.list()).toEqual([
      expect.objectContaining({ kind: 'user', userId: outcome.user.id }),
    ]);
  });

  it('no self-lockout: the last administrator with a way in is neither unmade nor deactivated, nor their sign-in provider removed', async () => {
    const root = await boot({ store: null }, { VAUBAAN_ADMIN_EMAILS: undefined });
    roots.push(root);
    await root.auth.signInProviders.save(
      {
        id: 'github',
        kind: 'github',
        name: 'GitHub',
        issuer: '',
        clientId: 'gh',
        clientSecret: 'gh-secret',
        allowedEmailDomains: [],
        invitationOnly: true,
      },
      'create',
    );
    await switchOnForTests(root.store.config, 'github');
    const ops = await root.store.users.upsertFromIdp({
      issuer: 'https://github.com',
      subject: '1',
      email: 'ops@example.com',
    });
    const bob = await root.store.users.upsertFromIdp({
      issuer: 'https://github.com',
      subject: '2',
      email: 'bob@example.com',
    });
    await root.auth.administrators.grantUser(ops.id, 'bootstrap', 'setup');
    const opsHeaders = await sessionOf(root, ops.id, ops.email);

    await root.users.handlers.unmakeAdministrator(
      post(`/admin/users/${ops.id}/unmake-administrator`, opsHeaders),
      ops.id,
    );
    expect(await root.store.administrators.ofUser(ops.id)).not.toBeNull();
    const removal = await root.auth.handlers.removeSignInProvider(
      post('/api/admin/sign-in-providers/github/remove', opsHeaders),
      'github',
    );
    expect(removal.headers.get('location')).toContain('problem=');
    expect(await root.auth.signInProviders.view('github')).not.toBeNull();

    // A second administrator: now the first may go, and the remover keeps their session.
    await root.users.handlers.makeAdministrator(
      post(`/admin/users/${bob.id}/make-administrator`, opsHeaders),
      bob.id,
    );
    expect(await root.store.administrators.ofUser(bob.id)).not.toBeNull();
    await root.users.handlers.deactivate(
      post(`/admin/users/${bob.id}/deactivate`, opsHeaders),
      bob.id,
    );
    expect((await root.store.users.getById(bob.id))?.status).toBe('removed');
    // Bob gone, ops is the last again: deactivating ops is refused (by another session of ops).
    await root.users.handlers.deactivate(
      post(`/admin/users/${ops.id}/deactivate`, opsHeaders),
      ops.id,
    );
    expect((await root.store.users.getById(ops.id))?.status).toBe('active');
  });

  it('removing a sign-in provider ends the sessions of its users, never the remover’s own', async () => {
    const root = await boot({ store: null }, { VAUBAAN_ADMIN_EMAILS: undefined });
    roots.push(root);
    for (const [id, issuer] of [
      ['github', ''],
      ['other', 'https://ghe.example.com'],
    ] as const) {
      await root.auth.signInProviders.save(
        {
          id,
          kind: 'github',
          name: id,
          issuer,
          clientId: 'c',
          clientSecret: 's',
          allowedEmailDomains: [],
          invitationOnly: true,
        },
        'create',
      );
      await switchOnForTests(root.store.config, id);
    }
    const ops = await root.store.users.upsertFromIdp({
      issuer: 'https://github.com',
      subject: '1',
      email: 'ops@example.com',
    });
    const backup = await root.store.users.upsertFromIdp({
      issuer: 'https://ghe.example.com',
      subject: 'b',
      email: 'b@example.com',
    });
    const peer = await root.store.users.upsertFromIdp({
      issuer: 'https://github.com',
      subject: '3',
      email: 'peer@example.com',
    });
    await root.auth.administrators.grantUser(ops.id, 'bootstrap', 'setup');
    await root.auth.administrators.grantUser(backup.id, 'bootstrap', 'setup');
    const opsHeaders = await sessionOf(root, ops.id, ops.email);
    const peerHeaders = await sessionOf(root, peer.id, peer.email);
    const removed = await root.auth.handlers.removeSignInProvider(
      post('/api/admin/sign-in-providers/github/remove', opsHeaders),
      'github',
    );
    expect(removed.headers.get('location')).toContain('removed=github');
    expect(await root.auth.authenticator.authenticate(opsHeaders)).not.toBeNull();
    expect(await root.auth.authenticator.authenticate(peerHeaders)).toBeNull();
  });
});

describe('the setup ends by an explicit step', () => {
  it('"Finish setup" is refused while no administrator has a way in, then revokes the token and its sessions', async () => {
    const root = await boot({ store: null }, { VAUBAAN_ADMIN_EMAILS: undefined });
    try {
      const session = await root.auth.sessions.create({ kind: 'bootstrap' });
      const bootstrap = new Headers({ cookie: `${SESSION_COOKIE}=${session.id}` });
      const finish = () =>
        root.users.handlers.finishSetup(post('/api/admin/setup/finish', bootstrap));

      await finish();
      expect((await root.auth.bootstrap.state()).status).toBe('active');

      // A local administrator named by the setup is a way in.
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
      await root.users.handlers.createFirstAdministrator(
        post('/admin/users/first-administrator', bootstrap, {
          email: 'first@example.com',
          password: 'a sentence long enough',
          password_again: 'a sentence long enough',
        }),
      );
      // Nothing revokes the token by itself any more; the explicit step does.
      expect((await root.auth.bootstrap.state()).status).toBe('active');
      await finish();
      expect((await root.auth.bootstrap.state()).status).toBe('revoked');
      expect(await root.auth.authenticator.authenticate(bootstrap)).toBeNull();
      const acts = (await root.store.audit.list({ kind: 'admin' })).flatMap((e) =>
        e.kind === 'admin' ? [e.act] : [],
      );
      expect(acts).toContain('setup-finished');
    } finally {
      await root.close();
    }
  });
});
