/**
 * Structural test (spec oauth-broker §4, ADR
 * oauth-brokers-managed-in-settings-with-two-client-sources): every shipped
 * plugin whose `oauth2` spec takes its client from a broker names a provider
 * of the OAuth provider table, and asks it only for scopes the table allows.
 * The table is what the broker compiles in (`@vaubaan/oauth-providers`); a
 * scope added to a plugin and not to the table would fail at the first consent.
 *
 * Read from the plugins the image ships (`compose/shipped-plugins.ts`), not
 * from a list kept here.
 */
import { PROVIDERS } from '@vaubaan/oauth-providers';
import { isBrokeredSpec, type OAuth2BrokeredSpec } from '@vaubaan/plugin-sdk';
import { describe, expect, it } from 'vitest';

import { SHIPPED_PLUGINS } from '../../../src/server/compose/shipped-plugins';

const BROKERED = SHIPPED_PLUGINS.flatMap((plugin): [string, OAuth2BrokeredSpec][] => {
  const spec = plugin.credential;
  return spec.kind === 'oauth2' && isBrokeredSpec(spec) ? [[plugin.id, spec]] : [];
});

describe('every brokered plugin fits the OAuth provider table', () => {
  it('the image ships a brokered plugin at all', () => {
    expect(BROKERED.length).toBeGreaterThan(0);
  });

  describe.each(BROKERED)('%s', (_id, spec) => {
    it('names a provider of the table', () => {
      expect([...PROVIDERS.keys()]).toContain(spec.broker.provider);
    });

    it('asks only for scopes the table allows that provider', () => {
      const allowed = PROVIDERS.get(spec.broker.provider)?.allowedScopes ?? new Set<string>();
      expect(spec.scopes.filter((scope) => !allowed.has(scope))).toEqual([]);
    });
  });
});
