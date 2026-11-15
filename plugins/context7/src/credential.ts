/**
 * Credential of the `context7` service : a Context7 API key pasted by hand.
 *
 * Spec     : docs/spec/vaubaan-gateway.md §0 "Account", §7.2.
 * Handbook : docs/handbook/services/context7.md.
 *
 * The key is kept by the gateway as an account, encrypted ; it is never in
 * an environment variable or in an MCP client's configuration. It is sent
 * as `Authorization: Bearer <key>`, the documented form, to the MCP server
 * and to the REST API alike.
 *
 * A key belongs to a teamspace and reaches what the teamspace's policies
 * allow ; it carries no permission choice and no documented expiry. Usage is
 * counted on the member who created it. No revocation endpoint is
 * documented : removing an account says where to revoke the key.
 */

import type { ApiKeyCredentialSpec, AccountContext, CredentialCheck } from '@vaubaan/plugin-sdk';

import { API_KEY_FIELD } from './identity.ts';
import { readPlan } from './usage.ts';

/** Where a person creates and revokes keys (the API Keys card). */
export const CONTEXT7_DASHBOARD = 'https://context7.com/dashboard';

export const CONTEXT7_MANUAL_REVOCATION =
  'Revoke the key in the Context7 dashboard, API Keys. Revocation is immediate and permanent.';

/**
 * The key, asked about before anything is stored : `GET /v2/usage` answers
 * the plan of its teamspace, and is not counted on the quota.
 */
export async function verifyContext7Key(ctx: AccountContext): Promise<CredentialCheck> {
  const plan = await readPlan(ctx);
  return { account: `Context7 ${plan} plan`, expiresAt: null };
}

export const context7CredentialSpec: ApiKeyCredentialSpec = {
  kind: 'api-key',
  label: 'API key',
  createUrl: CONTEXT7_DASHBOARD,
  fields: [
    {
      name: API_KEY_FIELD,
      label: 'API key',
      secret: true,
      required: true,
      placeholder: 'ctx7sk-…',
      // The documented format is `ctx7sk-` and a secret ; the character set
      // after the prefix is not documented (decision D6 of the handbook).
      pattern: '^ctx7sk-[A-Za-z0-9_-]{16,128}$',
      help: "Create a key in the Context7 dashboard, API Keys. A key reaches what its teamspace's policies allow; the key itself has no permission choice. The questions agents ask are counted on the plan of the person who created it.",
    },
  ],
  guide: {
    steps: [
      { do: 'Sign in to Context7 and open the dashboard.', url: CONTEXT7_DASHBOARD },
      {
        do: 'Create an API key; Context7 shows the key once.',
        path: ['API Keys', 'Create API Key'],
      },
      { do: 'Copy the key and paste it here.' },
    ],
    permissions: [],
    reach: {
      what: 'API key',
      grant:
        "A key of the teamspace: Context7 offers no permission choice, it reaches what the teamspace's policies allow",
      why: 'This gateway decides, mission by mission, which agent may ask what.',
    },
    expiry: {
      kind: 'none',
      reason:
        'Context7 API keys do not expire: delete the key in the dashboard to end this account.',
    },
    docsUrl: 'https://context7.com/docs/howto/api-keys',
  },
  verify: verifyContext7Key,
};
