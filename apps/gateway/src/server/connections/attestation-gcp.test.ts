/**
 * The Google Confidential Space adapter (ADR
 * oauth-broker-stateless-in-an-attested-enclave D7), on tokens signed here
 * with a key of the test's own, shaped as Google's "Confidential Space
 * attestation token claims" say: issuer, audience, times, `swname`,
 * `dbgstat`, `secboot`, the support attributes, the image digest, and the
 * two nonces in their order. The keys are found through the issuer's
 * discovery document, as in production.
 */
import { generateKeyPairSync, type KeyObject } from 'node:crypto';

import { exportJWK, SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  GCP_ATTESTATION_ISSUER,
  GCP_CONFIDENTIAL_SPACE,
  GCP_DISCOVERY_URL,
  gcpConfidentialSpace,
} from './attestation-gcp';
import {
  AttestationRefused,
  AttestationVerifier,
  BROKER_ATTESTATION_AUDIENCE,
  newAttestationNonce,
} from './broker-attestation';

const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/metadata/jwk/signer@test';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const NOW = new Date('2026-10-27T09:00:00.000Z');
const SPKI = 'S'.repeat(43);

let signingKey: KeyObject;
let jwks: { keys: unknown[] };
let fetched: string[] = [];

beforeAll(async () => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  signingKey = pair.privateKey;
  jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }] };
});

/** Google's discovery document and JWKS, nothing else. */
const googleFetch: typeof fetch = async (input) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  fetched.push(url);
  if (url === GCP_DISCOVERY_URL) {
    return Response.json({ issuer: GCP_ATTESTATION_ISSUER, jwks_uri: JWKS_URL });
  }
  if (url === JWKS_URL) return Response.json(jwks);
  return new Response('not found', { status: 404 });
};

function claims(nonce: string): Record<string, unknown> {
  return {
    swname: 'CONFIDENTIAL_SPACE',
    dbgstat: 'disabled-since-boot',
    secboot: true,
    hwmodel: 'GCP_AMD_SEV',
    eat_nonce: [nonce, SPKI],
    submods: {
      confidential_space: { support_attributes: ['LATEST', 'STABLE', 'USABLE'] },
      container: { image_digest: DIGEST },
    },
  };
}

async function token(
  payload: Record<string, unknown>,
  options: { issuer?: string; audience?: string; iat?: Date; key?: KeyObject } = {},
): Promise<string> {
  const iat = Math.floor((options.iat ?? NOW).getTime() / 1000);
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(options.issuer ?? GCP_ATTESTATION_ISSUER)
    .setAudience(options.audience ?? BROKER_ATTESTATION_AUDIENCE)
    .setIssuedAt(iat)
    .setExpirationTime(iat + 3600)
    .sign(options.key ?? signingKey);
}

async function verify(evidence: unknown, nonce: string) {
  fetched = [];
  return gcpConfidentialSpace({ fetch: googleFetch }).verify(evidence, {
    nonce,
    spkiHash: SPKI,
    now: NOW,
  });
}

async function refused(evidence: unknown, nonce: string, reason: RegExp): Promise<void> {
  const err = await verify(evidence, nonce).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AttestationRefused);
  expect((err as Error).message).toMatch(reason);
}

describe('the Google Confidential Space adapter', () => {
  it('admits a token of Google’s keys, for this audience, nonce and key: the measurement is the image digest', async () => {
    const nonce = newAttestationNonce();
    const admitted = await verify(await token(claims(nonce)), nonce);
    expect(admitted).toEqual({ measurement: DIGEST, expiresAt: NOW.getTime() + 3600_000 });
    expect(fetched).toEqual([GCP_DISCOVERY_URL, JWKS_URL]);
  });

  it('refuses another signer, issuer or audience, and a stale token', async () => {
    const nonce = newAttestationNonce();
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    await refused(await token(claims(nonce), { key: other }), nonce, /not valid/);
    await refused(
      await token(claims(nonce), { issuer: 'https://example.com' }),
      nonce,
      /not valid \(ERR_JWT_CLAIM_VALIDATION_FAILED\)/,
    );
    await refused(
      await token(claims(nonce), { audience: 'https://sts.googleapis.com' }),
      nonce,
      /not valid/,
    );
    await refused(
      await token(claims(nonce), { iat: new Date(NOW.getTime() - 20 * 60_000) }),
      nonce,
      /not valid/,
    );
    await refused('not-a-jwt', nonce, /not valid/);
    await refused(42, nonce, /not an attestation token/);
  });

  it('refuses a plain VM, a debug image, an image that is not STABLE, no digest', async () => {
    const nonce = newAttestationNonce();
    const base = claims(nonce);
    await refused(await token({ ...base, swname: 'GCE' }), nonce, /Confidential Space/);
    await refused(await token({ ...base, dbgstat: 'enabled' }), nonce, /debug image/);
    await refused(await token({ ...base, secboot: false }), nonce, /boot securely/);
    await refused(
      await token({
        ...base,
        submods: {
          confidential_space: { support_attributes: ['EXPERIMENTAL'] },
          container: { image_digest: DIGEST },
        },
      }),
      nonce,
      /not a stable one/,
    );
    await refused(
      await token({ ...base, submods: { confidential_space: { support_attributes: ['STABLE'] } } }),
      nonce,
      /no image digest/,
    );
  });

  it('refuses a token not bound to this nonce and this key, in this order', async () => {
    const nonce = newAttestationNonce();
    const base = claims(nonce);
    const bound = /not bound to this request/;
    await refused(await token({ ...base, eat_nonce: nonce }), nonce, bound);
    await refused(await token({ ...base, eat_nonce: [SPKI, nonce] }), nonce, bound);
    await refused(await token({ ...base, eat_nonce: [nonce, 'T'.repeat(43)] }), nonce, bound);
    await refused(await token({ ...base, eat_nonce: [nonce, SPKI, 'x'.repeat(43)] }), nonce, bound);
    await refused(await token(base), newAttestationNonce(), bound);
  });

  it('is admitted only with a measurement on the allowlist', async () => {
    const nonce = newAttestationNonce();
    const answer = { platform: GCP_CONFIDENTIAL_SPACE, evidence: await token(claims(nonce)) };
    const platforms = [gcpConfidentialSpace({ fetch: googleFetch })];
    const expected = { nonce, spkiHash: SPKI, now: NOW };
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
