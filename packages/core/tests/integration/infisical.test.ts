/**
 * Optional Infisical round-trip integration test.
 *
 * Skipped unless the following env vars are set:
 *   - INFISICAL_TEST_ENDPOINT       (e.g. https://eu.infisical.com)
 *   - INFISICAL_TEST_WORKSPACE_ID
 *   - INFISICAL_TEST_CLIENT_ID
 *   - INFISICAL_TEST_CLIENT_SECRET
 *
 * The CI runner doesn't have these. Local dev can wire them from
 * `.env.test` (see Phase 5 plan §context.creds) to verify the client
 * against a real workspace. The test writes one secret under a unique
 * path, reads it back, then cleans up.
 *
 * Spec docs/spec/cloud-resource-manager.md §5.2.
 */

import { describe, it, expect } from 'vitest';

import { createInfisicalSecretManager } from '../../src/secret-manager/infisical.js';
import type { SealedBlob } from '../../src/secret-manager/interface.js';

const env = process.env;
const haveCreds =
  typeof env.INFISICAL_TEST_ENDPOINT === 'string' &&
  typeof env.INFISICAL_TEST_WORKSPACE_ID === 'string' &&
  typeof env.INFISICAL_TEST_CLIENT_ID === 'string' &&
  typeof env.INFISICAL_TEST_CLIENT_SECRET === 'string';

const itIf = haveCreds ? it : it.skip;

describe('infisical SM — integration (network)', () => {
  itIf('round-trips a SealedBlob against a real Infisical workspace', async () => {
    const sm = createInfisicalSecretManager({
      endpoint: env.INFISICAL_TEST_ENDPOINT!,
      workspaceId: env.INFISICAL_TEST_WORKSPACE_ID!,
      environment: env.INFISICAL_TEST_ENVIRONMENT ?? 'prod',
      name: 'integration',
      auth: {
        clientId: env.INFISICAL_TEST_CLIENT_ID!,
        clientSecret: env.INFISICAL_TEST_CLIENT_SECRET!,
      },
    });
    const resourceId = `it-${Date.now()}`;
    const accessKey = 'main';
    const blob: SealedBlob = {
      v: 1,
      recipients: [{ fp: '00000000000000000000000000000000', ct: 'AAAA' }],
    };
    try {
      await sm.put(resourceId, accessKey, blob);
      const out = await sm.get(resourceId, accessKey);
      expect(out).toEqual(blob);
    } finally {
      await sm.revoke(resourceId, accessKey).catch(() => undefined);
    }
  });
});
