/**
 * The providers table (spec oauth-broker §4): the client secret goes to `tokenEndpoint` and
 * `revokeEndpoint`, so every endpoint is the provider's own, over https, and the scopes are
 * the narrow ones the plugins need, never a whole-account grant.
 */
import { describe, expect, it } from 'vitest';

import { GOOGLE, MICROSOFT, PROVIDERS } from './providers.ts';

const OWN_HOSTS: Record<string, readonly string[]> = {
  google: ['accounts.google.com', 'oauth2.googleapis.com'],
  microsoft: ['login.microsoftonline.com'],
};

describe('the OAuth providers a broker serves', () => {
  it('are keyed by their own id', () => {
    expect([...PROVIDERS.keys()].sort()).toEqual(['google', 'microsoft']);
    for (const [id, provider] of PROVIDERS) expect(provider.id).toBe(id);
  });

  it('send the client secret only to the provider’s own hosts, over https', () => {
    for (const provider of PROVIDERS.values()) {
      const endpoints = [
        provider.authorizeEndpoint,
        provider.tokenEndpoint,
        ...(provider.revokeEndpoint === undefined ? [] : [provider.revokeEndpoint]),
      ];
      for (const endpoint of endpoints) {
        const url = new URL(endpoint);
        expect(url.protocol, endpoint).toBe('https:');
        expect(OWN_HOSTS[provider.id], endpoint).toContain(url.hostname);
        expect(url.search, endpoint).toBe('');
      }
    }
  });

  it('allow the scopes the plugins need, never a whole-account or organisation-wide grant', () => {
    expect(GOOGLE.allowedScopes).not.toContain('https://www.googleapis.com/auth/calendar');
    // `drive` is the google-drive plugin's (restricted at Google; approved 2026-11-27, ADR
    // local-instance-carries-installed-oauth-clients): the person's own files, no admin scope.
    expect([...GOOGLE.allowedScopes].filter((s) => s.startsWith('https://'))).toEqual([
      'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/drive',
    ]);
    for (const scope of MICROSOFT.allowedScopes) {
      expect(scope, scope).not.toMatch(/\.All$|^Directory\./);
    }
    // The onedrive plugin's: the signed-in person's files only, never `Files.ReadWrite.All`.
    expect([...MICROSOFT.allowedScopes].filter((s) => s.startsWith('Files.'))).toEqual([
      'Files.ReadWrite',
    ]);
  });

  it('ask for a refresh token the way each provider answers one', () => {
    expect(GOOGLE.authorizeParams).toEqual({ access_type: 'offline', prompt: 'consent' });
    expect(MICROSOFT.allowedScopes).toContain('offline_access');
    // Microsoft revokes no single refresh token: the broker erases its sealed copy only.
    expect(MICROSOFT.revokeEndpoint).toBeUndefined();
  });
});
