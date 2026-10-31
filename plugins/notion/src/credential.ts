/**
 * The credential of the `notion` provider : an internal connection token,
 * pasted by hand (`api-key`).
 *
 * Handbook : docs/handbook/providers/notion.md ; ADRs
 *            one-place-to-authorize-services-token-first (token first),
 *            plugin-contract-and-credential-spec (label, guide, verify).
 *
 * Notion has three kinds of token. Only an internal connection's matches
 * the resource model ("what was shared with the connection") : a personal
 * access token acts as the person who created it, with everything that
 * person can open, and a public connection is OAuth. `verify` asks Notion who
 * the token is (`GET /v1/users/me`) and refuses anything but a bot owned by
 * the workspace.
 */

import {
  CredentialRefusal,
  type ApiKeyCredentialSpec,
  type ConnectionContext,
  type CredentialCheck,
} from '@vaubaan/plugin-sdk';

import { request } from './api.ts';
import { API_TOKEN_FIELD, TOOL } from './identity.ts';
import { isObject } from './json.ts';

/** Where a Workspace Owner creates an internal connection. */
export const NOTION_CONNECTIONS_PAGE = 'https://app.notion.com/developers/connections';

/** Who a pasted token is : the workspace of an internal connection, or a refusal. */
export async function verifyNotionToken(ctx: ConnectionContext): Promise<CredentialCheck> {
  const me = await request(ctx, 'GET', '/users/me');
  const bot = isObject(me) && me.type === 'bot' && isObject(me.bot) ? me.bot : null;
  const owner = bot && isObject(bot.owner) ? bot.owner : null;
  if (!bot || !owner || owner.type !== 'workspace') {
    throw new CredentialRefusal(
      'Notion: this is not an internal connection token. Paste the token of an internal connection (Developer portal, Build, Internal connections), not a personal access token.',
      401,
    );
  }
  const name =
    typeof bot.workspace_name === 'string' && bot.workspace_name.length > 0
      ? bot.workspace_name
      : typeof bot.workspace_id === 'string'
        ? bot.workspace_id
        : null;
  // No expiry is documented for an internal connection's token.
  return { account: name, expiresAt: null };
}

export const notionCredential: ApiKeyCredentialSpec = {
  kind: 'api-key',
  label: 'internal connection token',
  createUrl: NOTION_CONNECTIONS_PAGE,
  fields: [
    {
      name: API_TOKEN_FIELD,
      label: 'Internal connection token',
      secret: true,
      required: true,
      placeholder: 'ntn_…',
      // Notion advises against validating its tokens with a pattern: bounded, no whitespace, nothing more.
      pattern: '^\\S{20,512}$',
      help: 'The token of an internal connection with every capability above, shared with every top-level page the agents may work in.',
    },
  ],
  guide: {
    steps: [
      {
        do: "Open Notion's Developer portal, go to Build, Internal connections and create a connection in the workspace you want to connect (you must be a Workspace Owner).",
      },
      {
        do: 'On the Configuration tab, tick the capabilities listed below and choose No user information.',
      },
      { do: 'Copy the token from the Configuration tab and paste it here.' },
      {
        do: 'Give the connection access only to the pages and databases the agents need: on each top-level page, open the ••• menu, Connections, Add connection, or use the Content access tab. Sharing a page includes everything under it.',
      },
    ],
    permissions: [
      {
        name: 'Read content',
        access: 'read',
        tools: [
          TOOL.listRoots,
          TOOL.searchContent,
          TOOL.getPage,
          TOOL.listBlockChildren,
          TOOL.getDatabase,
          TOOL.getDataSource,
          TOOL.queryDataSource,
        ],
      },
      {
        name: 'Insert content',
        access: 'read-write',
        tools: [TOOL.createPage, TOOL.appendBlocks, TOOL.createEntry],
      },
      {
        name: 'Update content',
        access: 'read-write',
        tools: [
          TOOL.updatePage,
          TOOL.updateBlock,
          TOOL.deleteBlock,
          TOOL.trashPage,
          TOOL.restorePage,
          TOOL.updateEntry,
        ],
      },
      { name: 'Read comments', access: 'read', tools: [TOOL.listComments] },
      { name: 'Insert comments', access: 'read-write', tools: [TOOL.createComment] },
    ],
    reach: {
      what: 'Capabilities and shared pages',
      grant: 'Every capability below, and every top-level page the agents may ever work in',
      why: 'This gateway gives an agent only the pages and capabilities its mission names; a page not shared with the connection is out of reach of every mission until you share it and refresh the account.',
    },
    expiry: {
      kind: 'none',
      reason:
        'Notion gives internal connection tokens no expiry: delete the connection in the Developer portal to end this account.',
    },
    docsUrl: 'https://developers.notion.com/guides/get-started/internal-connections',
  },
  verify: verifyNotionToken,
};
