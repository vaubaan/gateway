/**
 * A Gmail account connected by OAuth in an earlier build, with the Gmail plugin
 * that now connects with an app password over IMAP (ADR
 * gmail-over-imap-with-an-app-password, D4): its stored `oauth2` secret is never
 * handed to the plugin, nothing throws, its page and its discovery say to
 * reconnect, its tools are refused with the reason, and reconnecting it with an
 * app password keeps the account. The IMAP transport is a fake: no network.
 */
import { describe, expect, it } from 'vitest';
import {
  createGmailPlugin,
  type GmailImapSession,
  type GmailTransport,
} from '@vaubaan/plugin-gmail';

import { unavailableReason } from '../execution/resource-stage';
import { serializeSecret } from './credential-codec';
import { connectionsHarness } from '../../../tests/support/connections/testing';

/** Signs in as anyone, lists the two folders the plugin checks, records each session. */
function fakeImap(): GmailTransport & { sessions: string[] } {
  const sessions: string[] = [];
  const session: GmailImapSession = {
    mailboxes: async () => [
      { path: '[Gmail]/All Mail', specialUse: '\\All', selectable: true, parentPath: '[Gmail]' },
      { path: '[Gmail]/Drafts', specialUse: '\\Drafts', selectable: true, parentPath: '[Gmail]' },
    ],
    search: async () => [],
    fetch: async () => [],
    append: async () => null,
    store: async () => undefined,
    download: async () => null,
    createMailbox: async (segments) => ({ path: segments.join('/'), created: true }),
    source: async () => null,
    remove: async () => undefined,
  };
  return {
    sessions,
    async session(account, _options, work) {
      sessions.push(account.email);
      return work(session);
    },
  };
}

describe('a Gmail account connected by OAuth in an earlier build', () => {
  it('runs nothing, says to reconnect, and is reconnected with an app password', async () => {
    const imap = fakeImap();
    const gmail = createGmailPlugin({ transport: imap });
    const h = connectionsHarness({ plugins: [gmail] });
    const alice = await h.actor('alice@example.com');
    const existing = await h.store.connections.create({
      provider: 'gmail',
      owner: { kind: 'user', id: alice.user.id },
      displayName: 'alice@example.com',
      credential: serializeSecret({
        kind: 'oauth2',
        accessToken: 'ya29.stale',
        refreshToken: '1//stale',
        expiresAt: '2026-01-01T00:00:00.000Z',
        scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
        metadata: {},
      }),
      credentialExpiresAt: null,
      metadata: { credential_kind: 'oauth2' },
    });

    // The account page names the way as retired.
    expect(await h.service.get(alice, existing.id)).toMatchObject({
      credential_kind: 'oauth2',
      way_retired: true,
    });

    // Discovery records the reason without calling the plugin.
    const reason =
      'this account was connected a way Gmail no longer offers on this gateway (oauth2); its owner reconnects it from Accounts.';
    expect(await h.service.discover(alice, existing.id)).toMatchObject({
      ok: false,
      error: reason,
    });
    expect(imap.sessions).toEqual([]);

    // Every tool is refused at the resource stage with the same reason.
    for (const tool of gmail.tools.map((t) => t.name)) {
      expect(
        unavailableReason(gmail, { credential_kind: 'oauth2', hosts_instance: false }, tool),
      ).toBe(reason);
    }

    // Reconnecting with an app password keeps the account: signed in over IMAP first.
    const again = await h.service.start(alice, 'gmail', {
      reconnectId: existing.id,
      fields: { email: 'Alice@Example.com', app_password: 'abcd efgh ijkl mnop' },
    });
    if (again.kind !== 'connected') throw new Error('expected a connection');
    expect(again.connection.id).toBe(existing.id);
    expect(again.reconnected).toBe(true);
    expect(again.connection.status).toBe('active');
    expect(again.connection.metadata).toMatchObject({
      credential_kind: 'api-key',
      account: 'alice@example.com',
    });
    expect(imap.sessions.length).toBeGreaterThan(0);
    expect(imap.sessions.every((email) => email === 'alice@example.com')).toBe(true);
    expect((await h.service.get(alice, existing.id)).way_retired).toBe(false);
    expect(
      unavailableReason(
        gmail,
        { credential_kind: 'api-key', hosts_instance: false },
        'gmail__get_thread',
      ),
    ).toBeNull();
    // Nothing reached Google over HTTP.
    expect(h.fetch.calls).toHaveLength(0);
  });
});
