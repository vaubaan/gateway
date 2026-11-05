/**
 * A brokered plugin fits the OAuth provider table the broker compiles in
 * (spec oauth-broker §4, ADR oauth-brokers-managed-in-settings-with-two-client-sources):
 * an unknown provider or a scope the table does not allow stops the boot.
 */
import { GOOGLE } from '@vaubaan/oauth-providers';
import { PluginRegistry, PluginRegistryError, type CredentialSpec } from '@vaubaan/plugin-sdk';
import { describe, expect, it } from 'vitest';

import { loadInstanceConfig } from '../config';
import { validEnv } from '../../../tests/support/config/testing';
import { memoryStoreDeps } from '../../../tests/support/compose/testing';
import { fixturePlugin } from '../../../tests/support/connections/testing';
import { brokeredPluginProblems } from './registry';
import { buildRoot } from './root';

const EVENTS = 'https://www.googleapis.com/auth/calendar.events';

function brokered(provider: string, scopes: readonly string[]): CredentialSpec {
  return { kind: 'oauth2', broker: { provider }, scopes };
}

describe('brokered plugins against the OAuth provider table', () => {
  it('accepts a provider of the table and scopes it allows', () => {
    expect(GOOGLE.allowedScopes.has(EVENTS)).toBe(true);
    const plugin = fixturePlugin({ id: 'calco', credential: brokered('google', [EVENTS]) });
    expect(brokeredPluginProblems([plugin])).toEqual([]);
  });

  it('names a provider the table does not list', () => {
    const plugin = fixturePlugin({ id: 'calco', credential: brokered('outlook', [EVENTS]) });
    expect(brokeredPluginProblems([plugin])).toEqual([
      "plugin 'calco' is brokered by provider 'outlook', which the OAuth provider table does not list (listed: google)",
    ]);
  });

  it('names every scope the provider does not allow', () => {
    const wide = 'https://www.googleapis.com/auth/calendar';
    const plugin = fixturePlugin({ id: 'calco', credential: brokered('google', [EVENTS, wide]) });
    expect(brokeredPluginProblems([plugin])).toEqual([
      `plugin 'calco' asks provider 'google' for scopes the OAuth provider table does not allow: ${wide}`,
    ]);
  });

  it('stops the boot, naming the plugin', async () => {
    const plugin = fixturePlugin({ id: 'calco', credential: brokered('outlook', []) });
    const err = await buildRoot({
      loadConfig: () => loadInstanceConfig({ env: validEnv() }),
      logWrite: () => undefined,
      buildRegistry: async () => new PluginRegistry([plugin]),
      ...memoryStoreDeps,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PluginRegistryError);
    expect((err as PluginRegistryError).issues[0]).toContain("plugin 'calco'");
  });
});
