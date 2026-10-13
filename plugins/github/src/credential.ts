/**
 * Credential of the `github` provider : a GitHub App the company registers,
 * installed on its organisation (`app-install` kind).
 *
 * Spec : docs/spec/vaubaan-gateway.md §0 "Connection", §7.2 ; ADR
 *        plugin-contract-and-credential-spec D2.
 *
 * The operator configures the App once (app id, private key, slug, OAuth
 * client id and secret) ; the host redirects the connecting user to the
 * installation page and receives `installation_id` on the callback. The App
 * is registered with "Request user authorization (OAuth) during
 * installation", so the callback also carries a `code` : the host exchanges
 * it for a user access token, checks that `installation_id` is among
 * `GET /user/installations` for that token, and drops the token
 * (`userVerification` below — declarative, this plugin runs none of it and
 * never receives the client secret). Only then is the installation id stored
 * as the connection's secret. At call time the plugin mints a short-lived
 * installation token from the App's private key (`app-install.ts`), scoped
 * to the repositories and permissions the call needs.
 *
 * No PAT path : the v4 adapter accepted a personal access token for E2E runs
 * before an App existed ; the v5 contract carries one `CredentialSpec` per
 * plugin and the on-prem instance always registers its own App (ADR D3).
 */

import {
  CLIENT_ID_FIELD,
  CLIENT_SECRET_FIELD,
  expectCredentialKind,
  type AppInstallCredentialSpec,
  type ConnectionContext,
  type ProviderAppConfig,
} from '@vaubaan/plugin-sdk';

import {
  GITHUB_API_BASE,
  GITHUB_API_HEADERS,
  mintInstallationToken,
  type AppCredentials,
  type ScopedInstallationToken,
} from './app-install.ts';

/** Keys of `ctx.appConfig` for this provider — one source for the spec and the readers. */
export const GITHUB_APP_CONFIG = {
  appId: 'app_id',
  privateKey: 'private_key',
  appSlug: 'app_slug',
  /** Used by the host only, to verify installations ; `clientSecret` never reaches this plugin. */
  clientId: CLIENT_ID_FIELD,
  clientSecret: CLIENT_SECRET_FIELD,
} as const;

/** GitHub's web origin : the installation page and the OAuth token endpoint. */
export const GITHUB_WEB_BASE = 'https://github.com';
/** `GET /user/installations` accepts at most 100 items per page. */
const INSTALLATIONS_PER_PAGE = 100;

export const githubCredential: AppInstallCredentialSpec = {
  kind: 'app-install',
  appConfigFields: [
    {
      name: GITHUB_APP_CONFIG.appId,
      label: 'GitHub App ID',
      secret: false,
      pattern: '^[0-9]+$',
      help: 'Numeric App ID shown on the App settings page (Settings → Developer settings → GitHub Apps).',
    },
    {
      name: GITHUB_APP_CONFIG.privateKey,
      label: 'GitHub App private key (PEM)',
      secret: true,
      help: 'Generate a private key on the App settings page and paste the PEM (PKCS#1 or PKCS#8).',
    },
    {
      name: GITHUB_APP_CONFIG.appSlug,
      label: 'GitHub App slug',
      secret: false,
      pattern: '^[a-zA-Z0-9][a-zA-Z0-9._-]*$',
      help: 'The URL slug of the App (https://github.com/apps/<slug>) ; used to build the installation link.',
    },
    {
      name: GITHUB_APP_CONFIG.clientId,
      label: 'GitHub App client ID',
      secret: false,
      pattern: '^[A-Za-z0-9._-]+$',
      help: 'Client ID shown on the App settings page (not the App ID). The App must have "Request user authorization (OAuth) during installation" enabled.',
    },
    {
      name: GITHUB_APP_CONFIG.clientSecret,
      label: 'GitHub App client secret',
      secret: true,
      help: 'Generate a client secret on the App settings page. Used only to check that the person who installs the App has access to the installation.',
    },
  ],
  installUrl(appConfig: ProviderAppConfig): string {
    const slug = requireAppConfig(appConfig, GITHUB_APP_CONFIG.appSlug);
    return `${GITHUB_WEB_BASE}/apps/${encodeURIComponent(slug)}/installations/new`;
  },
  installationIdParam: 'installation_id',
  userVerification: {
    codeParam: 'code',
    tokenUrl: `${GITHUB_WEB_BASE}/login/oauth/access_token`,
    clientAuthMethod: 'client_secret_post',
    installationsUrl: `${GITHUB_API_BASE}/user/installations`,
    installationsHeaders: GITHUB_API_HEADERS,
    installationsListField: 'installations',
    installationIdField: 'id',
    pagination: { pageParam: 'page', perPageParam: 'per_page', perPage: INSTALLATIONS_PER_PAGE },
  },
};

/** Read one app-config key or fail naming it (never a silent default). */
export function requireAppConfig(appConfig: ProviderAppConfig, key: string): string {
  const value = appConfig[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`github: app configuration key '${key}' is missing`);
  }
  return value;
}

/** The App credentials of the context, PEM `\n` escapes un-escaped (operators often paste a one-line key). */
export function appCredentialsOf(ctx: ConnectionContext): AppCredentials {
  return {
    appId: requireAppConfig(ctx.appConfig, GITHUB_APP_CONFIG.appId),
    privateKeyPem: requireAppConfig(ctx.appConfig, GITHUB_APP_CONFIG.privateKey).replace(
      /\\n/g,
      '\n',
    ),
  };
}

export interface TokenScope {
  /** Repository names without owner ; omit for an installation-wide token. */
  readonly repositories?: readonly string[];
  /** Permission subset ; omit for the App's full granted permissions. */
  readonly permissions?: Readonly<Record<string, string>>;
}

/**
 * Mint an installation token for the connection of `ctx`, scoped as asked.
 * One mint per call : the installation id never expires, the token does.
 */
export async function installationTokenFor(
  ctx: ConnectionContext,
  scope: TokenScope = {},
): Promise<ScopedInstallationToken> {
  const secret = expectCredentialKind('github', ctx.credential, 'app-install');
  const creds = appCredentialsOf(ctx);
  return mintInstallationToken({
    ...creds,
    installationId: secret.installationId,
    ...(scope.repositories ? { repositories: [...scope.repositories] } : {}),
    ...(scope.permissions ? { permissions: { ...scope.permissions } } : {}),
    fetchImpl: ctx.fetch,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
}
