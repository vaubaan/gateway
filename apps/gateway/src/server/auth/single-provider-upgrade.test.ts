/**
 * The single-provider settings of earlier builds (`idp.*` in `instance_config`)
 * become the saved sign-in provider `idp`, once, at boot.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openTestStore, type TestStore } from '../store/testing';
import { SignInProvidersService } from './sign-in-providers';
import { SINGLE_PROVIDER_KEYS, upgradeSingleProviderSettings } from './single-provider-upgrade';

const NOW = new Date('2026-10-31T12:00:00.000Z');
const PUBLIC_URL = new URL('https://gateway.test');
const quiet = { info: () => undefined, warn: () => undefined };

describe('the single-provider settings of earlier builds', () => {
  let t: TestStore;
  beforeEach(() => {
    t = openTestStore();
  });
  afterEach(() => t.store.close());

  /** What an earlier build wrote when an administrator saved the identity provider. */
  async function storedAsEarlierBuild(): Promise<void> {
    const keys = SINGLE_PROVIDER_KEYS;
    await t.store.config.apply([
      { kind: 'value', key: keys.issuer, value: 'https://login.example.com/realms/acme' },
      { kind: 'value', key: keys.clientId, value: 'vaubaan' },
      { kind: 'secret', key: keys.clientSecret, plain: 'directory-secret' },
      { kind: 'value', key: keys.claimGroups, value: 'memberOf' },
      { kind: 'value', key: keys.allowedEmailDomains, value: '["example.com"]' },
      { kind: 'value', key: keys.invitationOnly, value: 'false' },
    ]);
    // A waiver an administrator set on it stays with the id.
    await t.store.config.set('sign_in_state.idp', JSON.stringify({ enabled: true, waiver: 'amr' }));
  }

  const upgrade = (configured: { id: string }[] = []) =>
    upgradeSingleProviderSettings({ store: t.store, configured, logger: quiet, now: () => NOW });

  const providers = () =>
    new SignInProvidersService(
      { signIn: [], publicUrl: PUBLIC_URL },
      async () => [],
      t.store.config,
      { now: () => NOW },
    );

  it('become the saved provider idp, its secret sealed again, and leave no key behind', async () => {
    await storedAsEarlierBuild();

    expect(await upgrade()).toEqual({ moved: true, unbound: 0 });

    const keys = await t.store.config.keys();
    expect(keys.filter((key) => key.startsWith('idp.'))).toEqual([]);
    const resolved = await providers().resolve('idp');
    expect(resolved).toMatchObject({
      source: 'store',
      provider: {
        kind: 'oidc',
        id: 'idp',
        name: 'login.example.com',
        clientId: 'vaubaan',
        clientSecret: 'directory-secret',
        claims: { sub: 'sub', email: 'email', groups: 'memberOf' },
        allowedEmailDomains: ['example.com'],
        invitationOnly: false,
      },
    });
    expect(resolved?.provider.issuer.href).toBe('https://login.example.com/realms/acme');
    const state = await providers().state('idp');
    expect(state).toMatchObject({ enabled: true, waiver: 'amr' });

    // Once done, nothing more happens.
    expect(await upgrade()).toEqual({ moved: false, unbound: 0 });
  });

  it('only deletes the old keys when the configuration sets the provider idp itself', async () => {
    await storedAsEarlierBuild();
    expect(await upgrade([{ id: 'idp' }])).toEqual({ moved: false, unbound: 0 });
    expect(await t.store.config.get('sign_in.idp')).toBeNull();
    expect((await t.store.config.keys()).filter((key) => key.startsWith('idp.'))).toEqual([]);
  });

  it('counts the accounts of a build before 2.0.0-alpha.1 that no issuer holds', async () => {
    t.store.db
      .prepare(
        `INSERT INTO users (id, identity_key, issuer, subject, email, status, created_at)
         VALUES ('old', 'unbound 7', NULL, '7', 'old@example.com', 'active', ?)`,
      )
      .run(NOW.toISOString());
    const warned: string[] = [];
    const result = await upgradeSingleProviderSettings({
      store: t.store,
      configured: [],
      logger: { info: () => undefined, warn: (message) => warned.push(message) },
      now: () => NOW,
    });
    expect(result).toEqual({ moved: false, unbound: 1 });
    expect(warned).toEqual(['accounts of a build before 2.0.0-alpha.1 are bound to no issuer']);
  });
});
