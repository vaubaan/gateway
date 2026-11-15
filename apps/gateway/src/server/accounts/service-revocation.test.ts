/**
 * Revoking an account also withdraws the grant at the service, when the
 * service documents how (spec §2.3 "Account"; ADR
 * provider-side-revocation-on-connection-revoke). Every service here is
 * simulated (`mockFetch` refuses any request no route covers).
 *
 * What is pinned: the order (revoked here first, the service asked after),
 * the three outcomes and where each is kept (the row, the audit entry, the
 * notice), and that nothing the service does can undo or delay the local
 * revocation beyond the request's own timeout.
 */
import type { AccountContext, OAuth2CredentialSpec } from '@vaubaan/plugin-sdk';
import type { MockRoute } from '@vaubaan/plugin-sdk/testing';
import { describe, expect, it, vi } from 'vitest';

import { canWithdraw } from './credentials';
import { REVOCATION_REQUEST_TIMEOUT_MS } from './oauth2';
import { DEFAULT_BY_HAND, serviceGrantForecast, serviceGrantReport } from './service-grant';
import type { StartResult } from './service';
import {
  API_KEY_SPEC,
  accountsHarness,
  fixturePlugin,
  OAUTH_SPEC,
  stateOf,
  type AccountsHarness,
} from '../../../tests/support/accounts/testing';

const REVOKE_URL = 'https://service.example.com/oauth/revoke';
const BY_HAND = 'Remove the application in the settings of your OAuth Co account, under Apps.';
const TOKEN_OK: MockRoute = {
  method: 'POST',
  url: OAUTH_SPEC.tokenUrl,
  body: { access_token: 'at-PLAINTEXT', refresh_token: 'rt-PLAINTEXT', expires_in: 3600 },
};

const withRevocation = (
  format: 'token-form' | 'client-credentials-json',
): OAuth2CredentialSpec => ({
  ...OAUTH_SPEC,
  revocation: { url: REVOKE_URL, format },
});

function oauthHarness(
  credential: OAuth2CredentialSpec,
  routes: readonly MockRoute[],
  extra: { revoke?: (ctx: AccountContext) => Promise<void> } = {},
): AccountsHarness {
  return accountsHarness({
    plugins: [
      fixturePlugin({
        id: 'oauthco',
        displayName: 'OAuth Co',
        credential,
        manualRevocation: BY_HAND,
        ...extra,
      }),
    ],
    routes: [TOKEN_OK, ...routes],
  });
}

async function connect(h: AccountsHarness) {
  await h.seedClient('oauthco', 'cid', 'csecret-PLAINTEXT');
  const alice = await h.actor('alice@example.com');
  const started: StartResult = await h.service.start(alice, 'oauthco');
  if (started.kind !== 'redirect') throw new Error('expected a redirect');
  const done = await h.service.complete(
    alice,
    'oauthco',
    new URLSearchParams({ code: 'code-1', state: stateOf(started.url) }),
  );
  return { alice, account: done.account };
}

const revokedEntry = (h: AccountsHarness) =>
  h.audit.admin.filter((e) => e.act === 'account-revoked');
const revocationCalls = (h: AccountsHarness) => h.fetch.calls.filter((c) => c.url === REVOKE_URL);

