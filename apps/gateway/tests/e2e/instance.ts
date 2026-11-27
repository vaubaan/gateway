/**
 * Coordinates of the ephemeral instance, shared by its launcher, the
 * Playwright configuration and the specs. Fake hosts under the reserved
 * `.test` TLD: nothing here resolves on a network.
 */

/** The instance's `public_url`: what the browser believes it is talking to. */
export const PUBLIC_URL = 'https://gateway.e2e.test';
/** The simulated identity provider (the in-process `FakeIdp`). */
export const IDP_ISSUER = 'https://idp.e2e.test';
/**
 * The simulated GitHub of the sign-in spec (the in-process `FakeGithub`, laid out
 * as a GitHub Enterprise Server). It is a sign-in provider only while that spec
 * adds it.
 */
export const GITHUB_SIGN_IN_BASE = 'https://github.e2e.test';
export const GITHUB_SIGN_IN_CLIENT = {
  clientId: 'Ov23liE2eSignIn',
  clientSecret: 'e2e-github-sign-in-secret',
} as const;
/**
 * Test-only control endpoints of the launcher. They are served by the launcher's
 * own listener, on the port after the app's (`controlUrl`): the app's port
 * belongs to the standalone server the image ships, which the launcher starts
 * unmodified.
 */
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

const MAX_PORT = 65_535;

/** Local port of the launcher's control endpoints: the one after the app's. */
export function controlPort(): number {
  const port = instancePort() + 1;
  if (port > MAX_PORT) {
    throw new Error(`E2E_V5_PORT must leave the next port free for the control endpoints`);
  }
  return port;
}

/** The URL of a control endpoint, `path` starting with `/` (`/seed-day`, `/upstream`…). */
export function controlUrl(path: string): string {
  return `http://127.0.0.1:${controlPort()}${CONTROL_PREFIX}${path}`;
}

/**
 * The users of the simulated IdP. The IdP is shared by every spec, so each spec
 * names the user it needs in its own `beforeEach` (`signInAs`) and none relies
 * on what another one left behind.
 *
 * Ada owns the seeded accounts (GitHub, Supabase, Vercel, Gmail).
 */
/** The one project the mocked Vercel token is scoped to (`token-accounts.spec`). */
export const MOCK_VERCEL_PROJECT = 'prj_e2esite';

export const E2E_USER = { sub: 'idp|ada', email: 'ada@example.com', name: 'Ada' } as const;
/** A second user of the same IdP, who created nothing. */
export const E2E_OTHER_USER = { sub: 'idp|bob', email: 'bob@example.com', name: 'Bob' } as const;
/** Who the audit spec signs in as: their requests stay out of the other specs' inbox. */
export const E2E_AUDIT_USER = {
  sub: 'idp|grace',
  email: 'grace@example.com',
  name: 'Grace',
} as const;
/** Who "approve an action" signs in as: their requests stay out of the other specs' inbox. */
export const E2E_APPROVER_USER = {
  sub: 'idp|hedy',
  email: 'hedy@example.com',
  name: 'Hedy',
} as const;
/** Who the cutover smoke signs in as: they start with no account and no mission. */
export const E2E_CUTOVER_USER = {
  sub: 'idp|margaret',
  email: 'margaret@example.com',
  name: 'Margaret',
} as const;

/** Who the first-call path spec signs in as: nobody else uses her, she starts with nothing. */
export const E2E_FIRST_CALL_USER = {
  sub: 'idp|radia',
  email: 'radia@example.com',
  name: 'Radia',
} as const;

/**
 * The share spec's cast: Ines owns a GitHub account of her own, Joan receives a share
 * of it, and the operator (the instance's admin rule names their email) keeps the local
 * groups. None of them appears in another spec.
 */
export const E2E_SHARE_OWNER = {
  sub: 'idp|ines',
  email: 'ines@example.com',
  name: 'Ines',
} as const;
export const E2E_SHARE_TARGET = {
  sub: 'idp|joan',
  email: 'joan@example.com',
  name: 'Joan',
} as const;
export const E2E_OPERATOR = { sub: 'idp|ops', email: 'ops@example.com', name: 'Ops' } as const;
/** Who the auto-refresh spec signs in as: her one GitHub account was last refreshed long ago. */
export const E2E_REFRESH_USER = {
  sub: 'idp|katherine',
  email: 'katherine@example.com',
  name: 'Katherine',
} as const;

/**
 * The auto-refresh spec's token: the mocked GitHub lists one repository more for it
 * than its account knows, so opening the account shows the new one appear.
 */
export const MOCK_GITHUB_REFRESH = {
  token: `github_pat_11E2E00000000000000_${'c'.repeat(40)}`,
  account: 'katherine-org',
  known: 'acme-refresh/app',
  appearing: 'acme-refresh/new-service',
} as const;

/**
 * The mocked GitHub behind the instance (`RootDeps.serviceFetch`): one
 * fine-grained token, reaching two repositories. Nothing here is a real
 * account; the launcher answers every service request itself.
 */
export const MOCK_GITHUB = {
  /** Of the shape the plugin's field accepts; opens nothing anywhere. */
  token: `github_pat_11E2E00000000000000_${'a'.repeat(40)}`,
  account: 'ada-org',
  repositories: ['acme/app', 'acme/docs'],
  branches: [{ name: 'main' }, { name: 'feature/billing' }],
} as const;

/**
 * The git remote spec: a second token whose one repository is a real bare
 * repository served by `git http-backend` (`FakeGithubHost`), so that real
 * `git clone` / `git push` go through the instance to it. Nothing reaches
 * github.com.
 */
export const E2E_GIT = {
  token: `github_pat_11E2E00000000000000_${'b'.repeat(40)}`,
  repository: 'acme-git/app',
} as const;
