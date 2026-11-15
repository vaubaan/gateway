/**
 * The credential of the `notion` service : an internal account token,
 * pasted by hand (`api-key`).
 *
 * Handbook : docs/handbook/services/notion.md ; ADRs
 *            one-place-to-authorize-services-token-first (token first),
 *            plugin-contract-and-credential-spec (label, guide, verify).
 *
 * Notion has three kinds of token. Only an internal account's matches
 * the resource model ("what was shared with the account") : a personal
 * access token acts as the person who created it, with everything that
 * person can open, and a public account is OAuth. `verify` asks Notion who
 * the token is (`GET /v1/users/me`) and refuses anything but a bot owned by
 * the workspace.
 */

import {
  CredentialRefusal,
  anyJson,
  isRecord,
  type ApiKeyCredentialSpec,
  type AccountContext,
  type CredentialCheck,
} from '@vaubaan/plugin-sdk';

import { request } from './api.ts';
import { API_TOKEN_FIELD, TOOL } from './identity.ts';

/** Where a Workspace Owner creates an internal account. */
export const NOTION_ACCOUNTS_PAGE = 'https://app.notion.com/developers/accounts';

/** Who a pasted token is : the workspace of an internal account, or a refusal. */
export async function verifyNotionToken(ctx: AccountContext): Promise<CredentialCheck> {
  // Read leniently: an answer that is not a workspace's bot is a refused token.
  const me = await request(ctx, 'GET', '/users/me', anyJson);
  const bot = isRecord(me) && me.type === 'bot' && isRecord(me.bot) ? me.bot : null;
  const owner = bot && isRecord(bot.owner) ? bot.owner : null;
  if (!bot || !owner || owner.type !== 'workspace') {
    throw new CredentialRefusal(
      'Notion: this is not an internal account token. Paste the token of an internal account (Developer portal, Build, Internal accounts), not a personal access token.',
      401,
    );
  }
  const name =
    typeof bot.workspace_name === 'string' && bot.workspace_name.length > 0
      ? bot.workspace_name
      : typeof bot.workspace_id === 'string'
        ? bot.workspace_id
        : null;
  // No expiry is documented for an internal account's token.
  return { account: name, expiresAt: null };
}

export const notionCredential: ApiKeyCredentialSpec = {
  kind: 'api-key',
  label: 'internal account token',
  createUrl: NOTION_ACCOUNTS_PAGE,
  fields: [
    {
      name: API_TOKEN_FIELD,
      label: 'Internal account token',
      secret: true,
      required: true,
      placeholder: 'ntn_…',
      // Notion advises against validating its tokens with a pattern: bounded, no whitespace, nothing more.
      pattern: '^\\S{20,512}$',
      help: 'The token of an internal account with every capability above, shared with every top-level page the agents may work in.',
    },
  ],
  guide: {
    // The pages are shared before the paste, so the first discovery finds them.
    steps: [
      {
        do: "Open Notion's Developer portal and create an account in the workspace you want to connect (you must be a Workspace Owner); the internal account is the token, there is no app to install.",
        path: ['Build', 'Internal accounts', 'Create a new account'],
        url: NOTION_ACCOUNTS_PAGE,
      },
      {
        do: 'Tick every capability listed below, and choose No user information.',
        path: ['Configuration'],
      },
      {
        do: 'Share every top-level page and database the agents may ever work in; sharing a page includes everything under it.',
        path: ['Content access', 'Edit access'],
      },
      {
        do: 'Share a page from Notion itself instead, if you prefer: open the page and add the account there.',
        path: ['•••', 'Accounts', 'Add account'],
      },
      { do: 'Copy the token and paste it here.', path: ['Configuration'] },
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
      why: 'This gateway gives an agent only the pages and capabilities its mission names; a page not shared with the account is out of reach of every mission until you share it and refresh the account.',
    },
    expiry: {
      kind: 'none',
      reason:
        'Notion gives internal account tokens no expiry: delete the account in the Developer portal to end this account.',
    },
    docsUrl: 'https://developers.notion.com/guides/get-started/internal-accounts',
  },
  verify: verifyNotionToken,
};
