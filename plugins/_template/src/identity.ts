/**
 * Identity of the `template` provider — the one place its ids are written.
 *
 * A copy of this template changes `PROVIDER_ID` here and `provider:` in
 * `risk-catalog.yaml` (the loader refuses a catalog of another provider, and
 * `definePlugin` a catalog whose provider differs from the plugin id).
 * Everything else — the plugin id, the data-model provider, the tool names,
 * the resources `discoverResources` returns, the credential field — is
 * derived from this module, so a classifier can never emit slices under one
 * provider while the executor filters resources under another.
 */

import { toolPrefixFor } from '@vaubaan/plugin-sdk';

/** The provider id : a lowercase slug (`cloudflare-dns`). */
export const PROVIDER_ID = 'template';

/** Name of the secret field of the `api-key` credential, declared in `index.ts` and read in `execute.ts`. */
export const API_KEY_FIELD = 'api_key';

const prefix = toolPrefixFor(PROVIDER_ID);

/** The MCP tool names, `<prefix><verb>_<noun>`. Declared in `tools.ts`, dispatched in `classify.ts` and `execute.ts`. */
export const TOOL = {
  listWidgets: `${prefix}list_widgets`,
  getWidget: `${prefix}get_widget`,
  updateWidget: `${prefix}update_widget`,
} as const;
