/**
 * No enclave, in production: the broker behind a platform that ends TLS
 * (ADR oauth-broker-can-run-without-an-enclave). There is nothing to attest, so
 * the broker opens one plain HTTP listener and `POST /attest` answers 404;
 * a gateway reaches it only when its administrator declared the broker
 * `attestation: none`, and then says so to its users.
 *
 * Secrets come from the environment, one variable each:
 * `OAUTH_BROKER_SECRET_` and the secret's name in upper snake case
 * (`google-client-secret` → `OAUTH_BROKER_SECRET_GOOGLE_CLIENT_SECRET`).
 * Each is removed from `process.env` once read (the process's initial
 * environment and the platform's store still hold it). Whoever operates the
 * platform can read them, and can run other code in this image's place: that
 * is the trust this mode asks for.
 */
import { type PlatformAdapter, PlatformError } from './types.ts';

export const PLATFORM = 'unattested';
const PREFIX = 'OAUTH_BROKER_SECRET_';

/** The environment variable that holds the secret of that name. */
export function secretVariable(name: string): string {
  return PREFIX + name.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

export function createUnattestedAdapter(
  env: Record<string, string | undefined> = process.env,
): PlatformAdapter {
  return {
    name: PLATFORM,
    attested: false,
    async attest(): Promise<never> {
      throw new PlatformError('this broker runs without an enclave and has nothing to attest');
    },
    async unsealSecret(name): Promise<string> {
      const variable = secretVariable(name);
      const value = env[variable];
      if (value === undefined || value === '') {
        throw new PlatformError(`${variable} is not set`);
      }
      delete env[variable];
      return value;
    },
  };
}
