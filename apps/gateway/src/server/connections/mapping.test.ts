/**
 * The single mapping from a stored connection to the shapes other modules
 * show: its snake_case summary and its owner with a human name.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openTestStore, type TestStore } from '../store/testing';
import { connectionCredentialKind, connectionOwnerOf, connectionSummaryOf } from './mapping';

describe('connectionCredentialKind', () => {
  it('reads the kind as stored, keeps a word the contract no longer knows, and falls back to the plugin', () => {
    expect(connectionCredentialKind({ metadata: { credential_kind: 'api-key' } }, 'oauth2')).toBe(
      'api-key',
    );
    // The GitHub App of earlier builds: kept as is, so that the account is refused, not mistaken for a token.
    expect(
      connectionCredentialKind({ metadata: { credential_kind: 'app-install' } }, 'api-key'),
    ).toBe('app-install');
    expect(connectionCredentialKind({ metadata: {} }, 'api-key')).toBe('api-key');
    expect(connectionCredentialKind({ metadata: { credential_kind: '' } }, null)).toBeNull();
  });
});

describe('connection mapping', () => {
  let t: TestStore;

  beforeEach(() => {
    t = openTestStore();
  });
  afterEach(() => t.store.close());

  it('summarises a record as id, provider, display_name and status, and nothing else', async () => {
    const user = await t.store.users.upsertFromIdp({
      issuer: 'http://idp.test',
      subject: 'a',
      email: 'alice@example.com',
    });
    const record = await t.store.connections.create({
      provider: 'github',
      owner: { kind: 'user', id: user.id },
      displayName: 'GitHub (acme)',
      credential: 'secret-value',
      metadata: { installation_id: 42 },
    });
    expect(connectionSummaryOf(record)).toEqual({
      id: record.id,
      provider: 'github',
      display_name: 'GitHub (acme)',
      status: 'active',
    });
  });

  it('names a user owner by email and a group owner by its name', async () => {
    const user = await t.store.users.upsertFromIdp({
      issuer: 'http://idp.test',
      subject: 'a',
      email: 'alice@example.com',
    });
    const group = await t.store.groups.getOrCreate('platform', 'idp', 'idp');

    expect(await connectionOwnerOf(t.store, { owner: { kind: 'user', id: user.id } })).toEqual({
      kind: 'user',
      id: user.id,
      name: 'alice@example.com',
    });
    expect(await connectionOwnerOf(t.store, { owner: { kind: 'group', id: group.id } })).toEqual({
      kind: 'group',
      id: group.id,
      name: 'platform',
    });
  });

  it('gives a null name for an owner that no longer exists, leaving the wording to the caller', async () => {
    expect(await connectionOwnerOf(t.store, { owner: { kind: 'user', id: 'gone' } })).toEqual({
      kind: 'user',
      id: 'gone',
      name: null,
    });
    expect(await connectionOwnerOf(t.store, { owner: { kind: 'group', id: 'gone' } })).toEqual({
      kind: 'group',
      id: 'gone',
      name: null,
    });
  });
});
