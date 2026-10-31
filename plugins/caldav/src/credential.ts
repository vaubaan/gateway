/**
 * Credential of the `caldav` provider — a server URL, a username and an
 * **app password**, sent with HTTP Basic authentication on every request.
 *
 * Spec     : docs/spec/vaubaan-gateway.md §0 "Connection", §5, §7.2.
 * ADR      : docs/decisions/google-calendar-through-an-oauth-broker.md (D5).
 * Handbook : docs/handbook/providers/caldav.md.
 *
 * An app password carries no scope : it opens the whole account over CalDAV
 * (and, at most providers, CardDAV), so the guide lists no permission and
 * says so ; what an agent may do is decided by the missions. The host shows
 * the guide, collects the three fields, calls `verify` (`execute.ts` : the
 * principal found with an authenticated `PROPFIND`) before anything is
 * stored, and keeps the password encrypted.
 *
 * Google is not reachable here : its CalDAV server refuses Basic
 * authentication, app passwords included. Google Calendar is the
 * `google-calendar` plugin.
 */

import {
  CredentialRefusal,
  expectCredentialKind,
  type ApiKeyCredentialSpec,
  type CredentialSecret,
  type TokenGuide,
} from '@vaubaan/plugin-sdk';

import { isLoopbackHost, type DavAccount } from './dav.ts';
import { CALDAV_FIELDS, CALDAV_PLUGIN_ID } from './identity.ts';

/** Where the handbook explains each server (app password, URL). */
export const CALDAV_HANDBOOK_URL =
  'https://github.com/vaubaan/gateway/blob/main/docs/handbook/providers/caldav.md';

/** Where the handbook says, server by server, where an app password is made. */
export const CALDAV_APP_PASSWORDS_URL = `${CALDAV_HANDBOOK_URL}#outside-the-repo`;

/** The servers the guide names, with the URL to type. */
export const ICLOUD_CALDAV_URL = 'https://caldav.icloud.com';
export const FASTMAIL_CALDAV_URL = 'https://caldav.fastmail.com';
/** The CalDAV path of a Nextcloud, after the cloud's own address. */
export const NEXTCLOUD_CALDAV_PATH = '/remote.php/dav';

/** Where each server makes app passwords (menu paths in the handbook, "Outside the repo"). */
const APPLE_ACCOUNT_URL = 'https://account.apple.com';
const FASTMAIL_SECURITY_URL = 'https://app.fastmail.com/settings/security';

export const caldavGuide: TokenGuide = {
  // One step per server: where its app password is made, and the server URL to type.
  steps: [
    {
      do: 'Open Sign-In and Security, App-Specific Passwords for iCloud, and create one named "Vaubaan Gateway" (two-factor authentication must be on); the server URL is below.',
      url: APPLE_ACCOUNT_URL,
      code: ICLOUD_CALDAV_URL,
    },
    {
      do: 'Open Settings, Privacy & Security, Manage app passwords for Fastmail, and create one named "Vaubaan Gateway" with access to Calendars (CalDAV); the server URL is below.',
      url: FASTMAIL_SECURITY_URL,
      code: FASTMAIL_CALDAV_URL,
    },
    {
      do: 'Open Personal settings, Security, Devices & sessions on your Nextcloud, and create an app password named "Vaubaan Gateway"; use the App login it shows as the username, and your cloud address with the path below.',
      code: NEXTCLOUD_CALDAV_PATH,
    },
    {
      do: 'Type the address of another server as it is when it publishes /.well-known/caldav, or the CalDAV address it documents.',
    },
    {
      do: 'Use the Google Calendar service for a Google calendar: Google refuses app passwords over CalDAV.',
    },
    {
      do: 'Type the server URL and the username (iCloud: the Apple Account e-mail; Fastmail: the full address), and paste the app password, never the account password.',
    },
  ],
  // An app password carries no scope: `reach` says what it opens.
  permissions: [],
  reach: {
    what: 'App password',
    grant: 'The whole calendar account: an app password has no scopes to choose',
    why: 'Each calendar becomes a resource you give to missions one by one, and what an agent may do is decided by its mission.',
  },
  expiry: {
    kind: 'none',
    reason: 'App passwords do not expire: revoke it where you created it to end this account.',
  },
  docsUrl: CALDAV_APP_PASSWORDS_URL,
};

