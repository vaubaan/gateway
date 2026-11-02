/**
 * The providers this broker serves, compiled into the image. Never read from
 * configuration: the client secret is sent to `tokenEndpoint` and
 * `revokeEndpoint`, so whoever could change them could capture it (spec
 * oauth-broker §4). Adding a provider, or a scope, is a change to this file,
 * hence a new image, a new measurement and a gateway release that admits it.
 */
export interface ProviderDefinition {
  readonly id: string;
  readonly authorizeEndpoint: string;
  readonly tokenEndpoint: string;
  readonly revokeEndpoint: string;
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

export const PROVIDERS: ProviderTable = new Map([[GOOGLE.id, GOOGLE]]);
