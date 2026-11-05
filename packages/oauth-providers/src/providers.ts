/**
 * The OAuth providers a broker serves: endpoints, allowed scopes, consent
 * parameters (spec oauth-broker §4). Never read from configuration: the client
 * secret is sent to `tokenEndpoint` and `revokeEndpoint`, so whoever could
 * change them could capture it. The gateway reads the same table to refuse,
 * at boot, a brokered plugin whose provider or scopes it does not list.
 *
 * Source: `packages/oauth-providers/src/providers.ts`. The broker runs a
 * byte-identical copy, `apps/oauth-broker/src/providers.ts`, so that its image
 * builds from its own folder with no dependency (ADR
 * oauth-broker-runs-its-typescript-source-with-no-dependency); a broker test
 * fails when the two differ. Erasable syntax only, and no import.
 * Adding a provider, or a scope, is a change to the source and its copy: a new
 * broker image, a new measurement and a gateway release that admits it.
 */
export interface ProviderDefinition {
  readonly id: string;
  readonly authorizeEndpoint: string;
  readonly tokenEndpoint: string;
  /**
   * RFC 7009 revocation of one refresh token. Absent when the provider has
   * none (Microsoft): `/revoke` then calls nothing at the provider, and the
   * gateway's erasure of its sealed copy is the whole revocation.
   */
  readonly revokeEndpoint?: string;
  /** The only scopes a flow may ask for. */
  readonly allowedScopes: ReadonlySet<string>;
  /** Added to every consent URL. */
  readonly authorizeParams: Readonly<Record<string, string>>;
}

export type ProviderTable = ReadonlyMap<string, ProviderDefinition>;

/**
 * Google: OAuth 2.0 for Web Server Applications. Offline access so the code
 * exchange answers a refresh token, and consent each time so it always does.
 * Scopes: the two the google-calendar plugin asks for (ADR
 * google-calendar-through-an-oauth-broker), both sensitive, none restricted;
 * `openid` and `email` so the answer can name the account.
 */
export const GOOGLE: ProviderDefinition = {
  id: 'google',
  authorizeEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  revokeEndpoint: 'https://oauth2.googleapis.com/revoke',
  allowedScopes: new Set([
    'openid',
    'email',
    'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
    'https://www.googleapis.com/auth/calendar.events',
  ]),
  authorizeParams: { access_type: 'offline', prompt: 'consent' },
};

/**
 * Microsoft identity platform v2.0, `common` tenant: work or school accounts
 * of any Entra tenant and personal Microsoft accounts ("Get access on behalf
 * of a user", Microsoft Graph docs, read 2026-11-05). `offline_access` is the
 * scope that makes the code exchange answer a refresh token; `response_mode`
 * `query` brings the code back as a query parameter of the redirect.
 * Scopes: the delegated Graph permissions the outlook plugin asks for (ADR
 * outlook-through-the-oauth-broker-microsoft-provider), plus `openid`,
 * `email` and `profile` so the ID token can name the account. Microsoft
 * offers no endpoint that revokes one refresh token: no `revokeEndpoint`.
 */
export const MICROSOFT: ProviderDefinition = {
  id: 'microsoft',
  authorizeEndpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
  tokenEndpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
  allowedScopes: new Set([
    'openid',
    'email',
    'profile',
    'offline_access',
    'User.Read',
    'Mail.ReadWrite',
    'Mail.Send',
    'Calendars.ReadWrite',
  ]),
  authorizeParams: { response_mode: 'query' },
};

export const PROVIDERS: ProviderTable = new Map([
  [GOOGLE.id, GOOGLE],
  [MICROSOFT.id, MICROSOFT],
]);
