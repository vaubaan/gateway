/**
 * The credential of the `asana` provider : a personal access token, pasted
 * by hand (`api-key`).
 *
 * Handbook : docs/handbook/providers/asana.md ; ADRs
 *            one-place-to-authorize-services-token-first (token first),
 *            plugin-contract-and-credential-spec (label, guide, verify).
 *
 * Asana's documentation, read through Context7 on 2026-11-05 (personal
 * access token, authentication, quick start) : a PAT is created in the
 * developer console ("+ Create new token", shown once), carries "the same
 * authorization … as the user who generated them", has no scopes to choose,
 * is "persistent by default" and is to be treated as opaque ("validating a
 * token's format on the client side could result in unexpected breakages").
 * `verify` asks Asana who the token is (`GET /users/me`).
 */

import {
  CredentialRefusal,
  type ApiKeyCredentialSpec,
  type ConnectionContext,
  type CredentialCheck,
} from '@vaubaan/plugin-sdk';

import { getObject } from './api.ts';
import { workspacesOf } from './discovery.ts';
import { PAT_FIELD } from './identity.ts';

/** The developer console, where personal access tokens are created and deleted. */
export const ASANA_DEVELOPER_CONSOLE = 'https://app.asana.com/0/my-apps';

/** Who a pasted token is : its name (and email), or a refusal. */
export async function verifyAsanaToken(ctx: ConnectionContext): Promise<CredentialCheck> {
  const me = await getObject(ctx, '/users/me', ['name', 'email', 'workspaces.name']);
  if (workspacesOf(me).length === 0) {
    throw new CredentialRefusal(
      'Asana: this account belongs to no workspace, so it reaches no project. Create the token with an account that is a member of the workspace the agents will work in.',
      403,
    );
  }
  const name = typeof me.name === 'string' && me.name !== '' ? me.name : null;
  const email = typeof me.email === 'string' && me.email !== '' ? me.email : null;
  // A personal access token does not expire (Asana: "persistent by default").
  return { account: name && email ? `${name} (${email})` : (name ?? email), expiresAt: null };
}

export const asanaCredential: ApiKeyCredentialSpec = {
  kind: 'api-key',
  label: 'personal access token',
  createUrl: ASANA_DEVELOPER_CONSOLE,
  fields: [
    {
      name: PAT_FIELD,
      label: 'Personal access token',
      secret: true,
      required: true,
      placeholder: 'Asana personal access token',
      // Asana: treat tokens as opaque. Bounded, no whitespace, nothing more.
      pattern: '^\\S{20,512}$',
      help: 'A personal access token of the Asana account the agents will act as.',
    },
  ],
  guide: {
    steps: [
      {
        do: 'Sign in to Asana as the account the agents will act as; everything they do is signed by it.',
      },
      {
        do: 'Open the developer console (profile photo, My Settings, Apps, Manage Developer Apps).',
        url: ASANA_DEVELOPER_CONSOLE,
      },
      { do: 'Choose + Create new token, name it Vaubaan Gateway and create it.' },
      { do: 'Copy the token and paste it here; Asana shows it only once.' },
    ],
    // A PAT has no scopes: it opens what the account opens.
    permissions: [],
    reach: {
      what: 'Projects',
      grant: 'Everything this Asana account can see; a personal access token has no scopes',
      why: 'This gateway gives a mission only the projects and permissions it names, call by call; a project the account cannot see is out of reach of every mission.',
    },
    expiry: {
      kind: 'none',
      reason:
        'Asana personal access tokens do not expire (an Enterprise admin may set rules): delete the token in the developer console to end this account.',
    },
    docsUrl: 'https://developers.asana.com/docs/personal-access-token',
  },
  verify: verifyAsanaToken,
};
