/**
 * The Credential row of an account page names the way the account was made, and
 * says when that way is one the gateway no longer offers (ADR
 * gmail-over-imap-with-an-app-password: a Gmail account connected by OAuth).
 */
import { describe, expect, it } from 'vitest';

import { credentialKindLabel } from '@/components/accounts/parts';

describe('credentialKindLabel', () => {
  it('names a way the plugin offers in a few words', () => {
    expect(credentialKindLabel('api-key')).toBe('API key');
    expect(credentialKindLabel('oauth2')).toBe('OAuth authorization');
    expect(credentialKindLabel(null)).toBe('unknown');
  });

  it('says to reconnect an account made a way the plugin no longer offers, known kind or not', () => {
    expect(credentialKindLabel('oauth2', true)).toBe(
      'OAuth authorization (a way this gateway no longer offers: reconnect the account)',
    );
    expect(credentialKindLabel('app-install')).toBe(
      'app-install (a way this gateway no longer offers: reconnect the account)',
    );
  });
});
