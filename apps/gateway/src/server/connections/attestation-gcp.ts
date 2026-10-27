/**
 * The Google Confidential Space adapter of the broker attestation (ADR
 * oauth-broker-stateless-in-an-attested-enclave D7). The evidence is the
 * attestation token the Confidential Space launcher obtains from Google Cloud
 * Attestation with a custom audience and nonces: an OIDC JWT signed by Google.
 *
 * Checked, after Google's "Confidential Space attestation token claims":
 *
 *   signature  RS256, a key of the JWKS that Google's discovery document
 *              (`<issuer>/.well-known/openid-configuration`) names, cached
 *   iss        https://confidentialcomputing.googleapis.com
 *   aud        BROKER_ATTESTATION_AUDIENCE
 *   exp, iat   not expired, issued within the last ten minutes (the token is
 *              minted for the gateway's nonce, so it is fresh)
 *   swname     CONFIDENTIAL_SPACE (not a plain Compute Engine VM)
 *   dbgstat    disabled-since-boot (the production image, not the debug one)
 *   secboot    true
 *   submods.confidential_space.support_attributes  contains STABLE
 *   submods.container.image_digest                  the measurement, `sha256:<hex>`
 *   eat_nonce  exactly [the gateway's nonce, the SPKI hash of the connection's key]
 */
import { createRemoteJWKSet, customFetch, errors, jwtVerify, type JWTVerifyGetKey } from 'jose';

import {
  AttestationRefused,
  BROKER_ATTESTATION_AUDIENCE,
  type AttestationExpectation,
  type AttestationPlatform,
  type AttestedClaims,
} from './broker-attestation';

export const GCP_CONFIDENTIAL_SPACE = 'gcp-confidential-space';
export const GCP_ATTESTATION_ISSUER = 'https://confidentialcomputing.googleapis.com';
export const GCP_DISCOVERY_URL = `${GCP_ATTESTATION_ISSUER}/.well-known/openid-configuration`;

/** The token is minted for the gateway's nonce: anything older is not an answer to it. */
const MAX_TOKEN_AGE_SECONDS = 600;
const CLOCK_TOLERANCE_SECONDS = 60;
const DISCOVERY_TIMEOUT_MS = 5_000;
/** Google rotates its signing keys; a key it publishes is kept this long. */
const JWKS_CACHE_MS = 60 * 60_000;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;

export interface GcpConfidentialSpaceDeps {
  readonly fetch: typeof fetch;
  /** The signing keys; by default Google's JWKS, found through the discovery document. */
  readonly keys?: JWTVerifyGetKey;
}

export function gcpConfidentialSpace(deps: GcpConfidentialSpaceDeps): AttestationPlatform {
  let keys: Promise<JWTVerifyGetKey> | null = deps.keys ? Promise.resolve(deps.keys) : null;
  const signingKeys = (): Promise<JWTVerifyGetKey> => {
    keys ??= discoverKeys(deps.fetch).catch((err: unknown) => {
      // Not cached: the next attestation discovers again.
      keys = null;
      throw err;
    });
    return keys;
  };
  return {
    platform: GCP_CONFIDENTIAL_SPACE,
    async verify(evidence: unknown, expected: AttestationExpectation): Promise<AttestedClaims> {
      if (typeof evidence !== 'string' || evidence.length === 0) {
        throw new AttestationRefused('the evidence is not an attestation token');
      }
      let getKey: JWTVerifyGetKey;
      try {
        getKey = await signingKeys();
      } catch {
        throw new AttestationRefused("Google's attestation keys could not be fetched");
      }
      let payload: Record<string, unknown>;
      try {
        ({ payload } = await jwtVerify(evidence, getKey, {
          issuer: GCP_ATTESTATION_ISSUER,
          audience: BROKER_ATTESTATION_AUDIENCE,
          algorithms: ['RS256'],
          currentDate: expected.now,
          clockTolerance: CLOCK_TOLERANCE_SECONDS,
          maxTokenAge: MAX_TOKEN_AGE_SECONDS,
          requiredClaims: ['exp', 'iat', 'eat_nonce'],
        }));
      } catch (err) {
        throw new AttestationRefused(`the attestation token is not valid (${joseReason(err)})`);
      }
      return checkClaims(payload, expected);
    },
  };
}

/** The claims of a token whose signature, issuer, audience and times checked out. */
export function checkClaims(
  payload: Record<string, unknown>,
  expected: AttestationExpectation,
): AttestedClaims {
  if (payload.swname !== 'CONFIDENTIAL_SPACE') {
    throw new AttestationRefused('the broker does not run in Confidential Space');
  }
  if (payload.dbgstat !== 'disabled-since-boot') {
    throw new AttestationRefused('the broker runs a debug image');
  }
  if (payload.secboot !== true) throw new AttestationRefused('the broker did not boot securely');
  const submods = record(payload.submods);
  const space = record(submods?.confidential_space);
  const support = space?.support_attributes;
  if (!Array.isArray(support) || !support.includes('STABLE')) {
    throw new AttestationRefused('the Confidential Space image is not a stable one');
  }
  const digest = record(submods?.container)?.image_digest;
  if (typeof digest !== 'string' || !IMAGE_DIGEST.test(digest)) {
    throw new AttestationRefused('the attestation names no image digest');
  }
  const nonces = payload.eat_nonce;
  if (
    !Array.isArray(nonces) ||
    nonces.length !== 2 ||
    nonces[0] !== expected.nonce ||
    nonces[1] !== expected.spkiHash
  ) {
    throw new AttestationRefused(
      'the attestation is not bound to this request and this connection’s key',
    );
  }
  const exp = payload.exp;
  if (typeof exp !== 'number') throw new AttestationRefused('the attestation has no expiry');
  return { measurement: digest, expiresAt: exp * 1000 };
}

/** Google's JWKS, through the discovery document of the issuer. */
async function discoverKeys(fetchImpl: typeof fetch): Promise<JWTVerifyGetKey> {
  const response = await fetchImpl(GCP_DISCOVERY_URL, {
    headers: { Accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`discovery answered ${response.status}`);
  const document = record(await response.json());
  if (document?.issuer !== GCP_ATTESTATION_ISSUER) throw new Error('discovery: another issuer');
  const jwksUri = document.jwks_uri;
  const url = typeof jwksUri === 'string' ? URL.parse(jwksUri) : null;
  if (!url || url.protocol !== 'https:') throw new Error('discovery: no https jwks_uri');
  return createRemoteJWKSet(url, {
    cacheMaxAge: JWKS_CACHE_MS,
    timeoutDuration: DISCOVERY_TIMEOUT_MS,
    [customFetch]: (input, init) => fetchImpl(input, init),
  });
}

/** jose's error code, never the token's content. */
function joseReason(err: unknown): string {
  return err instanceof errors.JOSEError ? err.code : 'unreadable';
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
