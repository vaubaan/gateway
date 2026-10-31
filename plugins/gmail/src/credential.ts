/**
 * Credential of the `gmail` provider — the mailbox's address and a Google
 * **app password**, with which the plugin signs in over IMAP.
 *
 * Spec : docs/spec/vaubaan-gateway.md §0 "Connection", §5, §7.2.
 * ADR  : docs/decisions/gmail-over-imap-with-an-app-password.md (D1).
 *
 * An app password is 16 letters Google prints in four groups of four ; it
 * opens the whole mailbox over IMAP and carries no scope, so the guide lists
 * no permission and says so, and it does not expire. The host shows the
 * guide, collects the two fields, calls `verify` (an IMAP sign-in, in
 * `execute.ts`) before anything is stored, and keeps the password encrypted.
 */

import {
  expectCredentialKind,
  type ApiKeyCredentialSpec,
  type CredentialSecret,
  type TokenGuide,
} from '@vaubaan/plugin-sdk';

import { parseBareAddress } from './address.ts';

export const GMAIL_PLUGIN_ID = 'gmail';

/** Gmail's IMAP server : implicit TLS on 993 (Google, "IMAP, POP and SMTP"). */
export const GMAIL_IMAP_HOST = 'imap.gmail.com';
export const GMAIL_IMAP_PORT = 993;

/** Where a person creates an app password. */
export const GMAIL_APP_PASSWORDS_URL = 'https://myaccount.google.com/apppasswords';
/** Google's help page on app passwords. */
export const GMAIL_APP_PASSWORDS_HELP_URL = 'https://support.google.com/accounts/answer/185833';

/** The two form fields, keyed by `CredentialField.name`. */
export const GMAIL_FIELDS = { email: 'email', appPassword: 'app_password' } as const;

/** What the host checks before calling the plugin ; `gmailAccount` checks again, strictly. */
const EMAIL_PATTERN = '^\\s*[^\\s@]+@[^\\s@]+\\.[^\\s@]+\\s*$';
/** Sixteen letters, with or without the spaces Google prints between the groups. */
const APP_PASSWORD_PATTERN = '^\\s*(?:[A-Za-z]{4}\\s*){4}$';
const APP_PASSWORD_LENGTH = 16;

export const gmailGuide: TokenGuide = {
  steps: [
    {
      do: 'Sign in to the Google Account of the mailbox and turn on 2-Step Verification under Security, if it is not on yet: Google offers app passwords only then.',
    },
    {
      do: 'Open the App passwords page, create an app password named "Vaubaan Gateway" and copy the 16 letters Google shows; if Google says app passwords are not available, the Google Workspace administrator of the account has turned them off.',
      url: GMAIL_APP_PASSWORDS_URL,
    },
    {
      do: 'Check that IMAP is on in Gmail, under Settings, Forwarding and POP/IMAP.',
    },
    {
      do: 'Paste the address of the mailbox and the app password here; the spaces between the groups of letters do not matter.',
    },
  ],
  permissions: [],
  reach: {
    what: 'App password',
    grant: 'The whole mailbox over IMAP: an app password has no scopes to choose',
    why: 'What an agent may do is decided by the missions of this gateway, call by call.',
  },
  expiry: {
    kind: 'none',
    reason:
      'App passwords do not expire: revoke it on the App passwords page of the Google Account to end this account.',
  },
  docsUrl: GMAIL_APP_PASSWORDS_HELP_URL,
};

/** The spec without `verify`, which `execute.ts` adds with the transport it uses. */
export const gmailCredentialFields: Omit<ApiKeyCredentialSpec, 'verify'> = {
  kind: 'api-key',
  label: 'app password',
  createUrl: GMAIL_APP_PASSWORDS_URL,
  fields: [
    {
      name: GMAIL_FIELDS.email,
      label: 'Gmail address',
      secret: false,
      placeholder: 'name@example.com',
      pattern: EMAIL_PATTERN,
      help: 'The address of the mailbox, a Gmail or Google Workspace account. It becomes the resource an agent works on.',
    },
    {
      name: GMAIL_FIELDS.appPassword,
      label: 'App password',
      secret: true,
      placeholder: 'abcd efgh ijkl mnop',
      pattern: APP_PASSWORD_PATTERN,
      help: 'The 16 letters of the app password, with or without spaces. Stored encrypted; never shown again.',
    },
  ],
  guide: gmailGuide,
};

/** The mailbox's sign-in, narrowed from the decrypted secret. */
export interface GmailAccount {
  /** Lower-cased address : the IMAP user name and the resource ref. */
  readonly email: string;
  /** The 16 letters, spaces removed. */
  readonly appPassword: string;
}

/** The app password without the spaces Google prints, or `null` when it is not 16 letters. */
export function normalizeAppPassword(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const letters = value.replace(/\s+/g, '');
  return letters.length === APP_PASSWORD_LENGTH && /^[A-Za-z]+$/.test(letters) ? letters : null;
}

/**
 * Narrow the secret the host hands the plugin. Throws `CredentialKindMismatch`
 * on another kind (an account connected by OAuth in an earlier build ; the
 * host refuses its calls before they get here) and a plain `Error` when a
 * field is missing or malformed : the host validated the form, so both mean
 * a host bug, not a provider answer.
 */
export function gmailAccount(secret: CredentialSecret): GmailAccount {
  const key = expectCredentialKind(GMAIL_PLUGIN_ID, secret, 'api-key');
  const address = parseBareAddress(key.fields[GMAIL_FIELDS.email]);
  if (address === null) {
    throw new Error("gmail credential: field 'email' is missing or is not one e-mail address");
  }
  const appPassword = normalizeAppPassword(key.fields[GMAIL_FIELDS.appPassword]);
  if (appPassword === null) {
    throw new Error("gmail credential: field 'app_password' is missing or is not 16 letters");
  }
  return { email: address.address, appPassword };
}
