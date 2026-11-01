/**
 * An ephemeral instance for the mission tests: the real composition root on
 * the `:memory:` store, with the plugins the image ships (their catalogs and
 * macro-actions are what issuance is about) and connections seeded straight through
 * the repositories. Shared by the vitest integration suite and the Playwright
 * launcher.
 */
import { SESSION_COOKIE } from '../../../src/server/auth';
import { buildRoot, type GatewayRoot, type RootDeps } from '../../../src/server/compose/root';
import { memoryStoreDeps } from '../../support/compose/testing';
import { loadInstanceConfig } from '../../../src/server/config';
import { validEnv } from '../../support/config/testing';
import { seedConnection, type SeededConnection } from '../../support/missions/testing';
import type { UserRecord } from '../../../src/server/store/types';

export const PUBLIC_URL = 'https://gateway.example.com';

export interface TestInstanceOptions {
  readonly publicUrl?: string;
  readonly deps?: RootDeps;
  readonly env?: Record<string, string | undefined>;
}

/** The `RootDeps` of a test instance: fake configuration, `:memory:` store, shipped plugins. */
export function testRootDeps(options: TestInstanceOptions = {}): RootDeps {
  return {
    loadConfig: () =>
      loadInstanceConfig({
        env: validEnv({ VAUBAAN_PUBLIC_URL: options.publicUrl ?? PUBLIC_URL, ...options.env }),
      }),
    logWrite: () => undefined,
    ...memoryStoreDeps,
    ...options.deps,
  };
}

export async function buildTestRoot(options: TestInstanceOptions = {}): Promise<GatewayRoot> {
  return buildRoot(testRootDeps(options));
}

export interface SeededInstance {
  readonly ada: UserRecord;
  readonly bob: UserRecord;
  readonly github: SeededConnection;
  readonly supabase: SeededConnection;
  readonly vercel: SeededConnection;
  readonly gmail: SeededConnection;
}

export const ADA = {
  issuer: 'http://idp.test',
  subject: 'idp|ada',
  email: 'ada@example.com',
  displayName: 'Ada',
} as const;
export const BOB = {
  issuer: 'http://idp.test',
  subject: 'idp|bob',
  email: 'bob@example.com',
  displayName: 'Bob',
} as const;

/**
 * Ada owns four connections: GitHub (three repositories), Supabase (a
 * staging and a prod project), Vercel (two projects, no label: the plugin
 * derives the env from the call) and Gmail (no resource). Bob owns nothing.
 *
 * `issuer` is the `iss` of the identity provider the seeded people will sign in
 * through, when it is not the default test IdP: a user is `(issuer, subject)`,
 * and Ada signing in from another issuer would be somebody else.
 */
export async function seedInstance(
  root: GatewayRoot,
  issuer: string = ADA.issuer,
): Promise<SeededInstance> {
  const { store } = root;
  const ada = await store.users.upsertFromIdp({ ...ADA, issuer });
  const bob = await store.users.upsertFromIdp({ ...BOB, issuer });
  const owner = { kind: 'user', id: ada.id } as const;
  const github = await seedConnection(store, {
    provider: 'github',
    owner,
    displayName: 'acme-org',
    resources: [
      { ref: 'acme/app', displayName: 'acme/app' },
      { ref: 'acme/web', displayName: 'acme/web' },
      { ref: 'acme/infra', displayName: 'acme/infra' },
    ],
  });
  const supabase = await seedConnection(store, {
    provider: 'supabase',
    owner,
    displayName: 'Acme Supabase',
    resources: [
      { ref: 'stgprojectref', displayName: 'app-staging', env: 'staging' },
      { ref: 'prdprojectref', displayName: 'app-prod', env: 'prod' },
    ],
  });
  const vercel = await seedConnection(store, {
    provider: 'vercel',
    owner,
    displayName: 'Acme Vercel',
    resources: [
      { ref: 'prj_app', displayName: 'app' },
      { ref: 'prj_web', displayName: 'web' },
    ],
  });
  const gmail = await seedConnection(store, {
    provider: 'gmail',
    owner,
    displayName: 'ops mailbox',
    resources: [],
  });
  return { ada, bob, github, supabase, vercel, gmail };
}

/** Headers of a same-origin browser request carrying the user's session. */
export async function sessionHeaders(
  root: GatewayRoot,
  user: UserRecord,
  extra: Record<string, string> = {},
): Promise<Headers> {
  const session = await root.auth.sessions.create({
    kind: 'user',
    userId: user.id,
    login: { email: user.email, groups: [] },
  });
  return new Headers({
    cookie: `${SESSION_COOKIE}=${session.id}`,
    origin: root.config.publicUrl.origin,
    'content-type': 'application/json',
    ...extra,
  });
}
