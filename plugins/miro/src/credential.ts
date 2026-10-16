/**
 * How a Miro connection is made : the access token of a Miro app, pasted by
 * hand (`api-key`). No company app in v0.1.
 *
 * Handbook : docs/handbook/providers/miro.md §6.1.
 * ADR      : docs/decisions/token-connections-beside-the-integration-app.md (label,
 *            guide, verify) ; docs/decisions/company-apps-kept-where-they-add-something.md.
 *
 * Only a non-expiring token works : an expiring one lives one hour, and its
 * refresh needs the app's client secret, which this connection never holds.
 * The guide and the field's help say to leave "Expire user authorization
 * token" unchecked.
 */

import {
  UpstreamAuthError,
  type ApiKeyCredentialSpec,
  type ConnectionContext,
  type CredentialCheck,
} from '@vaubaan/plugin-sdk';

import { readTokenContext } from './execute.ts';
import { ACCESS_TOKEN_FIELD, PROVIDER_ID, TOOL } from './identity.ts';

/** The two scopes the app needs, and nothing else. */
export const REQUIRED_SCOPES = ['boards:read', 'boards:write'] as const;

/** Where a person creates a Miro app ⚠ (exact URL to confirm on a real account). */
export const MIRO_APPS_PAGE = 'https://miro.com/app/settings/user-profile/apps';

const READ_TOOLS: readonly string[] = [
  TOOL.listBoards,
  TOOL.getBoard,
  TOOL.listItems,
  TOOL.getItem,
  TOOL.listConnectors,
  TOOL.getConnector,
  TOOL.listTags,
  TOOL.listItemTags,
];

const WRITE_TOOLS = Object.values(TOOL).filter((tool) => !READ_TOOLS.includes(tool));

/** Asks Miro about the pasted token : whose team it reaches, and whether it holds both scopes. */
export async function verifyMiroToken(ctx: ConnectionContext): Promise<CredentialCheck> {
  const context = await readTokenContext(ctx);
  const missing = REQUIRED_SCOPES.filter((scope) => !context.scopes.includes(scope));
  if (missing.length > 0) {
    throw new UpstreamAuthError(
      `${PROVIDER_ID}: the token lacks the scope(s) ${missing.join(', ')}; give the app boards:read and boards:write and install it again`,
      403,
    );
  }
  return { account: `${context.team.name} (Miro team)`, expiresAt: null };
}

export const miroCredential: ApiKeyCredentialSpec = {
  kind: 'api-key',
  label: 'access token of a Miro app',
  createUrl: MIRO_APPS_PAGE,
  fields: [
    {
      name: ACCESS_TOKEN_FIELD,
      label: 'Access token',
      secret: true,
      required: true,
      placeholder: 'Miro access token',
      // Miro documents no token format : loose on purpose, `verify` is the real check.
      pattern: '^[A-Za-z0-9._~+/=-]{20,512}$',
      help: "Create a Miro app with only boards:read and boards:write, leave 'Expire user authorization token' unchecked, and install it on the team whose boards the agents may work on. boards:write also lets the token delete boards and manage board members; the gateway limits what agents do with it, not the token itself.",
    },
  ],
  guide: {
    steps: [
      'In Miro, open your avatar, Settings, Your apps, and create a new app (Miro asks for a Developer team).',
      "Leave 'Expire user authorization token' unchecked: an expiring token stops working after one hour, and the choice cannot be changed once the app exists.",
      'Give the app the scopes boards:read and boards:write, and no other.',
      'Choose Install app and get OAuth token, pick the team that holds the boards, authorise, and copy the access token here.',
    ],
    permissions: [
      { name: 'boards:read', access: 'read', tools: READ_TOOLS },
      { name: 'boards:write', access: 'read-write', tools: WRITE_TOOLS },
    ],
    recommendedExpiryDays: null,
    docsUrl: 'https://developers.miro.com/docs/rest-api-build-your-first-hello-world-app',
  },
  manualRevocation:
    'In Miro, open Settings, Your apps, and delete the app or uninstall it from the team; its token stops working.',
  verify: verifyMiroToken,
};
