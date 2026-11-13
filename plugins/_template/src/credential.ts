/**
 * The credential of the `template` provider : an API key pasted by hand
 * (`api-key`), the one way of connecting.
 *
 * ADR : one-place-to-authorize-services-token-first (amended 2026-10-31 : the
 *       person grants wide at the service, each mission narrows ; the guide
 *       and the check at paste are part of the plugin contract).
 *
 * Write it from the provider's documentation, read through Context7 (name
 * the pages and the date here) : the exact page where the key is made, the
 * permission names as that page shows them, how the key expires, and the
 * "who am I" endpoint `verify` asks. `definePlugin` refuses an `api-key` way
 * without `label`, `createUrl`, `guide` or `verify`.
 */

import {
  isRecord,
  type ApiKeyCredentialSpec,
  type ConnectionContext,
  type CredentialCheck,
  type TokenPermission,
} from '@vaubaan/plugin-sdk';

import { request } from './execute.ts';
import { API_KEY_FIELD, TOOL } from './identity.ts';

/** The page where a person creates and deletes keys: the page itself, not the dashboard. */
export const TEMPLATE_KEYS_PAGE = 'https://example.com/settings/api-keys';

/**
 * The permissions of a key, as the provider's page names them, each with the
 * tools it serves. Every tool is served by one (`definePlugin` checks), and
 * the connect page lists them with the tool titles. A provider whose keys
 * carry no permission choice lists none, and `reach` says what a key opens.
 */
export const TEMPLATE_KEY_PERMISSIONS: readonly TokenPermission[] = [
  { name: 'Widgets', access: 'read', tools: [TOOL.listWidgets, TOOL.getWidget] },
  { name: 'Widgets', access: 'read-write', tools: [TOOL.updateWidget, TOOL.deleteWidget] },
];

export const templateCredential: ApiKeyCredentialSpec = {
  kind: 'api-key',
  // What the person creates, in the provider's words, lower case.
  label: 'API key',
  createUrl: TEMPLATE_KEYS_PAGE,
  fields: [
    {
      name: API_KEY_FIELD,
      label: 'API key',
      secret: true,
      required: true,
      placeholder: 'Template API key',
      // Checked by the host before any call : a value that cannot be a key
      // of this provider is refused at the form.
      pattern: '^[A-Za-z0-9_-]{8,}$',
      help: 'A key over every workspace, never your password.',
    },
  ],
  guide: {
    // One sentence per thing to do, in order, ending with the paste. The menus
    // to follow go in `path`, in the service's own labels (the page draws them
    // as highlighted chips; the sentence never repeats them), a page in `url`,
    // a command to type in `code`. One screenshot of the hard screen may go in
    // `screenshot`, its file in `docs/connect/` and its provenance declared in
    // `screenshots` below (source, licence, month taken, alt).
    steps: [
      { do: 'Sign in to the template service as the account the agents will act as.' },
      {
        do: 'Open the page and start a new key.',
        path: ['Settings', 'API keys', 'New key'],
        url: TEMPLATE_KEYS_PAGE,
      },
      {
        do: 'Choose All workspaces and tick every permission below.',
        path: ['Workspaces', 'All workspaces'],
      },
      { do: 'Create the key, copy it, and paste it here. The service shows it once.' },
    ],
    // Grant wide, once: the person never comes back for a missing workspace
    // or permission, because each mission narrows what an agent may do.
    reach: {
      what: 'Workspaces',
      grant: 'All workspaces, with every permission below',
      why: 'This gateway gives a mission only the workspaces and permissions it names; a key that lacks one means a new key.',
    },
    permissions: TEMPLATE_KEY_PERMISSIONS,
    // `provider-reports` when `verify` reads the expiry from the provider,
    // `person-types` when the person picks it there and the provider never
    // says it back, `none` (with how to end the key) when keys do not expire.
    expiry: { kind: 'person-types', recommendedDays: 90 },
    docsUrl: 'https://example.com/docs/api-keys',
    // A screenshot of the hard screen, when a sentence is not enough:
    //   screenshots: {
    //     'new-key.webp': {
    //       source: 'https://example.com/docs/api-keys', // or 'ours'
    //       licence: 'CC-BY-4.0', // CC-BY-4.0 | MIT | Apache-2.0 | ours
    //       taken: '2026-11',
    //       alt: 'The new key form with its workspace and permission choices',
    //     },
    //   },
    // and `screenshot: 'new-key.webp'` on the step it illustrates.
  },
  verify: verifyTemplateKey,
};

/**
 * Who the key acts as (`GET /me`), asked before anything is stored. A cause
 * the plugin can name throws `CredentialRefusal` with its own sentence ; a
 * rejected key is the `UpstreamAuthError` `request` throws.
 */
export async function verifyTemplateKey(ctx: ConnectionContext): Promise<CredentialCheck> {
  const me = await request(ctx, 'GET', '/me', isRecord);
  return { account: typeof me.name === 'string' ? me.name : null, expiresAt: null };
}
