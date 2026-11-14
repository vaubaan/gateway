/**
 * Credential of the `axonaut` provider : the API key of an Axonaut user,
 * pasted by hand (`api-key`), the one way of connecting.
 *
 * ADR : one-place-to-authorize-services-token-first (amended 2026-10-31 : the
 *       person grants wide at the service, each mission narrows).
 *
 * Sources, read 2026-11-05: Axonaut's OpenAPI description of its API v2
 * (https://axonaut.com/api/v2/doc.json; the Swagger page
 * https://axonaut.com/api/v2/doc renders it) declares one security scheme,
 * `userApiKey`, an API key in a header of that name, and `GET /api/v2/me`,
 * which answers the user the key belongs to and its account. The file says
 * nothing of where the key is shown, of scopes or of expiry; Context7 holds no
 * page on it. Where the key is shown (Settings, API, show the key) is what two
 * independent integration guides say; no official page of Axonaut was found,
 * and the address of that settings page is not known: `createUrl` is Axonaut's
 * sign-in page and the steps name the menu path.
 *
 * The key carries no permission choice: it acts as its user, with that user's
 * rights in Axonaut, on the whole account.
 */

import {
  CredentialRefusal,
  type ApiKeyCredentialSpec,
  type AccountContext,
  type CredentialCheck,
} from '@vaubaan/plugin-sdk';

import { readMe } from './execute.ts';
import { API_KEY_FIELD } from './identity.ts';

/** Axonaut's sign-in page: the settings page that shows the key is behind it (its address is unknown). */
export const AXONAUT_SIGN_IN_PAGE = 'https://axonaut.com/en/login';

/** Axonaut's API documentation: a Swagger page over its OpenAPI file. */
export const AXONAUT_API_DOCS = 'https://axonaut.com/api/v2/doc';

export const axonautCredential: ApiKeyCredentialSpec = {
  kind: 'api-key',
  label: 'API key',
  createUrl: AXONAUT_SIGN_IN_PAGE,
  fields: [
    {
      name: API_KEY_FIELD,
      label: 'API key',
      secret: true,
      required: true,
      placeholder: 'Axonaut API key',
      // Printable characters, no space: the key is sent as one header value.
      pattern: '^[!-~]{8,256}$',
      help: 'The API key of the Axonaut user the agents act as, never a password.',
    },
  ],
  guide: {
    steps: [
      {
        do: 'Sign in to Axonaut as the user the agents will act as: ideally a user of its own, whose role in Axonaut matches what agents may do.',
        url: AXONAUT_SIGN_IN_PAGE,
      },
      { do: 'Open the API settings.', path: ['Settings (Paramètres)', 'API'] },
      { do: 'Reveal the API key and copy it.', path: ['Afficher la clé API'] },
      { do: 'Paste the key here.' },
    ],
    reach: {
      what: 'Account',
      grant: 'The whole Axonaut account, as this user, with every right of the user in Axonaut',
      why: 'An Axonaut key has no scope to choose; this gateway gives a mission only the permissions it names, call by call, and a mission reaches only this account.',
    },
    // An Axonaut key carries no permission choice: it opens what its user may do.
    permissions: [],
    expiry: {
      kind: 'none',
      reason:
        'Axonaut documents no expiry for API keys: regenerate the key in Settings, API, to end this account.',
    },
    docsUrl: AXONAUT_API_DOCS,
  },
  verify: verifyAxonautKey,
};

/**
 * Who the key acts as (`GET /me`), asked before anything is stored:
 * `Claire Rousseau · Acme SAS`. A key that opens no account is refused in the
 * plugin's words; a rejected key is the `UpstreamAuthError` the transport throws.
 */
export async function verifyAxonautKey(ctx: AccountContext): Promise<CredentialCheck> {
  const me = await readMe(ctx);
  if (me.account === null) {
    throw new CredentialRefusal('This Axonaut key opens no company account.');
  }
  const who = me.fullname ?? me.email ?? 'Axonaut user';
  const where = me.account.companyName || `account ${me.account.id}`;
  return { account: `${who} · ${where}`, expiresAt: null };
}