describe('revoking an account withdraws the grant at the service', () => {
  it('asks the service once the account is revoked here, and records that it confirmed', async () => {
    let statusWhenAsked: string | undefined;
    let credentialWhenAsked: string | null | undefined;
    const holder: { h?: AccountsHarness; id?: string } = {};
    const h = oauthHarness(withRevocation('token-form'), [
      {
        method: 'POST',
        url: REVOKE_URL,
        respond: () => {
          const row = holder
            .h!.store.db.prepare('SELECT status, credential_blob FROM accounts WHERE id = ?')
            .get(holder.id!) as { status: string; credential_blob: Buffer | null };
          statusWhenAsked = row.status;
          credentialWhenAsked = row.credential_blob === null ? null : 'still stored';
          return {};
        },
      },
    ]);
    holder.h = h;
    const { alice, account } = await connect(h);
    holder.id = account.id;

    const revoked = await h.service.revoke(alice, account.id);
    expect(revoked).toMatchObject({ status: 'revoked', serviceGrant: 'revoked' });
    // The order: nothing here depended on the service's answer.
    expect(statusWhenAsked).toBe('revoked');
    expect(credentialWhenAsked).toBeNull();

    const [call] = revocationCalls(h);
    expect(new URLSearchParams(call!.body ?? '').get('token')).toBe('rt-PLAINTEXT');
    expect(revocationCalls(h)).toHaveLength(1);

    expect((await h.store.accounts.getById(account.id))?.serviceGrant).toBe('revoked');
    expect(revokedEntry(h)).toHaveLength(1);
    expect(revokedEntry(h)[0]?.after).toMatchObject({
      status: 'revoked',
      service_grant: 'revoked',
    });
    // No token in the entry.
    expect(JSON.stringify(h.audit.entries)).not.toContain('PLAINTEXT');
  });

  it('sends the client credentials shape with the company secret, which the plugin never saw', async () => {
    const h = oauthHarness(withRevocation('client-credentials-json'), [
      { method: 'POST', url: REVOKE_URL, body: {} },
    ]);
    const { alice, account } = await connect(h);
    expect((await h.service.revoke(alice, account.id)).serviceGrant).toBe('revoked');
    expect(revocationCalls(h)[0]?.json).toEqual({
      client_id: 'cid',
      client_secret: 'csecret-PLAINTEXT',
      refresh_token: 'rt-PLAINTEXT',
    });
  });

  it.each([
    ['refuses', { method: 'POST', url: REVOKE_URL, status: 400, body: { error: 'invalid_token' } }],
    ['is down', { method: 'POST', url: REVOKE_URL, status: 503, body: 'unavailable' }],
  ] as const)(
    'when the service %s, the account is revoked all the same and the grant is marked as not withdrawn',
    async (_case, route) => {
      const h = oauthHarness(withRevocation('token-form'), [route]);
      const { alice, account } = await connect(h);
      const revoked = await h.service.revoke(alice, account.id);
      expect(revoked).toMatchObject({ status: 'revoked', serviceGrant: 'failed' });
      expect(await h.store.accounts.getCredential(account.id)).toBeNull();
      expect(revokedEntry(h)[0]?.after).toMatchObject({ service_grant: 'failed' });
    },
  );

  it('when the service cannot be reached at all, the account is revoked all the same', async () => {
    // No route for the revocation endpoint: `mockFetch` rejects the request.
    const h = oauthHarness(withRevocation('token-form'), []);
    const { alice, account } = await connect(h);
    expect(await h.service.revoke(alice, account.id)).toMatchObject({
      status: 'revoked',
      serviceGrant: 'failed',
    });
  });

  it('a service that documents no endpoint is asked nothing: the grant is to remove by hand', async () => {
    const h = oauthHarness(OAUTH_SPEC, []);
    const { alice, account } = await connect(h);
    const before = h.fetch.calls.length;
    expect((await h.service.revoke(alice, account.id)).serviceGrant).toBe('manual');
    expect(h.fetch.calls).toHaveLength(before);
    expect(revokedEntry(h)[0]?.after).toMatchObject({ service_grant: 'manual' });
  });

  it('an API key is never deleted at the service: it is the person’s own', async () => {
    const h = accountsHarness({
      plugins: [fixturePlugin({ id: 'keyco', credential: API_KEY_SPEC })],
    });
    const alice = await h.actor('alice@example.com');
    const started = await h.service.start(alice, 'keyco', {
      fields: { token: 'tok-1', team_id: 'team_a' },
    });
    if (started.kind !== 'connected') throw new Error('expected an account');
    expect((await h.service.revoke(alice, started.account.id)).serviceGrant).toBe('manual');
    expect(h.fetch.calls).toHaveLength(0);
  });

  it('an expired account still presents its stored refresh token', async () => {
    const h = oauthHarness(withRevocation('token-form'), [{ method: 'POST', url: REVOKE_URL }]);
    const { alice, account } = await connect(h);
    expect(await h.store.accounts.markExpired(account.id)).toBe(true);
    expect((await h.service.revoke(alice, account.id)).serviceGrant).toBe('revoked');
    expect(new URLSearchParams(revocationCalls(h)[0]!.body ?? '').get('token')).toBe(
      'rt-PLAINTEXT',
    );
  });

  it('revoking twice asks the service once and keeps the first answer', async () => {
    const h = oauthHarness(withRevocation('token-form'), [{ method: 'POST', url: REVOKE_URL }]);
    const { alice, account } = await connect(h);
    await h.service.revoke(alice, account.id);
    const again = await h.service.revoke(alice, account.id);
    expect(again.serviceGrant).toBe('revoked');
    expect(revocationCalls(h)).toHaveLength(1);
    expect(revokedEntry(h)).toHaveLength(1);
    // The outcome is written once: a later write changes nothing.
    expect(await h.store.accounts.recordServiceGrant(account.id, 'failed')).toBeNull();
    expect((await h.store.accounts.getById(account.id))?.serviceGrant).toBe('revoked');
  });

  it('an outcome is never recorded on an account that is not revoked', async () => {
    const h = oauthHarness(OAUTH_SPEC, []);
    const { account } = await connect(h);
    expect(await h.store.accounts.recordServiceGrant(account.id, 'revoked')).toBeNull();
    expect((await h.store.accounts.getById(account.id))?.serviceGrant).toBeNull();
  });

  describe('a plugin with its own revoke', () => {
    it('is called with the credential about to be erased, and takes precedence over the declared endpoint', async () => {
      const seen: AccountContext[] = [];
      const h = oauthHarness(withRevocation('token-form'), [], {
        revoke: async (ctx) => {
          seen.push(ctx);
        },
      });
      const { alice, account } = await connect(h);
      expect((await h.service.revoke(alice, account.id)).serviceGrant).toBe('revoked');
      expect(seen).toHaveLength(1);
      expect(seen[0]?.credential).toMatchObject({ kind: 'oauth2', refreshToken: 'rt-PLAINTEXT' });
      expect(seen[0]?.signal).toBeInstanceOf(AbortSignal);
      // The plugin still never sees the OAuth client secret.
      expect(JSON.stringify(seen[0])).not.toContain('csecret-PLAINTEXT');
      expect(revocationCalls(h)).toHaveLength(0);
    });

    it('that throws leaves the account revoked and the grant marked as not withdrawn', async () => {
      const h = oauthHarness(OAUTH_SPEC, [], {
        revoke: async () => {
          throw new Error('service said no, token rt-PLAINTEXT');
        },
      });
      const { alice, account } = await connect(h);
      expect(await h.service.revoke(alice, account.id)).toMatchObject({
        status: 'revoked',
        serviceGrant: 'failed',
      });
    });

    it('that never answers is cut after the delay: the revocation does not hang', async () => {
      const h = oauthHarness(OAUTH_SPEC, [], { revoke: () => new Promise<void>(() => undefined) });
      const { alice, account } = await connect(h);
      vi.useFakeTimers();
      try {
        const pending = h.service.revoke(alice, account.id);
        await vi.advanceTimersByTimeAsync(REVOCATION_REQUEST_TIMEOUT_MS + 2_000);
        expect(await pending).toMatchObject({ status: 'revoked', serviceGrant: 'failed' });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('the page knows beforehand: canWithdraw is the plugin’s revoke or its declared endpoint', async () => {
    const withEndpoint = fixturePlugin({ id: 'a', credential: withRevocation('token-form') });
    const withHook = fixturePlugin({ id: 'b', credential: API_KEY_SPEC, revoke: async () => {} });
    const neither = fixturePlugin({ id: 'c', credential: OAUTH_SPEC });
    expect([withEndpoint, withHook, neither].map((plugin) => canWithdraw(plugin))).toEqual([
      true,
      true,
      false,
    ]);

    const h = oauthHarness(withRevocation('token-form'), [{ method: 'POST', url: REVOKE_URL }]);
    const { alice, account } = await connect(h);
    const view = await h.service.get(alice, account.id);
    expect(view.service_grant).toEqual({ withdrawnByGateway: true, byHand: BY_HAND });
    expect(h.service.serviceGrantOf({ service: 'gone' })).toEqual({
      serviceLabel: 'gone',
      grant: { withdrawnByGateway: false, byHand: null },
    });
  });
});

describe('what the person is told', () => {
  it('before the act: whether the gateway will ask the service, or where to remove the access', () => {
    expect(serviceGrantForecast('OAuth Co', { withdrawnByGateway: true, byHand: BY_HAND })).toBe(
      'The gateway will also ask OAuth Co to withdraw the access it was granted, and will tell you whether OAuth Co confirmed.',
    );
    expect(serviceGrantForecast('Key Co', { withdrawnByGateway: false, byHand: BY_HAND })).toBe(
      `The gateway cannot withdraw the access at Key Co: you remove it there yourself. ${BY_HAND}`,
    );
    expect(serviceGrantForecast('Key Co', { withdrawnByGateway: false, byHand: null })).toContain(
      DEFAULT_BY_HAND,
    );
  });

  it('after the act: confirmed, or left to remove by hand with the place to do it', () => {
    expect(serviceGrantReport('OAuth Co', 'revoked', BY_HAND)).toEqual({
      actionNeeded: false,
      title: 'Access withdrawn at OAuth Co',
      text: 'OAuth Co confirmed that the access granted to this account is withdrawn. Nothing is left to remove there.',
    });
    const failed = serviceGrantReport('OAuth Co', 'failed', BY_HAND);
    expect(failed).toMatchObject({
      actionNeeded: true,
      title: 'Access NOT withdrawn at OAuth Co',
    });
    expect(failed.text).toContain('did not confirm');
    expect(failed.text).toContain(BY_HAND);
    const manual = serviceGrantReport('Key Co', 'manual', BY_HAND);
    expect(manual).toMatchObject({
      actionNeeded: true,
      title: 'Still granted at Key Co',
    });
    expect(manual.text).toContain(BY_HAND);
    // What to do is said once: the plugin's sentence, never a second "remove it" around it.
    for (const report of [manual, failed]) {
      const said = `${report.title}. ${report.text}`;
      expect(said.match(/remove|by hand/gi) ?? [], said).toEqual(['Remove']);
    }
    // An account revoked before the gateway asked anything reads the same way.
    expect(serviceGrantReport('Key Co', null, null)).toMatchObject({ actionNeeded: true });
    expect(serviceGrantReport('Key Co', null, null).text).toContain(DEFAULT_BY_HAND);
  });
});
