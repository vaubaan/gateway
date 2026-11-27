/**
 * Vaubaan's installed-app OAuth clients (ADR local-instance-carries-installed-oauth-clients):
 * one per provider, carried by a local instance only, for signing in and, later, for the
 * services of the same provider. They are registered by Vaubaan under the brand vaubaan.com:
 * Google "Desktop app" (project `vaubaan-desktop`), a Microsoft Entra public client (any
 * organisation and personal accounts), a GitHub OAuth App. Each comes back on the loopback,
 * `http://127.0.0.1:<port>/oauth/loopback`, at any port.
 *
 * A client id is public and lives here. A client secret (Google, GitHub) is not confidential
 * for an installed application, but it is kept out of the repository: `next.config.ts`
 * freezes `VAUBAAN_DESKTOP_GOOGLE_CLIENT_SECRET` and `VAUBAAN_DESKTOP_GITHUB_CLIENT_SECRET`
 * into the bundle at build time, from the CI secrets of the same names. A build without
 * one (a developer's, a fork's) offers neither that sign-in nor, later, that service.
 * Microsoft's public client has no secret.
 *
 * Read here because the configuration module is the only place that touches the process
 * environment (`build-info.ts`).
 */

export const INSTALLED_PROVIDERS = ['google', 'microsoft', 'github'] as const;
export type InstalledProvider = (typeof INSTALLED_PROVIDERS)[number];

export interface InstalledClient {
  readonly provider: InstalledProvider;
  readonly clientId: string;
  /** `null` for Microsoft's public client. */
  readonly clientSecret: string | null;
}

/** The client ids, as the providers' consoles show them. Empty: not registered yet. */
export const INSTALLED_CLIENT_IDS: Readonly<Record<InstalledProvider, string>> = {
  google: '313988115495-oeasilui1ot4sm8adlqg7gok0r0smvl4.apps.googleusercontent.com',
  microsoft: '0f3f084a-4622-4f80-a6e4-03a06d8c0f3d',
  github: 'Ov23li8fNgD9Di97tHKW',
};

/** Whether the provider's token endpoint asks the client secret (Microsoft's public client does not). */
const NEEDS_SECRET: Readonly<Record<InstalledProvider, boolean>> = {
  google: true,
  microsoft: false,
  github: true,
};

/** The secrets frozen into this build (`next.config.ts`); empty when the build had none. */
function builtSecrets(): Readonly<Record<InstalledProvider, string>> {
  return {
    // Each read is written out whole: Next replaces these exact expressions at build time.
    google: process.env.VAUBAAN_DESKTOP_GOOGLE_CLIENT_SECRET ?? '',
    microsoft: '',
    github: process.env.VAUBAAN_DESKTOP_GITHUB_CLIENT_SECRET ?? '',
  };
}

/**
 * The installed clients this build can use: a client with an id, and its secret when the
 * provider asks one. Ids and secrets may be given for tests.
 */
export function installedClients(
  ids: Readonly<Record<InstalledProvider, string>> = INSTALLED_CLIENT_IDS,
  secrets: Readonly<Record<InstalledProvider, string>> = builtSecrets(),
): InstalledClient[] {
  const out: InstalledClient[] = [];
  for (const provider of INSTALLED_PROVIDERS) {
    const clientId = ids[provider].trim();
    const secret = secrets[provider].trim();
    if (clientId === '') continue;
    if (NEEDS_SECRET[provider] && secret === '') continue;
    out.push({ provider, clientId, clientSecret: NEEDS_SECRET[provider] ? secret : null });
  }
  return out;
}
