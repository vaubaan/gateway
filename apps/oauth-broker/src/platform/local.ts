/**
 * The development adapter: no enclave. Its evidence says so (`platform:
 * "none"`), and a gateway accepts it only for a broker its administrator
 * declared `attestation: none`. Secrets come from the configuration
 * (`platform.local.secrets`), which is acceptable only because nothing here
 * pretends to be protected.
 */
import {
  ATTESTATION_AUDIENCE,
  type Attestation,
  type PlatformAdapter,
  PlatformError,
} from './types.ts';

function segment(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export function createLocalAdapter(settings: unknown): PlatformAdapter {
  const secrets =
    typeof settings === 'object' && settings !== null
      ? (settings as Record<string, unknown>).secrets
      : undefined;
  return {
    name: 'none',
    async attest(nonces): Promise<Attestation> {
      // An unsigned token of the same shape as an enclave's, so a gateway
      // parses both alike; `alg: none` says there is nothing to verify.
      const evidence = `${segment({ alg: 'none', typ: 'JWT' })}.${segment({
        aud: ATTESTATION_AUDIENCE,
        eat_nonce: [...nonces],
        iat: Math.floor(Date.now() / 1000),
      })}.`;
      return { platform: 'none', evidence };
    },
    async unsealSecret(name): Promise<string> {
      const value =
        typeof secrets === 'object' && secrets !== null
          ? (secrets as Record<string, unknown>)[name]
          : undefined;
      if (typeof value !== 'string' || value === '') {
        throw new PlatformError(`platform.local.secrets has no "${name}"`);
      }
      return value;
    },
  };
}
