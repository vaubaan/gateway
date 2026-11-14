/**
 * The Google Confidential Space adapter (ADR
 * oauth-broker-stateless-in-an-attested-enclave D7), on tokens signed here
 * with a key of the test's own, shaped as Google's "Confidential Space
 * attestation token claims" say: issuer, audience, times, `swname`,
 * `dbgstat`, `secboot`, `hwmodel`, the support attributes, the image digest,
 * and the one nonce — the SPKI hash of the broker's TLS key. The keys are
 * found through the issuer's discovery document, as in production, and found
 * again when they moved.
 */
import { generateKeyPairSync, type KeyObject } from 'node:crypto';

import { exportJWK, SignJWT } from 'jose';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  CONFIDENTIAL_HARDWARE_MODELS,
  GCP_ATTESTATION_ISSUER,
  GCP_CONFIDENTIAL_SPACE,
  GCP_DISCOVERY_URL,
  gcpConfidentialSpace,
} from './attestation-gcp';
import {
  AttestationRefused,
  AttestationVerifier,
  BROKER_ATTESTATION_AUDIENCE,
} from './broker-attestation';

const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/metadata/jwk/signer@test';
const MOVED_JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/metadata/jwk/signer@moved';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const NOW = new Date('2026-10-27T09:00:00.000Z');
const SPKI = 'S'.repeat(43);

let signingKey: KeyObject;
let movedKey: KeyObject;
let jwks: { keys: unknown[] };
let movedJwks: { keys: unknown[] };
let fetched: string[] = [];
/** Where the discovery document points now. */
let jwksUri = JWKS_URL;

beforeAll(async () => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const moved = generateKeyPairSync('rsa', { modulusLength: 2048 });
  signingKey = pair.privateKey;
  movedKey = moved.privateKey;
  jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }] };
  movedJwks = {
    keys: [{ ...(await exportJWK(moved.publicKey)), kid: 'k2', alg: 'RS256', use: 'sig' }],
  };
});

beforeEach(() => {
  fetched = [];
  jwksUri = JWKS_URL;
});

/** Google's discovery document and JWKS, nothing else. */
const googleFetch: typeof fetch = async (input) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  fetched.push(url);
  if (url === GCP_DISCOVERY_URL) {
    return Response.json({ issuer: GCP_ATTESTATION_ISSUER, jwks_uri: jwksUri });
  }
  if (url === JWKS_URL) return Response.json(jwks);
  if (url === MOVED_JWKS_URL) return Response.json(movedJwks);
  return new Response('not found', { status: 404 });
};

function claims(): Record<string, unknown> {
  return {
    swname: 'CONFIDENTIAL_SPACE',
    dbgstat: 'disabled-since-boot',
    secboot: true,
    hwmodel: 'GCP_AMD_SEV',
    eat_nonce: [SPKI],
    submods: {
      confidential_space: { support_attributes: ['LATEST', 'STABLE', 'USABLE'] },
      container: { image_digest: DIGEST },
    },
  };
}

async function token(
  payload: Record<string, unknown>,
  options: { issuer?: string; audience?: string; iat?: Date; key?: KeyObject; kid?: string } = {},
): Promise<string> {
  const iat = Math.floor((options.iat ?? NOW).getTime() / 1000);
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: options.kid ?? 'k1' })
    .setIssuer(options.issuer ?? GCP_ATTESTATION_ISSUER)
    .setAudience(options.audience ?? BROKER_ATTESTATION_AUDIENCE)
    .setIssuedAt(iat)
    .setExpirationTime(iat + 3600)
    .sign(options.key ?? signingKey);
}

const platform = () => gcpConfidentialSpace({ fetch: googleFetch });

async function verify(evidence: unknown, adapter = platform()) {
  return adapter.verify(evidence, { spkiHash: SPKI, now: NOW });
}

async function refused(evidence: unknown, reason: RegExp): Promise<void> {
  const err = await verify(evidence).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AttestationRefused);
  expect((err as Error).message).toMatch(reason);
}