/** What the host checks before calling the plugin ; `caldavAccount` checks again, strictly. */
const SERVER_URL_PATTERN = '^\\s*https?://\\S+\\s*$';
const USERNAME_PATTERN = '^[^:\\s][^:]{0,253}$';

/** The spec without `verify`, which `execute.ts` adds. */
export const caldavCredentialFields: Omit<ApiKeyCredentialSpec, 'verify'> = {
  kind: 'api-key',
  label: 'app password',
  // No single provider page : the handbook's section names it for each server.
  createUrl: CALDAV_APP_PASSWORDS_URL,
  fields: [
    {
      name: CALDAV_FIELDS.serverUrl,
      label: 'Server URL',
      secret: false,
      placeholder: ICLOUD_CALDAV_URL,
      pattern: SERVER_URL_PATTERN,
      help: 'iCloud: https://caldav.icloud.com. Fastmail: https://caldav.fastmail.com. Nextcloud: https://<your cloud>/remote.php/dav. https only.',
    },
    {
      name: CALDAV_FIELDS.username,
      label: 'Username',
      secret: false,
      placeholder: 'name@example.com',
      pattern: USERNAME_PATTERN,
      help: 'The sign-in name of the calendar account, often its e-mail address.',
    },
    {
      name: CALDAV_FIELDS.appPassword,
      label: 'App password',
      secret: true,
      placeholder: 'abcd-efgh-ijkl-mnop',
      help: 'An app password made for this gateway, not the account password. Stored encrypted; never shown again.',
    },
  ],
  guide: caldavGuide,
};

/** Hosts of Google's calendar servers, which refuse Basic authentication. */
const GOOGLE_HOSTS = ['google.com', 'googleapis.com', 'googleusercontent.com'];

const isGoogleHost = (host: string): boolean =>
  GOOGLE_HOSTS.some((g) => host === g || host.endsWith(`.${g}`));

export const GOOGLE_REFUSAL =
  'Google refuses app passwords over CalDAV (it accepts OAuth only): connect Google Calendar with the Google Calendar service instead.';

/**
 * The server URL the person typed, normalised (no query, no fragment, a
 * trailing `/`), or the sentence that refuses it. `https` only ; `http` for a
 * loopback host (a server on the same machine).
 */
export function normalizeServerUrl(value: unknown): URL | string {
  if (typeof value !== 'string' || value.trim().length === 0) return 'the server URL is missing.';
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return 'the server URL is not a URL.';
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
    return 'the server URL must start with https:// (the app password would travel in clear).';
  }
  if (url.username !== '' || url.password !== '') {
    return 'the server URL must not carry a user name or a password: use the fields.';
  }
  if (isGoogleHost(url.hostname.toLowerCase())) return GOOGLE_REFUSAL;
  url.search = '';
  url.hash = '';
  if (!url.pathname.endsWith('/')) url.pathname = `${url.pathname}/`;
  return url;
}

/** A control character, or a `:` (RFC 7617 : the user-id of Basic authentication has none). */
// eslint-disable-next-line no-control-regex
const BAD_USERNAME = /[\u0000-\u001f\u007f:]/;
// eslint-disable-next-line no-control-regex
const BAD_PASSWORD = /[\u0000-\u001f\u007f]/;

/**
 * Narrow the secret the host hands the plugin. `CredentialKindMismatch` on
 * another kind ; `CredentialRefusal` — a sentence the person reads at connect
 * time — when a field is unusable (the host checked the patterns, the plugin
 * checks what they cannot say : the scheme, Google, a `:` in the username).
 */
export function caldavAccount(secret: CredentialSecret): DavAccount {
  const key = expectCredentialKind(CALDAV_PLUGIN_ID, secret, 'api-key');
  const server = normalizeServerUrl(key.fields[CALDAV_FIELDS.serverUrl]);
  if (typeof server === 'string') throw new CredentialRefusal(server);
  const username = (key.fields[CALDAV_FIELDS.username] ?? '').trim();
  if (username.length === 0 || username.length > 254 || BAD_USERNAME.test(username)) {
    throw new CredentialRefusal('the username is missing, too long, or holds a ":".');
  }
  const password = (key.fields[CALDAV_FIELDS.appPassword] ?? '').trim();
  if (password.length === 0 || password.length > 512 || BAD_PASSWORD.test(password)) {
    throw new CredentialRefusal(
      'the app password is missing, too long, or holds a control character.',
    );
  }
  return { server, username, password };
}
