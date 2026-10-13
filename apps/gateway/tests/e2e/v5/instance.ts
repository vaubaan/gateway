/**
 * Coordinates of the ephemeral instance, shared by its launcher, the
 * Playwright configuration and the specs. Fake hosts under the reserved
 * `.test` TLD: nothing here resolves on a network.
 */

/** The instance's `public_url`: what the browser believes it is talking to. */
export const PUBLIC_URL = 'https://gateway.e2e.test';
/** The simulated identity provider (P1.1's `FakeIdp`). */
export const IDP_ISSUER = 'https://idp.e2e.test';
/** Test-only control endpoints of the launcher, served next to the app. */
export const CONTROL_PREFIX = '/__e2e';

const DEFAULT_PORT = 3105;

/** Local port of the launcher; override with `E2E_V5_PORT` when it is taken. */
export function instancePort(): number {
  const raw = process.env.E2E_V5_PORT;
  if (!raw) return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`E2E_V5_PORT must be a TCP port, got '${raw}'`);
  }
  return port;
}

export function localOrigin(): string {
  return `http://127.0.0.1:${instancePort()}`;
}

/** Who signs in through the simulated IdP. */
export const E2E_USER = { sub: 'idp|ada', email: 'ada@example.com', name: 'Ada' } as const;