describe('the Google Confidential Space adapter', () => {
  it('admits a token of Google’s keys, for this audience and this key: the measurement is the image digest', async () => {
    const admitted = await verify(await token(claims()));
    expect(admitted).toEqual({
      measurement: DIGEST,
      issuedAt: NOW.getTime(),
      expiresAt: NOW.getTime() + 3600_000,
    });
    expect(fetched).toEqual([GCP_DISCOVERY_URL, JWKS_URL]);
  });

  it('admits the broker’s cached token up to ten minutes old (it refreshes every five)', async () => {
    const older = new Date(NOW.getTime() - 9 * 60_000);
    expect((await verify(await token(claims(), { iat: older }))).issuedAt).toBe(older.getTime());
    await refused(
      await token(claims(), { iat: new Date(NOW.getTime() - 20 * 60_000) }),
      /not valid/,
    );
  });

  it('refuses another signer, issuer or audience', async () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    await refused(await token(claims(), { key: other }), /not valid/);
    await refused(
      await token(claims(), { issuer: 'https://example.com' }),
      /not valid \(ERR_JWT_CLAIM_VALIDATION_FAILED\)/,
    );
    await refused(await token(claims(), { audience: 'https://sts.googleapis.com' }), /not valid/);
    await refused('not-a-jwt', /not valid/);
    await refused(42, /not an attestation token/);
  });

  it('refuses a plain VM, a debug image, an image that is not STABLE, no digest', async () => {
    const base = claims();
    await refused(await token({ ...base, swname: 'GCE' }), /Confidential Space/);
    await refused(await token({ ...base, dbgstat: 'enabled' }), /debug image/);
    await refused(await token({ ...base, secboot: false }), /boot securely/);
    await refused(
      await token({
        ...base,
        submods: {
          confidential_space: { support_attributes: ['EXPERIMENTAL'] },
          container: { image_digest: DIGEST },
        },
      }),
      /not a stable one/,
    );
    await refused(
      await token({ ...base, submods: { confidential_space: { support_attributes: ['STABLE'] } } }),
      /no image digest/,
    );
  });

  it('requires a confidential VM: AMD SEV, SEV-ES or Intel TDX, not a Shielded VM', async () => {
    expect(CONFIDENTIAL_HARDWARE_MODELS).toEqual([
      'GCP_AMD_SEV',
      'GCP_AMD_SEV_ES',
      'GCP_INTEL_TDX',
    ]);
    for (const hwmodel of CONFIDENTIAL_HARDWARE_MODELS) {
      expect((await verify(await token({ ...claims(), hwmodel }))).measurement).toBe(DIGEST);
    }
    for (const hwmodel of ['GCP_SHIELDED_VM', 'GCP_AMD_SEV_SNP', '', undefined]) {
      await refused(await token({ ...claims(), hwmodel }), /not run on a confidential VM/);
    }
  });

  it('refuses a token not bound to this account’s key, and takes no other nonce', async () => {
    const bound = /not bound to this account’s key/;
    expect((await verify(await token({ ...claims(), eat_nonce: SPKI }))).measurement).toBe(DIGEST);
    await refused(await token({ ...claims(), eat_nonce: ['T'.repeat(43)] }), bound);
    await refused(await token({ ...claims(), eat_nonce: ['n'.repeat(43), SPKI] }), bound);
    await refused(await token({ ...claims(), eat_nonce: [] }), bound);
  });

  it('discovers again when the key is not where the cached discovery said', async () => {
    const adapter = platform();
    await verify(await token(claims()), adapter);
    // Google moved its keys: a token signed by the new key, unknown to the cached JWKS.
    jwksUri = MOVED_JWKS_URL;
    fetched = [];
    const moved = await token(claims(), { key: movedKey, kid: 'k2' });
    expect((await verify(moved, adapter)).measurement).toBe(DIGEST);
    expect(fetched).toContain(GCP_DISCOVERY_URL);
    expect(fetched).toContain(MOVED_JWKS_URL);
  });

  it('discovers again when the key fetch fails, and says so when it fails again', async () => {
    let failing = true;
    const flaky: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (failing && url === JWKS_URL) {
        failing = false;
        throw new TypeError('fetch failed');
      }
      return googleFetch(input, init);
    };
    const adapter = gcpConfidentialSpace({ fetch: flaky });
    expect((await verify(await token(claims()), adapter)).measurement).toBe(DIGEST);
    expect(fetched.filter((u) => u === GCP_DISCOVERY_URL)).toHaveLength(2);

    const down = gcpConfidentialSpace({
      fetch: async () => new Response('unavailable', { status: 503 }),
    });
    const err = await verify(await token(claims()), down).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/attestation keys could not be fetched/);
  });

  it('is admitted only with a measurement on the allowlist', async () => {
    const answer = { platform: GCP_CONFIDENTIAL_SPACE, evidence: await token(claims()) };
    const platforms = [platform()];
    const expected = { spkiHash: SPKI, now: NOW };
    const admitting = new AttestationVerifier({
      platforms,
      allowlist: [
        { platform: GCP_CONFIDENTIAL_SPACE, measurement: DIGEST, broker_version: '1.0.0' },
      ],
    });
    expect(await admitting.verify(answer, expected)).toMatchObject({ brokerVersion: '1.0.0' });
    const other = new AttestationVerifier({
      platforms,
      allowlist: [
        {
          platform: GCP_CONFIDENTIAL_SPACE,
          measurement: `sha256:${'b'.repeat(64)}`,
          broker_version: '0.9.0',
        },
      ],
    });
    await expect(other.verify(answer, expected)).rejects.toThrow(/does not admit/);
    await expect(other.verify({ platform: 'aws-nitro', evidence: 'x' }, expected)).rejects.toThrow(
      /not one this release verifies/,
    );
  });
});
