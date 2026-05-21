/**
 * Smoke test asserting the core-side `SecretManager` interface is
 * structurally compatible with the catalog-side one. We do NOT import
 * `@crm/catalog` (cycle hazard, see `interface.ts` rationale); instead
 * we just check that the in-tree shape matches the spec §5.2 contract:
 * `kind`, `name`, `get`, `put`, `revoke` are mandatory, `list` is
 * optional.
 */

import { describe, it, expectTypeOf } from 'vitest';

import {
  createDbSecretManager,
  createInfisicalSecretManager,
  type DbSupabaseLike,
} from '../../../src/secret-manager/index.js';
import type { SealedBlob, SecretManager } from '../../../src/secret-manager/interface.js';

describe('SecretManager interface', () => {
  it('createDbSecretManager returns a SecretManager', () => {
    const sm = createDbSecretManager({ supabase: {} as unknown as DbSupabaseLike });
    expectTypeOf(sm).toMatchTypeOf<SecretManager>();
  });

  it('createInfisicalSecretManager returns a SecretManager', () => {
    // We pass an injected client to avoid running the real auth path.
    const sm = createInfisicalSecretManager(
      {
        endpoint: 'https://eu.infisical.com',
        workspaceId: 'ws',
        name: 'default',
        auth: { clientId: 'c', clientSecret: 's' },
      },
      {
        endpoint: 'https://eu.infisical.com',
        workspaceId: 'ws',
        environment: 'prod',
        listSecrets: () => Promise.resolve([]),
        getSecret: () => Promise.resolve(null),
        createSecret: () => Promise.resolve(),
        updateSecret: () => Promise.resolve(),
        upsertSecret: () => Promise.resolve(),
        deleteSecret: () => Promise.resolve(),
      },
    );
    expectTypeOf(sm).toMatchTypeOf<SecretManager>();
  });

  it('SealedBlob v field is locked to 1', () => {
    expectTypeOf<SealedBlob['v']>().toEqualTypeOf<1>();
  });
});
