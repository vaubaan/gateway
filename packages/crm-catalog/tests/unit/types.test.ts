import { describe, it, expect, expectTypeOf } from 'vitest';

import type {
  AccessKeySpec,
  KindClass,
  OrgResourceAdminKind,
  ResourceKind,
  RotationMethod,
  SealedBlob,
  SecretManager,
} from '../../src/index.js';

/**
 * Smoke tests: the types must compose. Vitest's `expectTypeOf` keeps the
 * surface explicit so any signature drift fails CI loudly.
 *
 * These are intentionally minimal — full kind-by-kind unit tests land
 * when concrete providers are implemented (cf. spec §12.1).
 */
describe('@crm/catalog types surface', () => {
  it('exposes the three kindClass discriminators', () => {
    expectTypeOf<KindClass>().toEqualTypeOf<'org' | 'project' | 'org-admin'>();
  });

  it('exposes the three rotation methods', () => {
    expectTypeOf<RotationMethod>().toEqualTypeOf<'self' | 'admin-mediated' | 'manual'>();
  });

  it('allows defining an AccessKeySpec literal', () => {
    const spec: AccessKeySpec = {
      label: 'GitHub PAT',
      description: 'Personal access token with `repo` scope.',
      required: true,
    };
    expect(spec.required).toBe(true);
  });

  it('lets an OrgResourceAdminKind narrow ResourceKind', () => {
    expectTypeOf<OrgResourceAdminKind>().toMatchTypeOf<ResourceKind>();
  });

  it('models SealedBlob v=1 with multiple recipients', () => {
    const blob: SealedBlob = {
      v: 1,
      recipients: [
        { fingerprint: 'abcd1234', ct: 'YmFzZTY0' },
        { fingerprint: 'ef015678', ct: 'YmFzZTY0Mg==' },
      ],
    };
    expect(blob.v).toBe(1);
    expect(blob.recipients).toHaveLength(2);
  });

  it('keeps SecretManager addressing on (resourceId, accessKey)', () => {
    expectTypeOf<SecretManager['get']>().parameters.toEqualTypeOf<[string, string]>();
    expectTypeOf<SecretManager['put']>().parameters.toEqualTypeOf<[string, string, SealedBlob]>();
  });
});
